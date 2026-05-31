# Table Data Section — Design Spec

**Date:** 2026-05-30
**Status:** Approved
**Branch:** TBD

## Problem

`TableDetailsTab` inspects a table's structure (columns, constraints, FKs, indexes,
DDL) but offers no way to see the table's **rows**. To look at data you must leave
the inspector, write `SELECT * FROM …` in an editor tab, and run it. We want to
browse — and navigate through — a table's data directly from its details tab.

## Decisions (locked)

1. **New "Data" section** in the `TableDetailsTab` sidebar (after Columns). Renders
   the existing results grid.
2. **Full capability**: sort, per-column filter, scroll-to-load-more, and
   foreign-key click navigation.
3. **FK-click navigates in place** within the Data grid (to the referenced table's
   rows) with a **back** button — the same history model the editor results grid
   uses. It does NOT open a new tab.
4. **Lazy**: the data query runs only when the Data section is first opened, not on
   every table-details open.
5. **Extract shared, pure query builders** (`src/lib/queryBuilder.ts`) and reuse
   them from both the new hook and `EditorTabs`, replacing the ad-hoc, inconsistent
   SQL string-building there.
6. **Default limit 200** (a constant). `TableDetailsTab` has no per-tab query-limit
   setting; making it configurable is out of scope.

## Architecture

### `src/lib/queryBuilder.ts` (new — pure functions)

Today `EditorTabs` assembles SQL inline and inconsistently: table refs unquoted
(`SELECT * FROM ${refTable}`), `ORDER BY ${col}` unquoted, filter predicates quoted
as `"${col}"::text ILIKE …`, values escaped with `replace(/'/g, "''")`. Centralize:

```ts
export interface Sort { col: string; dir: 'asc' | 'desc' }
export interface ColFilter { col: string; value: string; op: string } // op: '~' | '=' | '!=' | '>' | '<'

export function quoteIdent(name: string): string          // "name", embedded " doubled
export function qualifiedRef(schema: string, table: string): string  // "schema"."table"
export function escapeLiteral(value: string): string      // '' -escaped (no surrounding quotes)
export function buildFilterPredicate(f: ColFilter): string // matches existing operator semantics
export function applyLimit(sql: string, limit: number): string       // moved from EditorTabs
export function buildTableQuery(opts: {
  schema: string
  table: string
  sort?: Sort
  filters?: ColFilter[]
  limit: number
  offset?: number
}): string
```

`buildTableQuery` produces `SELECT * FROM "schema"."table" [WHERE p1 AND p2 …]
[ORDER BY "col" DIR] LIMIT n [OFFSET m]`. Identifiers are always quoted (pg and
sqlite both use double quotes), values escaped — so a hostile table/column name is
inert rather than injectable. `op` semantics mirror the current
`handleColumnFilter` (`~` → `ILIKE '%…%'`, `=`/`!=`/`>`/`<` → `"col"::text <op> '…'`).

### `src/hooks/useTableData.ts` (new)

Owns one result set's lifecycle for a `(connectionId, schema, table)`. Internal
state:

```ts
interface State {
  schema: string; table: string        // current target (changes on FK-nav)
  data?: QueryResult; error?: string
  running: boolean; loadingMore: boolean
  sort?: Sort; filters: ColFilter[]
  offset: number; hasMore: boolean
  history: Array<Omit<State, 'history' | 'running' | 'loadingMore'>>
}
```

Actions (all build SQL via `queryBuilder`, run via `invoke('execute_query', {
connectionId, sql })`):

- `load()` — initial fetch for the current schema/table (limit 200, offset 0); sets
  `offset = rows.length`, `hasMore = rows.length >= limit`.
- `loadMore()` — same query with `offset`; appends rows; bumps offset; recomputes
  `hasMore`.
- `setSort(col, dir)` / `setFilter(col, value, op)` — update sort/filters, re-run
  from offset 0.
- `fkClick(refTable, refCol, value)` — push current state to `history`, switch
  schema/table to the parsed `refTable` (`"schema.table"` → split), seed a single
  filter `{col: refCol, value, op: '='}`, run from offset 0.
- `back()` — pop `history`, restore.

`useTableData` does NOT auto-run on mount; the caller invokes `load()` when the Data
section is first shown (and once per `(schema, table)` identity).

### Grid extraction — `src/components/ResultTable.tsx` (new file, moved code)

`ResultTable` is currently a private inner component of `ResultsPane.tsx`. Move it to
its own file and export it; `ResultsPane` imports it. No behavior change — pure
relocation so the Data section can render the same grid. Its props (unchanged):

```ts
{ result: QueryResult; tab: ResultTab; fkColumns?: Set<string>;
  fkRefs?: Map<string, { table: string; col: string }>;
  onSort: (col: string | null, dir: 'asc' | 'desc') => void;
  onColumnFilter?: (col: string, value: string, op: string) => void;
  onFkClick?: (refTable: string, refCol: string, value: string, newTab: boolean) => void;
  onBack?: () => void; onLoadMore?: () => void }
```

`ResultTab` / `QueryResult` types move alongside it (or to a shared `lib/results.ts`)
and are re-exported from `ResultsPane` so existing imports keep working.

### `TableDetailsTab.tsx` — Data section

- Add `'data'` to the `Section` union and a sidebar entry (icon, after Columns).
- When `section === 'data'`, mount a `<TableDataSection>` subcomponent that calls
  `useTableData(connectionId, details.schema, details.table)`, calls `load()` on
  first show, and renders:
  - loading spinner / error message (same visual treatment as the rest of the tab),
  - otherwise `<ResultTable>` with a synthesized `ResultTab` from the hook state
    (`{ id: 'tbl-data', data, sortCol, sortDir, colFilters, colFilterOps, offset,
    hasMore, history }`) and the hook's actions wired to the grid callbacks.
- **FK derivation**: build `fkColumns`/`fkRefs` from `details.foreignKeys`
  (`fkColumns` = each FK's columns; `fkRefs[col] = { table: "${refSchema}.${refTable}",
  col: refColumns[i] }`) and pass to `ResultTable`. No schema re-fetch needed.
- The Data grid's header shows the current `schema.table` and a back button when
  `history` is non-empty (FK navigation moved to a different table).

### `EditorTabs.tsx` — adopt shared builders

Refactor its SQL assembly to call `queryBuilder` (`applyLimit`, `buildFilterPredicate`,
`quoteIdent`, `escapeLiteral`) in `runQuery`, `handleSort`, `handleColumnFilter`,
`handleLoadMore`, `handleFkClick`. State model and result-tab behavior unchanged —
this is a pure deduplication that also fixes the unquoted-identifier inconsistency.

## Data Flow

```
Open Data section
  → useTableData.load()
  → buildTableQuery({schema,table,limit:200})
  → invoke('execute_query') → rows → ResultTable

Scroll to bottom        → loadMore()  → buildTableQuery({…, offset}) → append
Click column sort       → setSort()   → re-query from offset 0
Apply column filter     → setFilter() → re-query from offset 0
Click FK cell           → fkClick()   → push history, switch table, filter=refCol, re-query
Click Back              → back()      → pop history, restore prior view
```

## Error Handling

- Query failure → `error` set, rendered inline in the Data section (never crashes the
  tab). A connection-level failure surfaces the backend's error string as-is.
- Hostile schema/table/column names are quoted via `quoteIdent`; values escaped via
  `escapeLiteral` — inert, not injectable.
- FK ref parsing: `"schema.table"` split on the **first** dot; if the ref lacks a
  schema, fall back to the current schema.

## Security

The editor already executes arbitrary SQL through `execute_query`, so building a
`SELECT` on the frontend is consistent with existing behavior. We nonetheless quote
all identifiers and escape all literals in `queryBuilder`, which is strictly safer
than the current ad-hoc interpolation in `EditorTabs` (which this spec replaces).

## Testing

- **`queryBuilder` unit tests** (vitest): `quoteIdent` doubles embedded quotes;
  `qualifiedRef`; `buildTableQuery` assembles WHERE/ORDER BY/LIMIT/OFFSET correctly;
  each filter operator renders the expected predicate; a `"; DROP …`-style table name
  becomes an inert quoted identifier.
- **`useTableData` tests** (vitest, mocked `invoke`): `load` populates rows + offset +
  hasMore; `loadMore` appends and advances offset; `setSort`/`setFilter` re-query from
  0; `fkClick` pushes history and switches table; `back` restores.
- **Regression**: `EditorTabs` still builds equivalent SQL after adopting the builders
  — covered by the `queryBuilder` tests plus existing frontend suite and a manual
  smoke of run/sort/filter/load-more/FK-click in the editor.
- **Gates**: `npm test`, `npm run build`, `cargo test`, `cargo clippy` all pass.

## Out of Scope

- Editing rows (read-only view).
- A configurable per-table-details query limit (fixed 200).
- Opening FK targets as separate tabs (navigation is in-place with back).
- Exporting data.
