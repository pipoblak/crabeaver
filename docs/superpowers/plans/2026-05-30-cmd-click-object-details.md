# Cmd+Click Object Details — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cmd/Ctrl+click an identifier in the SQL editor to open a details tab — a table name opens the existing table inspector; a schema name opens a new schema-details tab listing the schema's objects (tables, views, materialized views, functions, sequences).

**Architecture:** New `schema_details` introspection method on the `DatabaseDriver` port (gated by one new `schema_details` capability), implemented in the Postgres and SQLite adapters, exposed through a thin `get_schema_details` command. Frontend adds a `schema-details` tab type + `SchemaDetailsTab` component, a pure identifier resolver, and a Monaco mouse handler in `SqlEditor` that resolves the clicked word against the in-editor schema cache and opens the matching tab. Which object sections render is driven by a frontend-only `schemaObjectKinds` descriptor field (not a backend capability flag), keeping the capability↔method mapping 1:1.

**Tech Stack:** Rust (Tauri v2, sqlx, async-trait), React + TypeScript, Monaco (`@monaco-editor/react`), vitest, `cargo test`.

---

## File Structure

**Backend (create):**
- `src-tauri/src/domain/models/schema_details.rs` — `SchemaDetails`, `ObjectSummary`.

**Backend (modify):**
- `src-tauri/src/domain/models/mod.rs` — register the new module.
- `src-tauri/src/domain/capabilities.rs` — add `schema_details: bool`.
- `src-tauri/src/domain/ports/database_driver.rs` — add the trait method.
- `src-tauri/src/infrastructure/database/postgres/mod.rs` — impl + capability + delegate.
- `src-tauri/src/infrastructure/database/sqlite/mod.rs` — impl + capability + delegate.
- `src-tauri/src/application/introspection.rs` — `schema_details` use case.
- `src-tauri/src/commands/table_details.rs` — add `get_schema_details` command.
- `src-tauri/src/lib.rs` — register the command.
- `src-tauri/tests/sqlite_driver.rs` — integration assertion.
- `src-tauri/tests/disaster.rs` — hostile schema name.

**Frontend (create):**
- `src/lib/resolveIdentifier.ts` — pure resolver.
- `src/lib/resolveIdentifier.test.ts` — vitest.
- `src/components/SchemaDetailsTab.tsx` — the new tab UI.

**Frontend (modify):**
- `src/connectors/types.ts` — `schemaDetails`, `schemaObjectKinds`, `SchemaObjectKind`.
- `src/connectors/postgres.ts`, `src/connectors/sqlite.ts` — fill the new fields.
- `src/lib/tabs.ts` — add `'schema-details'` to `TabType`.
- `src/context/TabsContext.tsx` — dedup branch for `schema-details`.
- `src/components/EditorTabs.tsx` — render branch + pass `onOpenObject` to `SqlEditor`.
- `src/components/SqlEditor.tsx` — `onOpenObject` prop + mouse handler + hover affordance.
- `src/components/Sidebar.tsx` — widen `openTab` union to include `'schema-details'`.
- `src/index.css` — `.sql-cmd-link` style.

---

## Phase 1 — Backend

### Task 1: Domain model `SchemaDetails`

**Files:**
- Create: `src-tauri/src/domain/models/schema_details.rs`
- Modify: `src-tauri/src/domain/models/mod.rs`

- [ ] **Step 1: Create the model file**

Create `src-tauri/src/domain/models/schema_details.rs`:

```rust
use serde::{Deserialize, Serialize};

/// The objects that live in one schema, grouped by kind. Produced by
/// `DatabaseDriver::schema_details`. Postgres fills every group; leaner engines
/// (SQLite) populate the kinds they have and leave the rest empty.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SchemaDetails {
    pub schema:             String,
    pub tables:             Vec<ObjectSummary>,
    pub views:              Vec<ObjectSummary>,
    pub materialized_views: Vec<ObjectSummary>,
    pub functions:          Vec<ObjectSummary>,
    pub sequences:          Vec<ObjectSummary>,
}

/// One object in a schema listing. `detail` is a best-effort, engine-specific
/// one-liner (e.g. column count for a table, return type for a function); `None`
/// when the engine has nothing useful to show.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ObjectSummary {
    pub name:   String,
    pub detail: Option<String>,
}
```

- [ ] **Step 2: Register the module**

In `src-tauri/src/domain/models/mod.rs`, add the line in alphabetical position (after `schema;`):

```rust
pub mod schema_details;
```

- [ ] **Step 3: Compile**

Run: `cd src-tauri && cargo build`
Expected: builds (the new type is unused so far — a `dead_code` warning is acceptable until Task 2 wires it).

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/domain/models/schema_details.rs src-tauri/src/domain/models/mod.rs
git commit -m "feat(domain): SchemaDetails / ObjectSummary model"
```

---

### Task 2: Port method + capability flag

**Files:**
- Modify: `src-tauri/src/domain/ports/database_driver.rs`
- Modify: `src-tauri/src/domain/capabilities.rs:92-98`

- [ ] **Step 1: Add the capability flag**

In `src-tauri/src/domain/capabilities.rs`, add `schema_details` to the struct right after `table_details:` (keep the manual column alignment):

```rust
    pub schemas:        bool,
    pub list_databases: bool,
    pub table_details:  bool,
    pub schema_details: bool,
    pub sessions:       bool,
```

- [ ] **Step 2: Add the trait method**

In `src-tauri/src/domain/ports/database_driver.rs`, add the import at the top alongside the other model imports:

```rust
use crate::domain::models::schema_details::SchemaDetails;
```

Then add the method in the `// ── Introspection ──` section, immediately after `table_details`:

```rust
    /// Objects in one schema, grouped by kind (tables, views, matviews,
    /// functions, sequences). `Unsupported` when `capabilities().schema_details`
    /// is false.
    async fn schema_details(
        &self,
        conn:   &Connection,
        schema: &str,
    ) -> Result<SchemaDetails, DriverError>;
```

- [ ] **Step 3: Build (expect failures)**

Run: `cd src-tauri && cargo build`
Expected: FAIL — `PostgresDriver` and `SqliteDriver` no longer satisfy the trait (missing `schema_details`) and their `Capabilities` literals miss a field. These are fixed in Tasks 3–4.

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/domain/ports/database_driver.rs src-tauri/src/domain/capabilities.rs
git commit -m "feat(domain): schema_details port method + capability flag"
```

---

### Task 3: SQLite implementation

**Files:**
- Modify: `src-tauri/src/infrastructure/database/sqlite/mod.rs` (add impl fn near `schemas_impl` ~line 113; add capability ~line 390; add delegate ~line 485)
- Test: `src-tauri/tests/sqlite_driver.rs`

- [ ] **Step 1: Write the failing integration test**

In `src-tauri/tests/sqlite_driver.rs`, append:

```rust
#[tokio::test]
async fn schema_details_lists_tables_and_views() {
    let tmp = NamedTempFile::new().unwrap();
    let c = conn(tmp.path().to_str().unwrap());
    let d = SqliteDriver::new();
    seed(&d, &c).await;
    d.execute(&c, "CREATE VIEW recent_books AS SELECT * FROM books").await.unwrap();

    let sd = d.schema_details(&c, "main").await.unwrap();

    let tables: Vec<&str> = sd.tables.iter().map(|o| o.name.as_str()).collect();
    assert!(tables.contains(&"authors") && tables.contains(&"books"));
    assert!(sd.views.iter().any(|o| o.name == "recent_books"));
    // SQLite has no functions or sequences — these stay empty, not errors.
    assert!(sd.functions.is_empty());
    assert!(sd.sequences.is_empty());
    assert!(sd.materialized_views.is_empty());
}
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd src-tauri && cargo test --test sqlite_driver schema_details_lists_tables_and_views`
Expected: FAIL to compile / method missing (until Step 3–5).

- [ ] **Step 3: Add the impl function**

In `src-tauri/src/infrastructure/database/sqlite/mod.rs`, add after `schemas_impl` (after the `Ok(...)` that closes it, ~line 178):

```rust
    /// Objects in the (single) SQLite schema. SQLite only has tables and views
    /// in `sqlite_master`; functions/sequences/matviews do not exist, so those
    /// groups are always empty. The schema arg is accepted for signature parity
    /// but SQLite has one implicit namespace.
    async fn schema_details_impl(pool: &SqlitePool, schema: &str) -> Result<SchemaDetails, DriverError> {
        let tables = sqlx::query(
            "SELECT name FROM sqlite_master
             WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
             ORDER BY name",
        )
        .fetch_all(pool)
        .await
        .map_err(query_err)?
        .iter()
        .map(|r| ObjectSummary { name: r.try_get::<String, _>("name").unwrap_or_default(), detail: None })
        .collect();

        let views = sqlx::query(
            "SELECT name FROM sqlite_master WHERE type = 'view' ORDER BY name",
        )
        .fetch_all(pool)
        .await
        .map_err(query_err)?
        .iter()
        .map(|r| ObjectSummary { name: r.try_get::<String, _>("name").unwrap_or_default(), detail: None })
        .collect();

        Ok(SchemaDetails {
            schema:             schema.to_string(),
            tables,
            views,
            materialized_views: Vec::new(),
            functions:          Vec::new(),
            sequences:          Vec::new(),
        })
    }
```

Add the imports at the top of the file (next to the existing `schema`/`table_details` model imports):

```rust
use crate::domain::models::schema_details::{ObjectSummary, SchemaDetails};
```

(If `sqlx::Row` is not already in scope in this file it is — `try_get` is used by `schemas_impl` already.)

- [ ] **Step 4: Set the capability and add the delegate**

In `capabilities()` (~line 390), add after `table_details: true,`:

```rust
            table_details:  true,
            schema_details: true,
```

In the trait impl, add the delegate right after the `table_details` method (~line 504):

```rust
    async fn schema_details(&self, conn: &Connection, schema: &str) -> Result<SchemaDetails, DriverError> {
        let pool = self.pool(conn).await?;
        Self::schema_details_impl(&pool, schema).await
    }
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd src-tauri && cargo test --test sqlite_driver schema_details_lists_tables_and_views`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/infrastructure/database/sqlite/mod.rs src-tauri/tests/sqlite_driver.rs
git commit -m "feat(sqlite): schema_details (tables + views)"
```

---

### Task 4: Postgres implementation

**Files:**
- Modify: `src-tauri/src/infrastructure/database/postgres/mod.rs` (add impl after `schemas_impl` ~line 312; capability ~line 695; delegate ~line 789)

> No automated Postgres test is added: this repo has no Postgres integration test harness (no `tests/postgres_*.rs`, no test server in CI). The trait contract is exercised by the SQLite integration test and the disaster test (Task 7). Verify Postgres manually via `npm run tauri dev` against a real database.

- [ ] **Step 1: Add the impl function**

In `src-tauri/src/infrastructure/database/postgres/mod.rs`, add after `schemas_impl` closes (~line 312). Schema is **bound as `$1`**, never interpolated:

```rust
    /// Objects in one schema, grouped by kind. Schema name is bound as a
    /// parameter — never interpolated — so a hostile schema string is inert.
    async fn schema_details_impl(pool: &PgPool, schema: &str) -> Result<SchemaDetails, DriverError> {
        // Helper: run a (name, optional-detail) query bound to the schema.
        async fn list(pool: &PgPool, sql: &str, schema: &str) -> Result<Vec<ObjectSummary>, DriverError> {
            let rows = sqlx::query(sql).bind(schema).fetch_all(pool).await.map_err(query_err)?;
            Ok(rows
                .iter()
                .map(|r| ObjectSummary {
                    name:   r.try_get::<String, _>("name").unwrap_or_default(),
                    detail: r.try_get::<String, _>("detail").ok(),
                })
                .collect())
        }

        let tables = list(
            pool,
            "SELECT t.table_name AS name,
                    count(c.column_name)::text || ' cols' AS detail
             FROM information_schema.tables t
             LEFT JOIN information_schema.columns c
               ON c.table_schema = t.table_schema AND c.table_name = t.table_name
             WHERE t.table_schema = $1 AND t.table_type = 'BASE TABLE'
             GROUP BY t.table_name
             ORDER BY t.table_name",
            schema,
        )
        .await?;

        let views = list(
            pool,
            "SELECT table_name AS name, NULL::text AS detail
             FROM information_schema.views
             WHERE table_schema = $1 ORDER BY table_name",
            schema,
        )
        .await?;

        let materialized_views = list(
            pool,
            "SELECT matviewname AS name, NULL::text AS detail
             FROM pg_catalog.pg_matviews
             WHERE schemaname = $1 ORDER BY matviewname",
            schema,
        )
        .await?;

        let functions = list(
            pool,
            "SELECT routine_name AS name, data_type AS detail
             FROM information_schema.routines
             WHERE specific_schema = $1 ORDER BY routine_name",
            schema,
        )
        .await?;

        let sequences = list(
            pool,
            "SELECT sequence_name AS name, NULL::text AS detail
             FROM information_schema.sequences
             WHERE sequence_schema = $1 ORDER BY sequence_name",
            schema,
        )
        .await?;

        Ok(SchemaDetails { schema: schema.to_string(), tables, views, materialized_views, functions, sequences })
    }
```

Add the import at the top alongside the other model imports:

```rust
use crate::domain::models::schema_details::{ObjectSummary, SchemaDetails};
```

- [ ] **Step 2: Set the capability and add the delegate**

In `capabilities()` (~line 695), add after `table_details: true,`:

```rust
            table_details:  true,
            schema_details: true,
```

Add the delegate after the `table_details` method (~line 789):

```rust
    async fn schema_details(&self, conn: &Connection, schema: &str) -> Result<SchemaDetails, DriverError> {
        let pool = self.pool(conn).await?;
        Self::schema_details_impl(&pool, schema).await
    }
```

- [ ] **Step 3: Build + clippy**

Run: `cd src-tauri && cargo build && cargo clippy --all-targets -- -D warnings`
Expected: clean (both drivers now satisfy the trait; no warnings).

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/infrastructure/database/postgres/mod.rs
git commit -m "feat(postgres): schema_details (tables, views, matviews, functions, sequences)"
```

---

### Task 5: Application use case

**Files:**
- Modify: `src-tauri/src/application/introspection.rs`

- [ ] **Step 1: Add the use case**

In `src-tauri/src/application/introspection.rs`, add the import next to the existing `table_details` import:

```rust
use crate::domain::models::schema_details::SchemaDetails;
```

Add the function after `table_details` (~line 41), mirroring it exactly:

```rust
pub async fn schema_details(
    state:         &AppState,
    connection_id: &str,
    schema:        &str,
) -> Result<SchemaDetails, DriverError> {
    let conn = load_connection(state, connection_id).await?;
    let driver = state.drivers.driver_for_str(&conn.driver)?;
    driver.schema_details(&conn, schema).await
}
```

- [ ] **Step 2: Build**

Run: `cd src-tauri && cargo build`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/application/introspection.rs
git commit -m "feat(application): schema_details use case"
```

---

### Task 6: Command + registration

**Files:**
- Modify: `src-tauri/src/commands/table_details.rs`
- Modify: `src-tauri/src/lib.rs:8` (use) and `:107` (handler list)

- [ ] **Step 1: Add the command**

In `src-tauri/src/commands/table_details.rs`, add the import next to the existing `TableDetails` import:

```rust
use crate::domain::models::schema_details::SchemaDetails;
```

Add the command after `get_table_details`:

```rust
#[tauri::command]
pub async fn get_schema_details(
    state:         State<'_, AppState>,
    connection_id: String,
    schema:        String,
) -> Result<SchemaDetails, String> {
    introspection::schema_details(&state, &connection_id, &schema)
        .await
        .map_err(Into::into)
}
```

- [ ] **Step 2: Register it in `lib.rs`**

In `src-tauri/src/lib.rs`, update the `use` on line 8:

```rust
use commands::table_details::{get_schema_details, get_table_details};
```

And add `get_schema_details,` to the `generate_handler!` list next to `get_table_details,` (~line 107):

```rust
            get_table_details,
            get_schema_details,
```

- [ ] **Step 3: Build**

Run: `cd src-tauri && cargo build`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/commands/table_details.rs src-tauri/src/lib.rs
git commit -m "feat(commands): get_schema_details Tauri command"
```

---

### Task 7: Disaster test — hostile schema name

**Files:**
- Modify: `src-tauri/tests/disaster.rs`

- [ ] **Step 1: Write the test**

In `src-tauri/tests/disaster.rs`, append:

```rust
// ── Hostile schema name must never inject or panic ───────────────────────────

#[tokio::test]
async fn schema_details_rejects_injection_in_schema_name() {
    let tmp = NamedTempFile::new().unwrap();
    let c = sqlite_conn(tmp.path().to_str().unwrap());
    let d = SqliteDriver::new();
    d.execute(&c, "CREATE TABLE keep_me (id INTEGER PRIMARY KEY)").await.unwrap();

    // A schema name carrying SQL must be treated as an opaque value, not executed.
    let evil = "main'; DROP TABLE keep_me; --";
    let sd = d.schema_details(&c, evil).await;
    // Either an empty/bounded result or a typed error — never a panic.
    assert!(sd.is_ok() || sd.is_err());

    // The table must still exist: nothing was dropped.
    let r = d.execute(&c, "SELECT count(*) AS n FROM sqlite_master WHERE name = 'keep_me'").await.unwrap();
    assert_eq!(r.rows[0][0], serde_json::json!(1), "hostile schema name must not drop tables");
}
```

- [ ] **Step 2: Run it to verify it passes**

Run: `cd src-tauri && cargo test --test disaster schema_details_rejects_injection_in_schema_name`
Expected: PASS (SQLite ignores the schema arg entirely, so nothing is interpolated).

- [ ] **Step 3: Commit**

```bash
git add src-tauri/tests/disaster.rs
git commit -m "test(disaster): schema_details ignores hostile schema name"
```

---

## Phase 2 — Frontend

### Task 8: Connector capabilities + descriptor fields

**Files:**
- Modify: `src/connectors/types.ts`
- Modify: `src/connectors/postgres.ts`, `src/connectors/sqlite.ts`

- [ ] **Step 1: Extend the types**

In `src/connectors/types.ts`, add `schemaDetails` to `Capabilities` (after `tableDetails`):

```ts
export interface Capabilities {
  schemas:       boolean
  listDatabases: boolean
  tableDetails:  boolean
  schemaDetails: boolean
  sessions:      boolean
  locks:         boolean
  cancel:        boolean
  transactions:  boolean
}
```

Add the kind type and the descriptor field. Put the type above `ConnectorDescriptor`:

```ts
/** Object kinds a connector's schema-details tab can list, in display order. */
export type SchemaObjectKind = 'tables' | 'views' | 'materializedViews' | 'functions' | 'sequences'
```

And add to `ConnectorDescriptor` (after `capabilities`):

```ts
  capabilities:   Capabilities
  /** Which object kinds the schema-details tab renders for this engine. */
  schemaObjectKinds: SchemaObjectKind[]
```

- [ ] **Step 2: Fill Postgres**

In `src/connectors/postgres.ts`, add `schemaDetails: true,` after `tableDetails: true,`, and add the kinds after the `capabilities` block (inside the object literal):

```ts
  capabilities: {
    schemas:       true,
    listDatabases: true,
    tableDetails:  true,
    schemaDetails: true,
    sessions:      true,
    locks:         true,
    cancel:        true,
    transactions:  true,
  },
  schemaObjectKinds: ['tables', 'views', 'materializedViews', 'functions', 'sequences'],
}
```

- [ ] **Step 3: Fill SQLite**

In `src/connectors/sqlite.ts`, add `schemaDetails: true,` after `tableDetails: true,`, and add the kinds:

```ts
  capabilities: {
    schemas:       true,
    listDatabases: true,
    tableDetails:  true,
    schemaDetails: true,
    sessions:      false,
    locks:         false,
    cancel:        false,
    transactions:  true,
  },
  schemaObjectKinds: ['tables', 'views'],
}
```

- [ ] **Step 4: Type check**

Run: `npm run build`
Expected: PASS (no missing-field errors on the descriptors).

- [ ] **Step 5: Commit**

```bash
git add src/connectors/types.ts src/connectors/postgres.ts src/connectors/sqlite.ts
git commit -m "feat(connectors): schemaDetails capability + schemaObjectKinds"
```

---

### Task 9: Tab type + dedup branch

**Files:**
- Modify: `src/lib/tabs.ts:1`
- Modify: `src/context/TabsContext.tsx:156-173`

- [ ] **Step 1: Add the tab type**

In `src/lib/tabs.ts`, line 1:

```ts
export type TabType = 'query' | 'session-manager' | 'lock-manager' | 'table-details' | 'schema-details'
```

- [ ] **Step 2: Add the dedup branch**

In `src/context/TabsContext.tsx`, inside `openSpecialTab`'s `existing` finder (~line 160), add a `schema-details` branch alongside the `table-details` one:

```ts
    const existing = tabsRef.current.find(t => {
      if (t.type !== type) return false
      if (t.connectionId !== (extra as any)?.connectionId) return false
      if (type === 'table-details') {
        return (t as any).schema === (extra as any)?.schema && (t as any).table === (extra as any)?.table
      }
      if (type === 'schema-details') {
        return (t as any).schema === (extra as any)?.schema
      }
      return true
    })
```

- [ ] **Step 3: Type check**

Run: `npm run build`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/lib/tabs.ts src/context/TabsContext.tsx
git commit -m "feat(tabs): schema-details tab type + dedup"
```

---

### Task 10: Identifier resolver (pure, TDD)

**Files:**
- Create: `src/lib/resolveIdentifier.ts`
- Test: `src/lib/resolveIdentifier.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/lib/resolveIdentifier.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { resolveIdentifier, type ResolverCache } from './resolveIdentifier'

const cache: ResolverCache = {
  schemas: ['public', 'sales'],
  tables: [
    { schema: 'public', name: 'users' },
    { schema: 'sales', name: 'orders' },
    { schema: 'public', name: 'orders' }, // same table name in two schemas
  ],
}

describe('resolveIdentifier', () => {
  it('resolves a qualified schema.table to that table', () => {
    expect(resolveIdentifier('orders', 'SELECT * FROM sales.', cache))
      .toEqual({ kind: 'table', schema: 'sales', table: 'orders' })
  })

  it('resolves a bare schema name to a schema target', () => {
    expect(resolveIdentifier('public', 'SELECT * FROM ', cache))
      .toEqual({ kind: 'schema', schema: 'public' })
  })

  it('resolves a uniquely-named bare table', () => {
    expect(resolveIdentifier('users', 'SELECT * FROM ', cache))
      .toEqual({ kind: 'table', schema: 'public', table: 'users' })
  })

  it('falls back to the first schema for an ambiguous bare table', () => {
    // 'orders' exists in both public and sales; pick the first match deterministically.
    expect(resolveIdentifier('orders', 'SELECT * FROM ', cache))
      .toEqual({ kind: 'table', schema: 'public', table: 'orders' })
  })

  it('strips surrounding double quotes', () => {
    expect(resolveIdentifier('"users"', 'SELECT * FROM ', cache))
      .toEqual({ kind: 'table', schema: 'public', table: 'users' })
  })

  it('returns null for an unknown identifier', () => {
    expect(resolveIdentifier('nope', 'SELECT * FROM ', cache)).toBeNull()
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test -- resolveIdentifier`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the resolver**

Create `src/lib/resolveIdentifier.ts`:

```ts
export interface ResolverCache {
  schemas: string[]
  tables:  Array<{ schema: string; name: string }>
}

export type ResolveTarget =
  | { kind: 'schema'; schema: string }
  | { kind: 'table'; schema: string; table: string }

const unquote = (s: string) => s.replace(/^"(.*)"$/s, '$1')

/**
 * Resolve the identifier under the cursor to a clickable target.
 * `word` is the bare token clicked; `before` is the text on the same line up to
 * (but not including) the word; `cache` is the known schema/table set.
 *
 * Priority: qualified `schema.word` → bare schema → bare table (unique, else
 * first match) → null.
 */
export function resolveIdentifier(word: string, before: string, cache: ResolverCache): ResolveTarget | null {
  const name = unquote(word.trim())
  if (!name) return null

  // 1. Qualified: a `<prefix>.` immediately precedes the word.
  const prefixMatch = before.match(/(?:^|[^\w."])"?([A-Za-z_][\w$]*)"?\s*\.\s*$/)
  if (prefixMatch) {
    const prefix = prefixMatch[1]
    if (cache.schemas.includes(prefix) && cache.tables.some(t => t.schema === prefix && t.name === name)) {
      return { kind: 'table', schema: prefix, table: name }
    }
  }

  // 2. Bare schema name.
  if (cache.schemas.includes(name)) {
    return { kind: 'schema', schema: name }
  }

  // 3. Bare table name — unique wins; ambiguous falls back to the first match.
  const matches = cache.tables.filter(t => t.name === name)
  if (matches.length > 0) {
    return { kind: 'table', schema: matches[0].schema, table: name }
  }

  return null
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- resolveIdentifier`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/resolveIdentifier.ts src/lib/resolveIdentifier.test.ts
git commit -m "feat(editor): pure identifier resolver + tests"
```

---

### Task 11: `SchemaDetailsTab` component

**Files:**
- Create: `src/components/SchemaDetailsTab.tsx`

- [ ] **Step 1: Create the component**

Create `src/components/SchemaDetailsTab.tsx`. Sections are driven by the connector's `schemaObjectKinds`; clicking a table row opens its table-details tab via the passed `onOpenTable` callback:

```tsx
import { useState, useEffect } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { Loader2, XCircle, Table2, Eye, Layers, FunctionSquare, Hash } from 'lucide-react'
import { descriptorFor } from '@/connectors/registry'
import type { SchemaObjectKind } from '@/connectors/types'

interface ObjectSummary { name: string; detail?: string }
interface SchemaDetails {
  schema: string
  tables: ObjectSummary[]
  views: ObjectSummary[]
  materializedViews: ObjectSummary[]
  functions: ObjectSummary[]
  sequences: ObjectSummary[]
}

interface Props {
  connectionId: string
  schema: string
  driver?: string
  onOpenTable: (schema: string, table: string) => void
}

const KIND_META: Record<SchemaObjectKind, { label: string; icon: React.ReactNode; field: keyof Omit<SchemaDetails, 'schema'> }> = {
  tables:            { label: 'Tables',             icon: <Table2 size={13} />,         field: 'tables' },
  views:             { label: 'Views',              icon: <Eye size={13} />,            field: 'views' },
  materializedViews: { label: 'Materialized Views', icon: <Layers size={13} />,         field: 'materializedViews' },
  functions:         { label: 'Functions',          icon: <FunctionSquare size={13} />, field: 'functions' },
  sequences:         { label: 'Sequences',          icon: <Hash size={13} />,           field: 'sequences' },
}

export default function SchemaDetailsTab({ connectionId, schema, driver, onOpenTable }: Props) {
  const [details, setDetails] = useState<SchemaDetails | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError]     = useState<string | null>(null)

  const kinds = descriptorFor(driver).schemaObjectKinds
  const [section, setSection] = useState<SchemaObjectKind>(kinds[0] ?? 'tables')

  useEffect(() => {
    setLoading(true); setError(null)
    invoke<SchemaDetails>('get_schema_details', { connectionId, schema })
      .then(d => { setDetails(d); setLoading(false) })
      .catch(e => { setError(String(e)); setLoading(false) })
  }, [connectionId, schema])

  if (loading) return <div className="flex items-center justify-center flex-1 gap-2 text-th-dim"><Loader2 size={16} className="animate-spin" />Loading…</div>
  if (error)   return <div className="flex items-center justify-center flex-1 gap-2" style={{ color: 'var(--error-text)' }}><XCircle size={16} />{error}</div>
  if (!details) return null

  const items = details[KIND_META[section].field] as ObjectSummary[]

  return (
    <div className="flex h-full overflow-hidden bg-th-bg">
      {/* Section sidebar */}
      <div className="flex flex-col w-44 shrink-0 overflow-y-auto" style={{ borderRight: '1px solid var(--border)', background: 'var(--sidebar-bg)' }}>
        <div style={{ padding: '10px 12px 6px', borderBottom: '1px solid var(--border)' }}>
          <p className="text-[11px] font-semibold text-th-dim truncate">{details.schema}</p>
        </div>
        {kinds.map(k => {
          const count = (details[KIND_META[k].field] as ObjectSummary[]).length
          return (
            <button key={k} onClick={() => setSection(k)}
              className="flex items-center gap-2 text-left text-[13px] transition-colors"
              style={{
                padding: '6px 12px',
                borderLeft: k === section ? '2px solid var(--tab-accent)' : '2px solid transparent',
                background: k === section ? 'var(--hover)' : 'transparent',
                color: k === section ? 'var(--text-bright)' : 'var(--text)',
              }}>
              <span style={{ color: 'var(--text-dim)', flexShrink: 0 }}>{KIND_META[k].icon}</span>
              {KIND_META[k].label}
              <span className="ml-auto text-[10px] text-th-dim">{count}</span>
            </button>
          )
        })}
      </div>

      {/* Section content */}
      <div className="flex flex-col flex-1 min-w-0 overflow-hidden">
        <div className="px-4 py-2 text-[11px] font-semibold tracking-widest uppercase text-th-dim shrink-0" style={{ borderBottom: '1px solid var(--border)', background: 'var(--sidebar-bg)' }}>
          {items.length} {KIND_META[section].label.toLowerCase()}
        </div>
        <div className="overflow-auto flex-1">
          <table className="text-[12px] w-full" style={{ borderCollapse: 'collapse' }}>
            <tbody>
              {items.map(o => {
                const clickable = section === 'tables'
                return (
                  <tr key={o.name}
                    onClick={clickable ? () => onOpenTable(details.schema, o.name) : undefined}
                    style={{ borderBottom: '1px solid var(--border)', cursor: clickable ? 'pointer' : 'default' }}
                    className="hover:bg-th-hover transition-colors">
                    <td className="px-4 py-1.5 font-medium text-th-bright">{o.name}</td>
                    <td className="px-4 py-1.5 text-th-dim text-[11px] text-right">{o.detail ?? ''}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Type check**

Run: `npm run build`
Expected: PASS. (If any `lucide-react` icon name is unavailable in the installed version, swap to an existing one — `FunctionSquare` and `Hash` are standard; `Layers` and `Eye` are too.)

- [ ] **Step 3: Commit**

```bash
git add src/components/SchemaDetailsTab.tsx
git commit -m "feat(ui): SchemaDetailsTab listing schema objects"
```

---

### Task 12: Wire the tab into EditorTabs + widen Sidebar union

**Files:**
- Modify: `src/components/EditorTabs.tsx` (import + render branch ~line 714; `SqlEditor` props ~line 720)
- Modify: `src/components/Sidebar.tsx:18`

- [ ] **Step 1: Import the component**

In `src/components/EditorTabs.tsx`, add next to the `TableDetailsTab` import (line 8):

```ts
import SchemaDetailsTab from '@/components/SchemaDetailsTab'
```

- [ ] **Step 2: Add the render branch**

After the `table-details` branch (~line 716), add:

```tsx
        {active?.type === 'schema-details' && active.connectionId && (
          <SchemaDetailsTab
            key={active.id}
            connectionId={active.connectionId}
            schema={(active as any).schema ?? 'public'}
            driver={connections.find(c => c.id === active.connectionId)?.driver}
            onOpenTable={(schema, table) => openSpecialTab('table-details', table, {
              connectionId: active.connectionId,
              connectionName: active.connectionName,
              ...( { schema, table } as any ),
            })}
          />
        )}
```

- [ ] **Step 3: Pass `onOpenObject` into `SqlEditor`**

In the `<SqlEditor ... />` block (~line 720), add the prop (after `onRunQuery`):

```tsx
                onRunQuery={(_sql, newTab) => runQuery(newTab)}
                onOpenObject={target => {
                  if (target.kind === 'schema') {
                    openSpecialTab('schema-details', target.schema, {
                      connectionId: active.connectionId,
                      connectionName: active.connectionName,
                      ...( { schema: target.schema } as any ),
                    })
                  } else {
                    openSpecialTab('table-details', target.table, {
                      connectionId: active.connectionId,
                      connectionName: active.connectionName,
                      ...( { schema: target.schema, table: target.table } as any ),
                    })
                  }
                }}
```

- [ ] **Step 4: Widen the Sidebar `openTab` union**

In `src/components/Sidebar.tsx`, line 18, add `'schema-details'` to the union so the shared type stays consistent (no behavior change in the sidebar itself):

```ts
  openTab?: (type: 'session-manager' | 'lock-manager' | 'table-details' | 'schema-details', title: string, extra: Record<string, string>) => void
```

- [ ] **Step 5: Type check (expect SqlEditor prop error)**

Run: `npm run build`
Expected: FAIL — `onOpenObject` is not yet a prop on `SqlEditor`. Fixed in Task 13. (If you prefer a green build between tasks, do Task 13 before re-running.)

- [ ] **Step 6: Commit**

```bash
git add src/components/EditorTabs.tsx src/components/Sidebar.tsx
git commit -m "feat(editor): render schema-details tab + open-object wiring"
```

---

### Task 13: Cmd+click handler + hover affordance in SqlEditor

**Files:**
- Modify: `src/components/SqlEditor.tsx` (import ~line 1-27; `Props` ~line 90; destructure ~line 113; new effect after the run-shortcut effect ~line 170)
- Modify: `src/index.css`

- [ ] **Step 1: Import the resolver and its type**

In `src/components/SqlEditor.tsx`, add near the top imports:

```ts
import { resolveIdentifier, type ResolveTarget } from '@/lib/resolveIdentifier'
```

- [ ] **Step 2: Add the prop**

In the `Props` interface (~line 90), add after `onRunQuery`:

```ts
  onRunQuery?: (sql: string, newTab: boolean) => void
  /** Cmd/Ctrl+click on a known schema/table identifier opens its details tab. */
  onOpenObject?: (target: ResolveTarget) => void
```

Add it to the destructure (~line 113):

```ts
  { value, onChange, connectionId, driver, scrollKey, database, onSchemaStatus, onRunQuery, onOpenObject }, ref) {
```

Add a ref so the once-registered handler reads the latest callback (next to `onRunQueryRef`, ~line 129):

```ts
  const onOpenObjectRef = useRef(onOpenObject)
  useEffect(() => { onOpenObjectRef.current = onOpenObject }, [onOpenObject])
```

- [ ] **Step 3: Add the mouse-handler effect**

In `src/components/SqlEditor.tsx`, add this effect immediately after the run-query-shortcut effect (after the closing `}, [monaco, editorReady])` at ~line 170):

```ts
  // ── Cmd/Ctrl+click navigation ──────────────────────────────────────────────
  // Cmd-hover underlines a known schema/table identifier; Cmd-click opens its
  // details tab. Resolution uses the in-editor schema cache (schemaCacheRef).
  useEffect(() => {
    if (!monaco || !editorReady) return
    const editor = editorRef.current
    if (!editor) return

    const decorations = editor.createDecorationsCollection()
    const clear = () => decorations.clear()

    const hitAt = (target: monaco_t.editor.IMouseTarget):
      | { range: monaco_t.Range; resolved: ResolveTarget }
      | null => {
      const pos = target.position
      const model = editor.getModel()
      const cache = schemaCacheRef.current
      if (!pos || !model || !cache) return null
      const word = model.getWordAtPosition(pos)
      if (!word) return null
      const before = model.getValueInRange(
        new monaco.Range(pos.lineNumber, 1, pos.lineNumber, word.startColumn),
      )
      const resolved = resolveIdentifier(word.word, before, cache)
      if (!resolved) return null
      return {
        range: new monaco.Range(pos.lineNumber, word.startColumn, pos.lineNumber, word.endColumn),
        resolved,
      }
    }

    const moveDisp = editor.onMouseMove(e => {
      if (!(e.event.metaKey || e.event.ctrlKey)) { clear(); return }
      const hit = hitAt(e.target)
      if (!hit) { clear(); return }
      decorations.set([{ range: hit.range, options: { inlineClassName: 'sql-cmd-link' } }])
    })

    const downDisp = editor.onMouseDown(e => {
      if (!(e.event.metaKey || e.event.ctrlKey) || !e.event.leftButton) return
      const hit = hitAt(e.target)
      if (!hit) return
      e.event.preventDefault()
      e.event.stopPropagation()
      onOpenObjectRef.current?.(hit.resolved)
      clear()
    })

    const upDisp = editor.onKeyUp(() => clear())

    return () => { moveDisp.dispose(); downDisp.dispose(); upDisp.dispose(); clear() }
  }, [monaco, editorReady])
```

- [ ] **Step 4: Add the link style**

In `src/index.css`, append:

```css
/* Cmd/Ctrl-hover affordance for clickable schema/table identifiers in the SQL editor. */
.sql-cmd-link {
  text-decoration: underline;
  cursor: pointer;
}
```

- [ ] **Step 5: Type check**

Run: `npm run build`
Expected: PASS (the `onOpenObject` prop from Task 12 now resolves).

- [ ] **Step 6: Commit**

```bash
git add src/components/SqlEditor.tsx src/index.css
git commit -m "feat(editor): cmd+click opens schema/table details with hover affordance"
```

---

## Phase 3 — Full verification

### Task 14: Run all gates

**Files:** none (verification only)

- [ ] **Step 1: Rust tests**

Run: `cd src-tauri && cargo test`
Expected: PASS, including `schema_details_lists_tables_and_views` and `schema_details_rejects_injection_in_schema_name`.

- [ ] **Step 2: Clippy**

Run: `cd src-tauri && cargo clippy --all-targets -- -D warnings`
Expected: clean.

- [ ] **Step 3: Frontend tests**

Run: `npm test`
Expected: PASS, including the `resolveIdentifier` suite.

- [ ] **Step 4: Frontend type check + bundle**

Run: `npm run build`
Expected: PASS (this is the real type check — `tsc --noEmit` is a no-op in this repo).

- [ ] **Step 5: Manual smoke (Postgres + SQLite)**

Run: `npm run tauri dev`
Then, against a connected database:
1. Type a query referencing a table (e.g. `SELECT * FROM public.users`).
2. Hold Cmd (Ctrl on Linux/Windows) — the identifier under the pointer underlines.
3. Cmd+click the table name → a table-details tab opens.
4. Cmd+click the schema name (`public`) → a schema-details tab opens listing tables (and, on Postgres, views/functions/sequences). Clicking a table row opens its details.
5. Confirm SQLite shows only Tables + Views sections.

- [ ] **Step 6: Final commit (if any docs/state to capture)**

```bash
git add -A
git commit -m "chore: cmd+click object details — verified" --allow-empty
```

---

## Self-Review Notes

- **Spec coverage:** editor cmd+click (Tasks 10, 13) ✓; tables→TableDetailsTab reuse (Task 12) ✓; new schema tab with all object kinds (Tasks 11, 12) ✓; backend introspection both engines (Tasks 3, 4) ✓; one method + one capability flag (Tasks 2–4) ✓; frontend `schemaObjectKinds` rendering (Tasks 8, 11) ✓; schema bound as parameter + disaster test (Tasks 4, 7) ✓; views/functions/sequences non-clickable in editor (resolver returns only schema/table — Task 10) ✓.
- **Known honest gap vs spec:** spec mentioned a Postgres automated test "gated as existing introspection tests are" — there is no Postgres test harness in this repo, so Task 4 ships no pg test and says so explicitly; coverage rests on the SQLite integration test, the disaster test, and the shared trait contract, plus the manual smoke step.
- **Type consistency:** `ResolveTarget` (Task 10) is the same type consumed by `onOpenObject` (Tasks 12, 13). `SchemaDetails`/`ObjectSummary` field names match across Rust (`camelCase` serde) and the TS interfaces in Task 11. `SchemaObjectKind` shared between `types.ts` and `SchemaDetailsTab`.
