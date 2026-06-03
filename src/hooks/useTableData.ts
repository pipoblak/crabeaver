import { useState, useRef, useCallback } from 'react'
import type { QueryResult } from '@/lib/results'
import { buildTableQuery, type Sort, type ColFilter, type Dialect } from '@/lib/queryBuilder'
import { useTrackedQuery } from '@/hooks/useTrackedQuery'

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
  history: Snapshot[]
  // Forward stack: states popped off `history` by back(), restorable by forward().
  future: Snapshot[]
}

type Snapshot = Omit<TableDataState, 'history' | 'future' | 'running' | 'loadingMore'>

export interface UseTableData {
  state: TableDataState
  load: () => Promise<void>
  loadMore: () => Promise<void>
  setSort: (col: string | null, dir: 'asc' | 'desc') => Promise<void>
  setFilter: (col: string, value: string, op: string) => Promise<void>
  fkClick: (refTable: string, refCol: string, value: string) => Promise<void>
  back: () => void
  forward: () => void
}

// Cap on back/forward depth — each snapshot holds a full page of rows.
const MAX_HISTORY = 25

const initial = (schema: string, table: string): TableDataState => ({
  schema, table, running: false, loadingMore: false, filters: [], offset: 0, hasMore: false, history: [], future: [],
})

export function useTableData(
  connectionId: string, schema: string, table: string, dialect: Dialect, limit: number,
): UseTableData {
  const [state, setState] = useState<TableDataState>(() => initial(schema, table))
  // Latest state for callbacks that read-then-write without re-creating on each change.
  const ref = useRef(state)
  ref.current = state
  const trackedQuery = useTrackedQuery()

  // Run a fresh query for the given schema/table/sort/filters (offset 0).
  const run = useCallback(async (next: TableDataState) => {
    setState({ ...next, running: true, error: undefined })
    const sql = buildTableQuery({ schema: next.schema, table: next.table, sort: next.sort, filters: next.filters, limit, dialect })
    try {
      const data = await trackedQuery({ id: `tabledata:${next.schema}.${next.table}`, connectionId, sql })
      setState(s => ({ ...s, running: false, data, offset: data.rows.length, hasMore: limit > 0 && data.rows.length >= limit }))
    } catch (e) {
      setState(s => ({ ...s, running: false, error: String(e) }))
    }
  }, [connectionId, limit, dialect, trackedQuery])

  const load = useCallback(async () => {
    await run({ ...initial(ref.current.schema, ref.current.table), sort: ref.current.sort, filters: ref.current.filters, history: ref.current.history, future: ref.current.future })
  }, [run])

  const loadMore = useCallback(async () => {
    const s = ref.current
    if (!s.data || !s.hasMore || s.loadingMore || s.running) return
    setState(p => ({ ...p, loadingMore: true }))
    const sql = buildTableQuery({ schema: s.schema, table: s.table, sort: s.sort, filters: s.filters, limit, offset: s.offset, dialect })
    try {
      const data = await trackedQuery({ id: `tabledata-more:${s.schema}.${s.table}`, connectionId, sql })
      setState(p => p.data ? ({
        ...p, loadingMore: false,
        data: { ...data, rows: [...p.data.rows, ...data.rows] },
        offset: p.offset + data.rows.length, hasMore: limit > 0 && data.rows.length >= limit,
      }) : p)
    } catch {
      setState(p => ({ ...p, loadingMore: false }))
    }
  }, [connectionId, limit, dialect, trackedQuery])

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
    const { history: _h, future: _f, running: _r, loadingMore: _l, ...snapshot } = s
    await run({
      schema: nextSchema, table: nextTable,
      sort: undefined, filters: [{ col: refCol, value, op: '=' }],
      running: false, loadingMore: false, offset: 0, hasMore: false,
      // A new branch invalidates any forward history.
      history: [...s.history, snapshot].slice(-MAX_HISTORY), future: [],
    })
  }, [run])

  const back = useCallback(() => {
    setState(s => {
      if (!s.history.length) return s
      const history = [...s.history]
      const prev = history.pop()!
      const { history: _h, future: _f, running: _r, loadingMore: _l, ...cur } = s
      return { ...prev, running: false, loadingMore: false, history, future: [...s.future, cur].slice(-MAX_HISTORY) }
    })
  }, [])

  const forward = useCallback(() => {
    setState(s => {
      if (!s.future.length) return s
      const future = [...s.future]
      const next = future.pop()!
      const { history: _h, future: _f, running: _r, loadingMore: _l, ...cur } = s
      return { ...next, running: false, loadingMore: false, history: [...s.history, cur].slice(-MAX_HISTORY), future }
    })
  }, [])

  return { state, load, loadMore, setSort, setFilter, fkClick, back, forward }
}
