# Table Data Section Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "Data" section to `TableDetailsTab` that browses a table's rows with sort, per-column filter, scroll-to-load-more, and in-place foreign-key navigation (with back).

**Architecture:** Extract pure SQL builders into `src/lib/queryBuilder.ts` (dialect-aware) and the row grid into a standalone `src/components/ResultTable.tsx`. A new `useTableData` hook owns one result set's lifecycle (load/loadMore/sort/filter/fkClick/back) and feeds `ResultTable`. `EditorTabs` adopts the shared builders to kill duplication.

**Tech Stack:** React + TypeScript, `@tanstack/react-table`, Tauri `invoke('execute_query')`, vitest.

---

## File Structure

**Create:**
- `src/lib/results.ts` — shared `ColumnInfo`/`QueryResult`/`ResultTab` types (moved out of `ResultsPane`).
- `src/lib/queryBuilder.ts` — pure, dialect-aware SQL builders.
- `src/lib/queryBuilder.test.ts` — builder unit tests.
- `src/components/ResultTable.tsx` — the row grid (moved out of `ResultsPane`).
- `src/hooks/useTableData.ts` — one result set's lifecycle for a table.
- `src/hooks/useTableData.test.ts` — hook tests (mocked `invoke`).

**Modify:**
- `src/components/ResultsPane.tsx` — import `ResultTable` + types from the new files; re-export the types.
- `src/components/TableDetailsTab.tsx` — add a `data` section + `driver` prop.
- `src/components/EditorTabs.tsx` — pass `driver` to `TableDetailsTab`; adopt `queryBuilder` in query handlers.

---

## Task 1: Shared result types — `src/lib/results.ts`

**Files:**
- Create: `src/lib/results.ts`
- Modify: `src/components/ResultsPane.tsx:9-34` (remove the type defs, import + re-export instead)

- [ ] **Step 1: Create the types module**

Create `src/lib/results.ts` (verbatim copy of the types currently in `ResultsPane.tsx:9-34`):

```ts
export interface ColumnInfo { name: string; typeName: string }

export interface QueryResult {
  columns:       ColumnInfo[]
  rows:          unknown[][]
  affectedRows?: number
  executionMs:   number
}

export interface ResultTab {
  id:           string
  title:        string
  data?:        QueryResult
  error?:       string
  running?:     boolean
  loadingMore?: boolean
  sql?:         string      // last executed SQL (shown as preview)
  baseSql?:     string      // SQL without ORDER BY/LIMIT/WHERE — for re-sort, filter, pagination
  sortCol?:     string
  sortDir?:     'asc' | 'desc'
  colFilters?:  Record<string, string>  // col → filter value
  colFilterOps?: Record<string, string> // col → operator: '~' | '=' | '!=' | '>' | '<'
  offset?:      number
  hasMore?:     boolean
  history?:     Array<Pick<ResultTab, 'data'|'sql'|'baseSql'|'sortCol'|'sortDir'|'colFilters'|'colFilterOps'|'offset'|'hasMore'>>
}
```

- [ ] **Step 2: Replace the defs in ResultsPane with imports + re-exports**

In `src/components/ResultsPane.tsx`, delete lines 9-34 (the `ColumnInfo`/`QueryResult`/`ResultTab` definitions) and add, just below the existing top imports:

```ts
import type { ColumnInfo, QueryResult, ResultTab } from '@/lib/results'
export type { QueryResult, ResultTab } from '@/lib/results'
```

(The `export type` re-export keeps `import { type QueryResult, type ResultTab } from '@/components/ResultsPane'` in `EditorTabs.tsx:10` working unchanged.)

- [ ] **Step 3: Verify type check passes**

Run: `npm run build`
Expected: PASS — no type errors; `EditorTabs` still resolves `QueryResult`/`ResultTab`.

- [ ] **Step 4: Commit**

```bash
git add src/lib/results.ts src/components/ResultsPane.tsx
git commit -m "refactor: move result types to src/lib/results.ts"
```

---

## Task 2: Pure SQL builders — `src/lib/queryBuilder.ts` (TDD)

**Files:**
- Create: `src/lib/queryBuilder.ts`
- Test: `src/lib/queryBuilder.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/lib/queryBuilder.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import {
  quoteIdent, qualifiedRef, escapeLiteral, buildFilterPredicate,
  applyLimit, buildTableQuery,
} from './queryBuilder'

describe('quoteIdent', () => {
  it('double-quotes and escapes embedded quotes (injection inert)', () => {
    expect(quoteIdent('users')).toBe('"users"')
    expect(quoteIdent('a"; DROP TABLE t; --')).toBe('"a""; DROP TABLE t; --"')
  })
})

describe('qualifiedRef', () => {
  it('quotes both schema and table', () => {
    expect(qualifiedRef('public', 'users')).toBe('"public"."users"')
  })
})

describe('escapeLiteral', () => {
  it('doubles single quotes', () => {
    expect(escapeLiteral("O'Brien")).toBe("O''Brien")
  })
})

describe('buildFilterPredicate', () => {
  it('postgres uses ::text and ILIKE for contains', () => {
    expect(buildFilterPredicate({ col: 'name', value: 'al', op: '~' }, 'postgres'))
      .toBe(`"name"::text ILIKE '%al%'`)
    expect(buildFilterPredicate({ col: 'age', value: '30', op: '>' }, 'postgres'))
      .toBe(`"age"::text > '30'`)
  })
  it('sqlite uses CAST(... AS TEXT) and LIKE', () => {
    expect(buildFilterPredicate({ col: 'name', value: 'al', op: '~' }, 'sqlite'))
      .toBe(`CAST("name" AS TEXT) LIKE '%al%'`)
  })
})

describe('applyLimit', () => {
  it('appends LIMIT to a SELECT without one', () => {
    expect(applyLimit('SELECT * FROM t', 200)).toBe('SELECT * FROM t\nLIMIT 200')
  })
  it('leaves an existing top-level LIMIT alone', () => {
    expect(applyLimit('SELECT * FROM t LIMIT 5', 200)).toBe('SELECT * FROM t LIMIT 5')
  })
  it('does not touch non-SELECT statements', () => {
    expect(applyLimit('UPDATE t SET x=1', 200)).toBe('UPDATE t SET x=1')
  })
})

describe('buildTableQuery', () => {
  it('builds a plain select with limit', () => {
    expect(buildTableQuery({ schema: 'public', table: 'users', limit: 200 }))
      .toBe('SELECT * FROM "public"."users"\nLIMIT 200')
  })
  it('adds WHERE, ORDER BY, LIMIT and OFFSET', () => {
    expect(buildTableQuery({
      schema: 'public', table: 'users',
      filters: [{ col: 'name', value: 'al', op: '~' }],
      sort: { col: 'id', dir: 'desc' }, limit: 200, offset: 200, dialect: 'postgres',
    })).toBe(
      'SELECT * FROM "public"."users"' +
      `\nWHERE "name"::text ILIKE '%al%'` +
      '\nORDER BY "id" DESC' +
      '\nLIMIT 200 OFFSET 200',
    )
  })
  it('ignores blank filters', () => {
    expect(buildTableQuery({
      schema: 'public', table: 'users',
      filters: [{ col: 'name', value: '   ', op: '~' }], limit: 200,
    })).toBe('SELECT * FROM "public"."users"\nLIMIT 200')
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -- queryBuilder`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the builders**

Create `src/lib/queryBuilder.ts`:

```ts
export type Dialect = 'postgres' | 'sqlite'
export interface Sort { col: string; dir: 'asc' | 'desc' }
export interface ColFilter { col: string; value: string; op: string } // op: '~' | '=' | '!=' | '>' | '<'

/** Map a connection driver string to a query dialect. */
export function driverToDialect(driver?: string): Dialect {
  return driver === 'sqlite' ? 'sqlite' : 'postgres'
}

/** Quote an identifier, doubling embedded quotes so a hostile name is inert. */
export function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`
}

export function qualifiedRef(schema: string, table: string): string {
  return `${quoteIdent(schema)}.${quoteIdent(table)}`
}

/** Escape a string literal's single quotes. Result is NOT surrounded by quotes. */
export function escapeLiteral(value: string): string {
  return value.replace(/'/g, "''")
}

/** One column-filter predicate. Postgres casts with `::text`+ILIKE; SQLite uses
 *  CAST(... AS TEXT)+LIKE (case-insensitive for ASCII). */
export function buildFilterPredicate(f: ColFilter, dialect: Dialect = 'postgres'): string {
  const v = escapeLiteral(f.value)
  const cast = dialect === 'sqlite' ? `CAST(${quoteIdent(f.col)} AS TEXT)` : `${quoteIdent(f.col)}::text`
  const contains = dialect === 'sqlite' ? 'LIKE' : 'ILIKE'
  switch (f.op) {
    case '~':  return `${cast} ${contains} '%${v}%'`
    case '!=': return `${cast} != '${v}'`
    case '>':  return `${cast} > '${v}'`
    case '<':  return `${cast} < '${v}'`
    default:   return `${cast} = '${v}'`
  }
}

/** Append LIMIT to a SELECT/WITH that has no top-level LIMIT. Mirrors the editor's
 *  original helper: ignores non-SELECT, ignores parenthesised (subquery) LIMITs. */
export function applyLimit(sql: string, limit: number): string {
  if (limit <= 0) return sql
  const s = sql.trim().replace(/;\s*$/, '').trimEnd()
  if (!/^(SELECT|WITH)\b/i.test(s)) return sql
  let depth = 0, stripped = ''
  for (const ch of s) {
    if (ch === '(') { depth++; stripped += ' ' }
    else if (ch === ')') { depth = Math.max(0, depth - 1); stripped += ' ' }
    else stripped += depth > 0 ? ' ' : ch
  }
  if (/\bLIMIT\b/i.test(stripped)) return sql
  return `${s}\nLIMIT ${limit}`
}

/** Build a `SELECT * FROM schema.table` with optional filters/sort/pagination. */
export function buildTableQuery(opts: {
  schema: string
  table: string
  sort?: Sort
  filters?: ColFilter[]
  limit: number
  offset?: number
  dialect?: Dialect
}): string {
  const { schema, table, sort, filters = [], limit, offset, dialect = 'postgres' } = opts
  let sql = `SELECT * FROM ${qualifiedRef(schema, table)}`
  const active = filters.filter(f => f.value.trim() !== '')
  if (active.length) sql += `\nWHERE ${active.map(f => buildFilterPredicate(f, dialect)).join(' AND ')}`
  if (sort) sql += `\nORDER BY ${quoteIdent(sort.col)} ${sort.dir.toUpperCase()}`
  if (limit > 0) {
    sql += `\nLIMIT ${limit}`
    if (offset && offset > 0) sql += ` OFFSET ${offset}`
  }
  return sql
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm test -- queryBuilder`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add src/lib/queryBuilder.ts src/lib/queryBuilder.test.ts
git commit -m "feat: dialect-aware pure SQL query builders"
```

---

## Task 3: Extract `ResultTable` into its own file

**Files:**
- Create: `src/components/ResultTable.tsx`
- Modify: `src/components/ResultsPane.tsx` (remove `ResultTable` body 56-334; import it)

This is a **pure move** — no logic changes.

- [ ] **Step 1: Create `ResultTable.tsx` with the moved component**

Create `src/components/ResultTable.tsx`. Put these imports at the top, then paste the **exact body of `ResultTable`** currently at `ResultsPane.tsx:56-334` (the `function ResultTable({ … }) { … }` block), changing only `function ResultTable` to `export default function ResultTable`:

```ts
import {
  useReactTable, getCoreRowModel,
  getFilteredRowModel,
  type ColumnDef,
} from '@tanstack/react-table'
import { useState, useMemo, useRef, useEffect } from 'react'
import { ChevronUp, ChevronDown, ChevronsUpDown, Loader2, XCircle, X, Edit2, Filter, Link } from 'lucide-react'
import type { QueryResult, ResultTab } from '@/lib/results'

// <-- paste ResultsPane.tsx lines 56-334 here, with `export default function ResultTable`
```

> If any of the listed lucide icons or tanstack imports turn out unused inside the moved block, remove them to satisfy the lint/`noUnusedLocals` check; if the block uses an import not listed here, add it. Verify against the build in Step 3.

- [ ] **Step 2: Wire ResultsPane to the extracted component**

In `src/components/ResultsPane.tsx`:
1. Delete the entire `function ResultTable(...) { ... }` block (old lines 56-334).
2. Add the import near the top:

```ts
import ResultTable from '@/components/ResultTable'
```

3. Remove now-unused imports from `ResultsPane.tsx`'s own top import list **only if** they are no longer referenced by the remaining `ResultsPane` code (e.g. tanstack hooks, some icons). Let the build in Step 3 tell you which.

- [ ] **Step 3: Verify build + existing tests**

Run: `npm run build && npm test`
Expected: PASS. The editor results grid behaves identically (pure move).

- [ ] **Step 4: Commit**

```bash
git add src/components/ResultTable.tsx src/components/ResultsPane.tsx
git commit -m "refactor: extract ResultTable into its own file"
```

---

## Task 4: `useTableData` hook (TDD)

**Files:**
- Create: `src/hooks/useTableData.ts`
- Test: `src/hooks/useTableData.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/hooks/useTableData.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))
import { invoke } from '@tauri-apps/api/core'
import { useTableData } from './useTableData'

const rows = (n: number) => Array.from({ length: n }, (_, i) => [i, `r${i}`])
const result = (n: number) => ({
  columns: [{ name: 'id', typeName: 'int' }, { name: 'name', typeName: 'text' }],
  rows: rows(n), executionMs: 1,
})

beforeEach(() => { vi.mocked(invoke).mockReset() })

describe('useTableData', () => {
  it('load() fetches rows and sets offset/hasMore', async () => {
    vi.mocked(invoke).mockResolvedValueOnce(result(200))
    const { result: h } = renderHook(() => useTableData('c1', 'public', 'users', 'postgres', 200))
    await act(async () => { await h.current.load() })
    expect(h.current.state.data?.rows.length).toBe(200)
    expect(h.current.state.offset).toBe(200)
    expect(h.current.state.hasMore).toBe(true)
    const sql = vi.mocked(invoke).mock.calls[0][1] as { sql: string }
    expect(sql.sql).toContain('SELECT * FROM "public"."users"')
  })

  it('loadMore() appends rows and advances offset', async () => {
    vi.mocked(invoke).mockResolvedValueOnce(result(200)).mockResolvedValueOnce(result(50))
    const { result: h } = renderHook(() => useTableData('c1', 'public', 'users', 'postgres', 200))
    await act(async () => { await h.current.load() })
    await act(async () => { await h.current.loadMore() })
    expect(h.current.state.data?.rows.length).toBe(250)
    expect(h.current.state.offset).toBe(250)
    expect(h.current.state.hasMore).toBe(false)
  })

  it('fkClick() pushes history and switches table; back() restores', async () => {
    vi.mocked(invoke).mockResolvedValue(result(1))
    const { result: h } = renderHook(() => useTableData('c1', 'public', 'users', 'postgres', 200))
    await act(async () => { await h.current.load() })
    await act(async () => { await h.current.fkClick('public.orders', 'user_id', '7') })
    expect(h.current.state.table).toBe('orders')
    expect(h.current.state.history.length).toBe(1)
    const fkSql = vi.mocked(invoke).mock.calls.at(-1)![1] as { sql: string }
    expect(fkSql.sql).toContain('"public"."orders"')
    expect(fkSql.sql).toContain(`"user_id"::text = '7'`)
    act(() => { h.current.back() })
    expect(h.current.state.table).toBe('users')
    expect(h.current.state.history.length).toBe(0)
  })

  it('load() surfaces an error string on failure', async () => {
    vi.mocked(invoke).mockRejectedValueOnce('pool timed out')
    const { result: h } = renderHook(() => useTableData('c1', 'public', 'users', 'postgres', 200))
    await act(async () => { await h.current.load() })
    expect(h.current.state.error).toContain('pool timed out')
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -- useTableData`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the hook**

Create `src/hooks/useTableData.ts`:

```ts
import { useState, useRef, useCallback } from 'react'
import { invoke } from '@tauri-apps/api/core'
import type { QueryResult } from '@/lib/results'
import { buildTableQuery, type Sort, type ColFilter, type Dialect } from '@/lib/queryBuilder'

export interface TableDataState {
  schema: string
  table: string
  data?: QueryResult
  error?: string
  running: boolean
  loadingMore: boolean
  sort?: Sort
  filters: ColFilter[]
  offset: number
  hasMore: boolean
  history: Array<Omit<TableDataState, 'history' | 'running' | 'loadingMore'>>
}

export interface UseTableData {
  state: TableDataState
  load: () => Promise<void>
  loadMore: () => Promise<void>
  setSort: (col: string | null, dir: 'asc' | 'desc') => Promise<void>
  setFilter: (col: string, value: string, op: string) => Promise<void>
  fkClick: (refTable: string, refCol: string, value: string) => Promise<void>
  back: () => void
}

const initial = (schema: string, table: string): TableDataState => ({
  schema, table, running: false, loadingMore: false, filters: [], offset: 0, hasMore: false, history: [],
})

export function useTableData(
  connectionId: string, schema: string, table: string, dialect: Dialect, limit: number,
): UseTableData {
  const [state, setState] = useState<TableDataState>(() => initial(schema, table))
  // Latest state for callbacks that read-then-write without re-creating on each change.
  const ref = useRef(state)
  ref.current = state

  // Run a fresh query for the given schema/table/sort/filters (offset 0).
  const run = useCallback(async (next: TableDataState) => {
    setState({ ...next, running: true, error: undefined })
    const sql = buildTableQuery({ schema: next.schema, table: next.table, sort: next.sort, filters: next.filters, limit, dialect })
    try {
      const data = await invoke<QueryResult>('execute_query', { connectionId, sql })
      setState(s => ({ ...s, running: false, data, offset: data.rows.length, hasMore: limit > 0 && data.rows.length >= limit }))
    } catch (e) {
      setState(s => ({ ...s, running: false, error: String(e) }))
    }
  }, [connectionId, limit, dialect])

  const load = useCallback(async () => {
    await run({ ...initial(ref.current.schema, ref.current.table), sort: ref.current.sort, filters: ref.current.filters, history: ref.current.history })
  }, [run])

  const loadMore = useCallback(async () => {
    const s = ref.current
    if (!s.data || !s.hasMore || s.loadingMore || s.running) return
    setState(p => ({ ...p, loadingMore: true }))
    const sql = buildTableQuery({ schema: s.schema, table: s.table, sort: s.sort, filters: s.filters, limit, offset: s.offset, dialect })
    try {
      const data = await invoke<QueryResult>('execute_query', { connectionId, sql })
      setState(p => p.data ? ({
        ...p, loadingMore: false,
        data: { ...data, rows: [...p.data.rows, ...data.rows] },
        offset: p.offset + data.rows.length, hasMore: limit > 0 && data.rows.length >= limit,
      }) : p)
    } catch {
      setState(p => ({ ...p, loadingMore: false }))
    }
  }, [connectionId, limit, dialect])

  const setSort = useCallback(async (col: string | null, dir: 'asc' | 'desc') => {
    const s = ref.current
    await run({ ...s, sort: col ? { col, dir } : undefined })
  }, [run])

  const setFilter = useCallback(async (col: string, value: string, op: string) => {
    const s = ref.current
    const filters = s.filters.filter(f => f.col !== col)
    if (value) filters.push({ col, value, op })
    await run({ ...s, filters })
  }, [run])

  const fkClick = useCallback(async (refTable: string, refCol: string, value: string) => {
    const s = ref.current
    const dot = refTable.indexOf('.')
    const nextSchema = dot >= 0 ? refTable.slice(0, dot) : s.schema
    const nextTable  = dot >= 0 ? refTable.slice(dot + 1) : refTable
    const { history: _h, running: _r, loadingMore: _l, ...snapshot } = s
    await run({
      schema: nextSchema, table: nextTable,
      sort: undefined, filters: [{ col: refCol, value, op: '=' }],
      running: false, loadingMore: false, offset: 0, hasMore: false,
      history: [...s.history, snapshot],
    })
  }, [run])

  const back = useCallback(() => {
    setState(s => {
      if (!s.history.length) return s
      const history = [...s.history]
      const prev = history.pop()!
      return { ...prev, running: false, loadingMore: false, history }
    })
  }, [])

  return { state, load, loadMore, setSort, setFilter, fkClick, back }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm test -- useTableData`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/hooks/useTableData.ts src/hooks/useTableData.test.ts
git commit -m "feat: useTableData hook (load/loadMore/sort/filter/fk/back)"
```

---

## Task 5: Data section in `TableDetailsTab`

**Files:**
- Modify: `src/components/TableDetailsTab.tsx`

- [ ] **Step 1: Add the `driver` prop and the `data` section entry**

In `src/components/TableDetailsTab.tsx`:

1. Extend the `Section` union (line 12) and `Props` (line 23), and add the sidebar entry + imports.

Replace the `Section` type line:

```ts
type Section = 'columns' | 'constraints' | 'foreign_keys' | 'indexes' | 'ddl' | 'properties' | 'data'
```

Add `Database` to the lucide import on line 3:

```ts
import { Loader2, XCircle, Key, Link, Table2, Code2, Info, Database } from 'lucide-react'
```

Add the imports for the grid + hook below the existing imports:

```ts
import ResultTable from '@/components/ResultTable'
import { useTableData } from '@/hooks/useTableData'
import { driverToDialect } from '@/lib/queryBuilder'
import type { ResultTab } from '@/lib/results'
```

Add a `data` entry to the `SECTIONS` array (after `columns`):

```ts
  { id: 'data',         label: 'Data',          icon: <Database size={13} /> },
```

Extend `Props`:

```ts
interface Props { connectionId: string; schema: string; table: string; driver?: string }

export default function TableDetailsTab({ connectionId, schema, table, driver }: Props) {
```

- [ ] **Step 2: Render the Data section**

In the "Section content" block (around lines 67-72), add the data branch:

```tsx
        {section === 'data'        && <TableDataSection connectionId={connectionId} schema={details.schema} table={details.table} driver={driver} foreignKeys={details.foreignKeys} />}
```

- [ ] **Step 3: Add the `TableDataSection` subcomponent**

At the bottom of `src/components/TableDetailsTab.tsx` (after `DdlSection`), add:

```tsx
import { useEffect } from 'react'  // add to the existing react import at top instead — see note

function TableDataSection({ connectionId, schema, table, driver, foreignKeys }: {
  connectionId: string; schema: string; table: string; driver?: string; foreignKeys: ForeignKeyDetail[]
}) {
  const td = useTableData(connectionId, schema, table, driverToDialect(driver), 200)

  // Lazy: fetch the first time this section mounts.
  useEffect(() => { td.load() }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // FK affordances derived from the table's own foreign keys.
  const fkColumns = new Set<string>()
  const fkRefs    = new Map<string, { table: string; col: string }>()
  for (const fk of foreignKeys) {
    fk.columns.forEach((c, i) => {
      fkColumns.add(c)
      if (!fkRefs.has(c)) fkRefs.set(c, { table: `${fk.refSchema}.${fk.refTable}`, col: fk.refColumns[i] ?? fk.refColumns[0] })
    })
  }

  const s = td.state
  if (s.running && !s.data) return <div className="flex items-center justify-center flex-1 gap-2 text-th-dim"><Loader2 size={16} className="animate-spin" />Loading…</div>
  if (s.error)   return <div className="flex items-center justify-center flex-1 gap-2" style={{ color: 'var(--error-text)' }}><XCircle size={16} />{s.error}</div>
  if (!s.data)   return null

  const tab: ResultTab = {
    id: 'tbl-data', title: `${s.schema}.${s.table}`, data: s.data,
    sortCol: s.sort?.col, sortDir: s.sort?.dir,
    colFilters: Object.fromEntries(s.filters.map(f => [f.col, f.value])),
    colFilterOps: Object.fromEntries(s.filters.map(f => [f.col, f.op])),
    offset: s.offset, hasMore: s.hasMore, loadingMore: s.loadingMore,
    history: s.history.length ? [{}] : undefined, // non-empty → grid shows the Back button
  }

  return (
    <div className="flex flex-col flex-1 min-w-0 overflow-hidden">
      <div className="px-4 py-1.5 text-[11px] text-th-dim shrink-0 flex items-center gap-2" style={{ borderBottom: '1px solid var(--border)', background: 'var(--sidebar-bg)' }}>
        <span className="font-semibold">{s.schema}.{s.table}</span>
        <span>{s.data.rows.length} row{s.data.rows.length !== 1 ? 's' : ''}{s.hasMore ? '+' : ''}</span>
      </div>
      <ResultTable
        result={s.data}
        tab={tab}
        fkColumns={fkColumns}
        fkRefs={fkRefs}
        onSort={(col, dir) => td.setSort(col, dir)}
        onColumnFilter={(col, value, op) => td.setFilter(col, value, op)}
        onFkClick={(refTable, refCol, value) => td.fkClick(refTable, refCol, value)}
        onBack={() => td.back()}
        onLoadMore={() => td.loadMore()}
      />
    </div>
  )
}
```

> **Import note:** `useEffect` and `useState` come from the file's existing top-level `import { useState, useEffect } from 'react'` (line 1) — do NOT add the inline `import { useEffect }` shown above; it is illustrative. Add `ForeignKeyDetail` is already declared in this file (line 7). `ResultTab`/`ResultTable`/`useTableData`/`driverToDialect` imports go at the top with the others (Step 1).

- [ ] **Step 4: Verify build**

Run: `npm run build`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/TableDetailsTab.tsx
git commit -m "feat: Data section in TableDetailsTab (browse rows, sort/filter/FK-nav)"
```

---

## Task 6: Pass `driver` to `TableDetailsTab`

**Files:**
- Modify: `src/components/EditorTabs.tsx` (the `table-details` render branch, ~line 714)

- [ ] **Step 1: Pass the driver**

In `src/components/EditorTabs.tsx`, update the `table-details` render branch to pass the connection's driver:

```tsx
        {active?.type === 'table-details' && active.connectionId && (
          <TableDetailsTab key={active.id} connectionId={active.connectionId}
            schema={(active as any).schema ?? 'public'} table={(active as any).table ?? ''}
            driver={connections.find(c => c.id === active.connectionId)?.driver} />
        )}
```

- [ ] **Step 2: Verify build**

Run: `npm run build`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/components/EditorTabs.tsx
git commit -m "feat: pass driver into TableDetailsTab for dialect-aware data queries"
```

---

## Task 7: Adopt shared builders in `EditorTabs`

**Files:**
- Modify: `src/components/EditorTabs.tsx` (`applyLimit` local def ~148; `handleColumnFilter` ~408-418; `handleSort` ~345)

- [ ] **Step 1: Import the builders**

In `src/components/EditorTabs.tsx`, add to the imports:

```ts
import { applyLimit, buildFilterPredicate, quoteIdent, driverToDialect } from '@/lib/queryBuilder'
```

- [ ] **Step 2: Remove the local `applyLimit`**

Delete the local `applyLimit` function (lines 148-160). The imported one is identical. (The call site `applyLimit(rawSql, limit)` in `runQuery` now uses the import.)

- [ ] **Step 3: Use `buildFilterPredicate` in `handleColumnFilter`**

In `handleColumnFilter`, replace the inline `conditions` mapping (lines 408-418) with:

```ts
    const dialect = driverToDialect(editorTab.driver)
    const conditions = Object.entries(newFilters)
      .filter(([, v]) => v.trim())
      .map(([c, v]) => buildFilterPredicate({ col: c, value: v, op: newOps[c] ?? '~' }, dialect))
```

And in the same function, quote the sort column in the ORDER BY tail (line 428 already quotes — leave as is).

- [ ] **Step 4: Quote the sort column in `handleSort`**

In `handleSort`, change line 345 from:

```ts
    if (col) newSql += `\nORDER BY ${col} ${dir.toUpperCase()}`
```

to:

```ts
    if (col) newSql += `\nORDER BY ${quoteIdent(col)} ${dir.toUpperCase()}`
```

And in `handleLoadMore`, change line 291 similarly:

```ts
    if (rt.sortCol) newSql += `\nORDER BY ${quoteIdent(rt.sortCol)} ${(rt.sortDir ?? 'asc').toUpperCase()}`
```

> `editorTab.driver` exists on the `Connection`-typed tab? The tab has `connectionId`; resolve the driver via `connections.find(c => c.id === editorTab.connectionId)?.driver`. Use that expression in place of `editorTab.driver` in Step 3.

- [ ] **Step 5: Verify build + full test suite**

Run: `npm run build && npm test`
Expected: PASS. Editor query/sort/filter/load-more behavior unchanged (now dialect-correct + consistently quoted).

- [ ] **Step 6: Commit**

```bash
git add src/components/EditorTabs.tsx
git commit -m "refactor: EditorTabs uses shared queryBuilder (dedup + dialect-correct filters)"
```

---

## Task 8: Full verification

**Files:** none (verification only)

- [ ] **Step 1: Frontend tests**

Run: `npm test`
Expected: PASS — `queryBuilder` + `useTableData` suites included.

- [ ] **Step 2: Type check + bundle**

Run: `npm run build`
Expected: PASS.

- [ ] **Step 3: Rust (unchanged, sanity)**

Run: `cd src-tauri && cargo test`
Expected: PASS (no backend changes).

- [ ] **Step 4: Manual smoke**

Run: `npm run tauri dev`
1. Open a table's details (cmd+click a table name or via the sidebar). Click **Data** → rows load.
2. Scroll to bottom → more rows load.
3. Click a column header → sorts (re-query).
4. Filter a column → rows filter (re-query).
5. Click a foreign-key cell → navigates to the referenced table's row(s); **Back** returns.
6. Repeat on a SQLite connection → filter uses `CAST(... AS TEXT) LIKE` (no `::text`/ILIKE error).

---

## Self-Review Notes

- **Spec coverage:** Data section + lazy load (Task 5) ✓; full sort/filter/load-more/FK (Tasks 4-5) ✓; FK in-place with back (Task 4 `fkClick`/`back`, Task 5 wiring) ✓; pure shared builders (Task 2) ✓; `ResultTable` extraction (Task 3) ✓; FK derivation from `details.foreignKeys` (Task 5) ✓; `EditorTabs` adopts builders (Task 7) ✓; identifier quoting + literal escaping for safety (Task 2) ✓; default limit 200 (Tasks 4-5) ✓.
- **Beyond spec (justified):** the spec's filter predicate was Postgres-only (`::text`/ILIKE); the Data section serves SQLite tables too, so builders are dialect-aware and `driver` is threaded into `TableDetailsTab` (Task 6) — prevents a new SQLite-filter regression. Noted in spec's testing section as a gate.
- **Type consistency:** `Sort`/`ColFilter`/`Dialect` defined in Task 2 are consumed unchanged in Task 4; `QueryResult`/`ResultTab` from `lib/results` (Task 1) used by Tasks 3-5; `ResultTable` props match the synthesized `ResultTab` in Task 5; `fkClick(refTable, refCol, value)` 3-arg signature is consistent between hook (Task 4) and grid wiring (Task 5 maps the grid's 4-arg `onFkClick` by dropping `newTab`).
- **Known limitation (documented, not a gap):** the grid's `onFkClick` passes a 4th `newTab` arg; the Data section ignores it (always in-place) per the locked decision.
