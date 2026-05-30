# Cmd+Click Object Details — Design Spec

**Date:** 2026-05-30
**Status:** Approved
**Branch:** TBD

## Problem

To inspect a table while writing a query, you currently have to leave the editor,
find the table in the sidebar tree, and click it. There is no way to jump from an
identifier in the SQL text to its details. We want IDE-style navigation:
**Cmd+click (Ctrl+click on Linux/Windows) an identifier in the editor to open a
details tab for it.**

Two targets:

- **Table** → open the existing `TableDetailsTab` (already production-ready, wired
  end-to-end via `get_table_details`).
- **Schema** → open a **new** schema-details tab listing the schema's objects:
  tables, views, materialized views, functions, sequences. No such view exists
  today, and no backend introspection beyond tables exists today.

## Decisions (locked)

1. **Scope = tables + a new schema view that lists objects.** All in one spec
   (cmd+click navigation + schema-details tab + the backend introspection that
   feeds it).
2. **Editor cmd+click resolves schemas and tables only** — the explicit ask.
   Views / materialized views / functions / sequences are *displayed* in the
   schema tab but are **not** cmd+clickable in the editor in v1 (YAGNI; they
   often are not present as bare identifiers in query text anyway).
3. **One introspection method, one capability flag.** A new
   `schema_details(conn, schema) -> SchemaDetails` on `DatabaseDriver`, gated by a
   single new `schema_details: bool` capability. Per-object-kind rendering is a
   **frontend-only** descriptor concern, *not* a backend capability flag — this
   keeps the capability↔method mapping 1:1 and honest (see Architecture
   Compliance).
4. **Hover affordance + mouse handler** for the click gesture (not Monaco's
   built-in DefinitionProvider, which is built to navigate within a document, not
   open a custom tab).

## Architecture Compliance (checked against `AGENTS.md`)

- **Decoupling.** New introspection is reached only through the `DatabaseDriver`
  port; dispatch stays `Driver::parse` → registry → `Arc<dyn DatabaseDriver>`.
  No new engine branching anywhere else.
- **Layering.** `get_schema_details` command body is 1–3 lines → calls
  `application::introspection::schema_details` → which dispatches to the driver.
  `SchemaDetails` and the trait method live in `domain`. All engine SQL lives in
  `infrastructure/database/<engine>/`. No SQL in `commands/`.
- **Capabilities honesty (the rule we nearly broke).** Every `false` capability
  flag MUST make the matching method return `DriverError::Unsupported`. Therefore
  we add exactly **one** flag (`schema_details`) for the **one** new method. We do
  **not** add `views`/`functions`/`sequences` capability flags — they have no
  matching method and would be dishonest. Which object **sections** render is
  decided by a frontend-only `ConnectorDescriptor` field (`schemaObjectKinds`),
  alongside existing non-capability descriptor config like `monacoLanguage` and
  `defaultPort`.
- **No silent no-op.** Postgres and SQLite both *support* `schema_details`
  (`schema_details: true`). An engine populating an empty vec for an object kind it
  genuinely lacks (SQLite has no functions/sequences) is correct data from a
  supported method — it is not a flagged-off method silently doing nothing.
- **Touching `EditorTabs` / `SqlEditor` is allowed.** The "don't touch these to add
  a connector" rule is about adding a *connector*; this is a *feature*.

## Architecture

### Backend

**Domain** (`domain/models/schema_details.rs`, new):

```rust
pub struct SchemaDetails {
    pub schema:             String,
    pub tables:             Vec<ObjectSummary>,
    pub views:              Vec<ObjectSummary>,
    pub materialized_views: Vec<ObjectSummary>,
    pub functions:          Vec<ObjectSummary>,
    pub sequences:          Vec<ObjectSummary>,
}

pub struct ObjectSummary {
    pub name:    String,
    /// Best-effort, engine-specific detail line (e.g. column count for a table,
    /// return type for a function). Optional so engines that lack it omit it.
    pub detail:  Option<String>,
}
```

**Port** (`domain/ports/database_driver.rs`): add

```rust
async fn schema_details(
    &self,
    conn:   &Connection,
    schema: &str,
) -> Result<SchemaDetails, DriverError>;
```

Default-less: every engine implements it (or returns `Unsupported` if its
capability is `false` — but both shipped engines support it).

**Capabilities** (`domain/capabilities.rs`): add `pub schema_details: bool` to
`Capabilities`. Postgres `true`, SQLite `true`.

**Postgres** (`infrastructure/database/postgres/mod.rs`): one query per kind,
filtered by schema, **schema bound as a parameter** ($1), never interpolated:
- tables: `information_schema.tables` where `table_type='BASE TABLE'` (+ column
  count from `information_schema.columns`)
- views: `information_schema.views` / `pg_catalog.pg_views`
- materialized views: `pg_catalog.pg_matviews`
- functions: `information_schema.routines` (or `pg_proc` join `pg_namespace`)
- sequences: `information_schema.sequences` / `pg_catalog.pg_sequences`
Set `schema_details: true` in `capabilities()`.

**SQLite** (`infrastructure/database/sqlite/mod.rs`):
- tables: `sqlite_master` where `type='table'`
- views: `sqlite_master` where `type='view'`
- materialized_views / functions / sequences: empty vecs (SQLite has no such
  objects)
Set `schema_details: true` in `capabilities()`.

**Application** (`application/introspection.rs`): add

```rust
pub async fn schema_details(
    state:         &AppState,
    connection_id: &str,
    schema:        &str,
) -> Result<SchemaDetails, DriverError>
```

mirroring the existing `table_details` use case (pick driver, call port).

**Command** (`commands/table_details.rs` or a new `commands/schema_details.rs`):

```rust
#[tauri::command]
pub async fn get_schema_details(
    state:         State<'_, AppState>,
    connection_id: String,
    schema:        String,
) -> Result<SchemaDetails, String> { /* 1–3 lines */ }
```

Register in `lib.rs` invoke handler.

### Frontend

**Connector mirror** (`src/connectors/`):
- `types.ts`: add `schemaDetails: boolean` to `Capabilities`; add
  `schemaObjectKinds: SchemaObjectKind[]` to `ConnectorDescriptor` where
  `SchemaObjectKind = 'tables' | 'views' | 'materializedViews' | 'functions' | 'sequences'`.
- `postgres.ts`: `schemaDetails: true`, all five kinds.
- `sqlite.ts`: `schemaDetails: true`, kinds `['tables','views']`.
- Verify against the `connector_capabilities` command.

**Tab type** (`src/lib/tabs.ts`): add `'schema-details'` to `TabType`.

**Schema-details component** (`src/components/SchemaDetailsTab.tsx`, new):
- Props: `connectionId`, `connectionName`, `schema`, `driver`.
- `invoke<SchemaDetails>('get_schema_details', { connectionId, schema })`.
- Sections rendered per `descriptorFor(driver).schemaObjectKinds`. Layout mirrors
  `TableDetailsTab` (tabbed sections / collapsible lists).
- Each **table** row is clickable → `openTab('table-details', name, { schema, table, connectionId, connectionName })` (the exact path the sidebar already uses).
- View/mat-view/function/sequence rows are informational (no click) in v1.

**Render wiring** (`src/components/EditorTabs.tsx`): add a branch rendering
`<SchemaDetailsTab />` for `type === 'schema-details'`, next to the existing
`table-details` branch. Pass `openTab` down into `SqlEditor` (it does not receive
it today).

**Click + resolution** (`src/components/SqlEditor.tsx`):
- *Affordance*: on `editor.onMouseMove`, if `metaKey`/`ctrlKey` is held and the
  hovered position resolves to a known schema or table, add an underline
  decoration + set pointer cursor. Clear the decoration on move-away / key-up.
- *Trigger*: on `editor.onMouseDown`, if `metaKey`/`ctrlKey` is held, take the
  target position, resolve, and open the matching tab. Prevent the default
  cursor-placement only when a target is found.
- *Resolution* against `schemaCacheRef.current`:
  1. If text immediately before the word is `<ident>.`, treat the prefix as the
     schema and the word as a table → `table-details`.
  2. Else if the word matches a known **schema** name → `schema-details`.
  3. Else if the word matches a known **table** name: open `table-details`; if it
     exists in exactly one schema use that; if ambiguous across schemas, open the
     first match (a disambiguation picker is YAGNI for v1).
  4. Else no-op.
- Extracted as a pure `resolveIdentifier(word, precedingText, cache)` function so
  it is unit-testable without Monaco.

## Data Flow

```
Cmd+click in editor
  → SqlEditor.onMouseDown (modifier held)
  → resolveIdentifier(word, precedingText, schemaCacheRef)
      ├─ schema  → openTab('schema-details', schema, {...})
      │             → SchemaDetailsTab → invoke('get_schema_details')
      │                → application::schema_details → driver.schema_details
      └─ table   → openTab('table-details', table, {...})  [existing path]
```

## Error Handling

- Resolution miss → silent no-op (no tab, default click behavior unchanged).
- `get_schema_details` error → `SchemaDetailsTab` shows an inline error (same
  pattern as `TableDetailsTab`'s error state), never crashes the tab strip.
- Hostile / unknown schema name → bound as a parameter, returns an empty/typed
  result, never panics, never injects.

## Security

- **No identifier interpolation.** Schema name is bound as a query parameter in
  every introspection query. If any per-object metric needs an inline identifier
  (e.g. a row count `FROM <ident>`), it is quoted with the engine's `quote_ident`.
- A `tests/disaster.rs` case feeds a hostile schema name (e.g. `"; DROP TABLE …`)
  to `get_schema_details` for each engine and asserts a bounded/typed result with
  no panic.

## Testing

- **Rust unit tests** (next to code): `schema_details` for SQLite (in-memory DB
  with a table + a view → asserts both listed, functions/sequences empty);
  Postgres against the test instance (gated as existing introspection tests are).
- **Disaster test**: hostile schema name path (above).
- **Frontend unit test** (`SqlEditor` or a helper `*.test.ts`): `resolveIdentifier`
  table covering qualified `schema.table`, bare schema, bare table (unique +
  ambiguous), and miss.
- **Gates that must pass**: `cargo test`, `cargo clippy --all-targets -- -D warnings`,
  `npm test`, `npm run build` (the real frontend type check — `tsc --noEmit` is a
  no-op in this repo).

## Style

- No `cargo fmt`; match the deliberate manual column alignment when adding Rust
  struct fields / `let` bindings.
- Match each file's existing comment density and idiom.

## Out of Scope (v1)

- Cmd+click on views / functions / sequences in the editor.
- A dedicated view/function/sequence details view (schema tab lists them only).
- A disambiguation picker when a bare table name exists in multiple schemas.
- MySQL (`Driver::MySql` stays `Unsupported` at the registry).
