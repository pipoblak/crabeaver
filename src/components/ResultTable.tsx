import {
  useReactTable, getCoreRowModel,
  getFilteredRowModel,
  type ColumnDef,
} from '@tanstack/react-table'
import { useState, useMemo, useRef, useEffect } from 'react'
import { ChevronUp, ChevronDown, ChevronsUpDown, Loader2, Filter, Link } from 'lucide-react'
import type { QueryResult, ResultTab } from '@/lib/results'

export default function ResultTable({ result, tab, fkColumns, fkRefs, onSort, onColumnFilter, onFkClick, onBack, onLoadMore }: {
  result:          QueryResult
  tab:             ResultTab
  fkColumns?:      Set<string>
  fkRefs?:         Map<string, { table: string; col: string }>
  onSort:          (col: string | null, dir: 'asc' | 'desc') => void
  onColumnFilter?: (col: string, value: string, op: string) => void
  onFkClick?:      (refTable: string, refCol: string, value: string, newTab: boolean) => void
  onBack?:         () => void
  onLoadMore?:     () => void
}) {
  const [globalFilter,   setGlobalFilter]  = useState('')
  const [localFilters,   setLocalFilters]  = useState<Record<string, string>>(tab.colFilters ?? {})
  const [localOps,       setLocalOps]      = useState<Record<string, string>>(tab.colFilterOps ?? {})
  const filterTimers       = useRef<Record<string, ReturnType<typeof setTimeout>>>({})
  const onColumnFilterRef  = useRef(onColumnFilter)
  const onBackRef          = useRef(onBack)
  const onFkClickRef       = useRef(onFkClick)
  useEffect(() => { onColumnFilterRef.current = onColumnFilter }, [onColumnFilter])
  useEffect(() => { onBackRef.current = onBack },             [onBack])
  useEffect(() => { onFkClickRef.current = onFkClick },       [onFkClick])

  useEffect(() => {
    setLocalFilters(tab.colFilters ?? {})
    setLocalOps(tab.colFilterOps ?? {})
  }, [tab.id])
  const [filterPopup,   setFilterPopup]   = useState<string | null>(null) // column id

  useEffect(() => {
    if (!filterPopup) return
    const close = () => setFilterPopup(null)
    window.addEventListener('click', close)
    return () => window.removeEventListener('click', close)
  }, [filterPopup])
  const scrollRef      = useRef<HTMLDivElement>(null)
const loadingRef     = useRef(false)
  const onLoadMoreRef  = useRef(onLoadMore)

  // Keep callback ref fresh so scroll handler never has a stale closure
  useEffect(() => { onLoadMoreRef.current = onLoadMore }, [onLoadMore])
  useEffect(() => { loadingRef.current = !!tab.loadingMore }, [tab.loadingMore])

  useEffect(() => {
    const el = scrollRef.current
    // Never reference onLoadMore directly here — only via ref to avoid stale closure errors
    if (!el || tab.hasMore === false) return

    const check = () => {
      if (loadingRef.current || !onLoadMoreRef.current) return
      const remaining = el.scrollHeight - el.scrollTop - el.clientHeight
      if (remaining < 200) {
        loadingRef.current = true
        onLoadMoreRef.current()
      }
    }

    el.addEventListener('scroll', check, { passive: true })
    check()
    return () => el.removeEventListener('scroll', check)
  }, [tab.hasMore])

  // Sorting is query-side — track locally for icon display only
  const sortCol = tab.sortCol ?? null
  const sortDir = tab.sortDir ?? 'asc'

  const handleHeaderClick = (col: string) => {
    if (sortCol === col) {
      if (sortDir === 'asc')  onSort(col, 'desc')
      else                    onSort(null, 'asc')  // third click: remove sort
    } else {
      onSort(col, 'asc')
    }
  }

  const handleFilterChange = (col: string, value: string, op?: string) => {
    const activeOp = op ?? localOps[col] ?? '~'
    setLocalFilters(prev => ({ ...prev, [col]: value }))
    if (op) setLocalOps(prev => ({ ...prev, [col]: op }))
    if (filterTimers.current[col]) clearTimeout(filterTimers.current[col])
    filterTimers.current[col] = setTimeout(() => onColumnFilterRef.current?.(col, value, activeOp), 600)
  }

  const handleOpChange = (col: string, op: string) => {
    setLocalOps(prev => ({ ...prev, [col]: op }))
    // Re-run immediately with new op if there's an active filter value
    const val = localFilters[col]
    if (val) {
      if (filterTimers.current[col]) clearTimeout(filterTimers.current[col])
      onColumnFilterRef.current?.(col, val, op)
    }
  }

  const columns = useMemo<ColumnDef<unknown[]>[]>(() => result.columns.map((col, i) => ({
    id:         col.name,
    accessorFn: (row: unknown[]) => row[i],
    header:     col.name,
    meta:       { typeName: col.typeName },
  })), [result.columns])

  const table = useReactTable({
    data:    result.rows,
    columns,
    state:   { globalFilter },
    onGlobalFilterChange: setGlobalFilter,
    getCoreRowModel:      getCoreRowModel(),
    getFilteredRowModel:  getFilteredRowModel(),
    // Sorting and column filtering are query-side
  })

  const rows  = table.getRowModel().rows
  const total = result.rows.length

  if (result.affectedRows !== undefined && result.affectedRows !== null) {
    return (
      <div className="flex items-center gap-2 p-4 text-[12px] text-th-dim">
        ✓ {result.affectedRows} row{result.affectedRows !== 1 ? 's' : ''} affected
        <span className="ml-auto">{result.executionMs}ms</span>
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Status bar */}
      <div className="flex items-center gap-3 px-3 shrink-0 text-[11px] text-th-dim"
        style={{ height: 26, borderBottom: '1px solid var(--border)', background: 'var(--sidebar-bg)' }}>
        {tab.history?.length ? (
          <button onClick={() => onBackRef.current?.()}
            className="flex items-center gap-1 text-th-dim hover:text-th-accent transition-colors text-[11px]"
            title="Go back">
            ← back
          </button>
        ) : null}
        <span>{total} row{total !== 1 ? 's' : ''}</span>
        <span>{result.columns.length} col{result.columns.length !== 1 ? 's' : ''}</span>
        <span className="ml-auto">{result.executionMs}ms</span>
        <input value={globalFilter} onChange={e => setGlobalFilter(e.target.value)} placeholder="filter all…"
          className="text-[11px] bg-transparent outline-none"
          style={{ borderBottom: '1px solid var(--border)', color: 'var(--text)', width: 120, padding: '1px 4px' }} />
      </div>

      {/* Table */}
      <div ref={scrollRef} className="flex-1 overflow-auto" style={{ overscrollBehavior: 'none' }}>
        <table className="text-[12px] border-collapse" style={{ width: 'max-content', minWidth: '100%' }}>
          <thead style={{ position: 'sticky', top: 0, zIndex: 2, background: 'var(--sidebar-bg)' }}>
            {table.getHeaderGroups().map(hg => (
              <tr key={hg.id}>
                {hg.headers.map(h => {
                  const isSort = sortCol === h.column.id
                  return (
                    <th key={h.id}
                      style={{ padding: '4px 10px', borderBottom: '1px solid var(--border)',
                               borderRight: '1px solid var(--border)', textAlign: 'left',
                               userSelect: 'none', whiteSpace: 'nowrap', position: 'relative' }}>
                      <div className="flex items-center gap-1">
                        <div className="flex items-center gap-1 cursor-pointer flex-1"
                          onClick={() => handleHeaderClick(h.column.id)}>
                          {fkColumns?.has(h.column.id) && (
                            <Link size={9} className="text-th-dim shrink-0" />
                          )}
                          <span className="font-semibold text-th-bright">{h.column.id}</span>
                          <span className="text-th-dim" style={{ fontSize: 10 }}>
                            {(h.column.columnDef.meta as { typeName?: string })?.typeName ?? ''}
                          </span>
                          {isSort && sortDir === 'asc'  ? <ChevronUp size={11} style={{ color: 'var(--tab-accent)' }} />
                           : isSort && sortDir === 'desc' ? <ChevronDown size={11} style={{ color: 'var(--tab-accent)' }} />
                           : <ChevronsUpDown size={11} className="text-th-dim opacity-40" />}
                        </div>
                        {/* Filter icon — accent-colored when active */}
                        <button
                          onClick={e => { e.stopPropagation(); setFilterPopup(p => p === h.column.id ? null : h.column.id) }}
                          style={{ color: localFilters[h.column.id] ? 'var(--tab-accent)' : 'var(--text-dim)', lineHeight: 0 }}>
                          <Filter size={10} />
                        </button>
                      </div>
                      {/* Filter popup */}
                      {filterPopup === h.column.id && (
                        <div style={{ position: 'absolute', top: '100%', left: 0, zIndex: 20,
                                      background: 'var(--sidebar-bg)', border: '1px solid var(--border)',
                                      borderRadius: 4, padding: '6px 8px', boxShadow: '0 4px 12px rgba(0,0,0,0.3)',
                                      minWidth: 160 }}
                          onClick={e => e.stopPropagation()}>
                          {/* Operator selector */}
                          <div className="flex gap-1 mb-2">
                            {(['~', '=', '!=', '>', '<'] as const).map(op => (
                              <button key={op}
                                onClick={() => handleOpChange(h.column.id, op)}
                                className="text-[10px] px-1.5 py-0.5 rounded transition-colors"
                                style={{
                                  background: (localOps[h.column.id] ?? '~') === op ? 'var(--tab-accent)' : 'var(--hover)',
                                  color:      (localOps[h.column.id] ?? '~') === op ? '#fff' : 'var(--text-dim)',
                                  border:     '1px solid var(--border)',
                                }}>
                                {op === '~' ? 'contains' : op}
                              </button>
                            ))}
                          </div>
                          <input
                            autoFocus
                            value={localFilters[h.column.id] ?? ''}
                            onChange={e => handleFilterChange(h.column.id, e.target.value)}
                            onKeyDown={e => e.key === 'Escape' && setFilterPopup(null)}
                            placeholder={`Filter ${h.column.id}…`}
                            className="text-[11px] bg-transparent outline-none w-full"
                            style={{ borderBottom: '1px solid var(--border)', color: 'var(--text)', padding: '2px 0' }}
                          />
                          {localFilters[h.column.id] && (
                            <button className="text-[10px] text-th-dim hover:text-th-accent mt-1 block"
                              onClick={() => { handleFilterChange(h.column.id, ''); setFilterPopup(null) }}>
                              clear
                            </button>
                          )}
                        </div>
                      )}
                    </th>
                  )
                })}
              </tr>
            ))}
          </thead>
          <tbody>
            {rows.map((row, ri) => (
              <tr key={row.id} style={{ background: ri % 2 === 0 ? 'transparent' : 'var(--hover)' }}
                className="hover:bg-th-hover transition-colors">
                {row.getVisibleCells().map(cell => {
                  const val    = cell.getValue()
                  const colId  = cell.column.id
                  const isFk   = fkColumns?.has(colId) && val !== null && val !== undefined
                  const fkRef  = isFk ? fkRefs?.get(colId) : undefined
                  const display = val === null    ? 'NULL'
                                : val === true    ? 'true'
                                : val === false   ? 'false'
                                : typeof val === 'object' ? JSON.stringify(val)
                                : String(val ?? '')
                  return (
                    <td key={cell.id}
                      style={{ padding: '3px 10px', borderBottom: '1px solid var(--border)',
                               borderRight: '1px solid var(--border)', whiteSpace: 'nowrap',
                               maxWidth: 400, overflow: 'hidden', textOverflow: 'ellipsis',
                               color: val === null ? 'var(--text-dim)' : 'var(--text)' }}>
                      {isFk && fkRef ? (
                        <span
                          title={`Go to ${fkRef.table} (⌘click = new tab)`}
                          style={{ cursor: 'pointer', textDecoration: 'underline dotted', textUnderlineOffset: 2 }}
                          onClick={e => onFkClickRef.current?.(fkRef.table, fkRef.col, String(val), e.metaKey || e.ctrlKey)}>
                          {display}
                        </span>
                      ) : display}
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
        {tab.loadingMore && (
          <div className="flex items-center justify-center gap-2 py-3 text-[11px] text-th-dim">
            <Loader2 size={12} className="animate-spin" />
            Loading more…
          </div>
        )}
        {tab.hasMore && !tab.loadingMore && (
          <div className="flex justify-center py-2">
            <button onClick={() => onLoadMoreRef.current?.()}
              className="text-[11px] text-th-dim hover:text-th-accent transition-colors px-3 py-1 rounded"
              style={{ border: '1px solid var(--border)' }}>
              Load more
            </button>
          </div>
        )}
        {tab.hasMore === false && result.rows.length > 0 && (
          <div className="flex items-center justify-center py-2 text-[10px] text-th-dim">
            — end of results —
          </div>
        )}
      </div>
    </div>
  )
}
