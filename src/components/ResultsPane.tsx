import {
  useReactTable, getCoreRowModel,
  getFilteredRowModel,
  type ColumnDef,
} from '@tanstack/react-table'
import { useState, useMemo, useRef, useEffect } from 'react'
import { ChevronUp, ChevronDown, ChevronsUpDown, Loader2, XCircle, X, Edit2, Filter, Link } from 'lucide-react'

interface ColumnInfo { name: string; typeName: string }

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

interface Props {
  tabs:         ResultTab[]
  activeId:     string | null
  onSetActive:  (id: string) => void
  onCloseTab:   (id: string) => void
  onRenameTab:  (id: string, title: string) => void
  onReorderTab: (fromIdx: number, toIdx: number) => void
  fkColumns?:     Set<string>
  fkRefs?:        Map<string, { table: string; col: string }>
  onFkClick?:     (resultTabId: string, refTable: string, refCol: string, value: string, newTab: boolean) => void
  onBack?:        (resultTabId: string) => void
  onSort:         (resultTabId: string, col: string | null, dir: 'asc' | 'desc') => void
  onColumnFilter: (resultTabId: string, col: string, value: string, op: string) => void
  onLoadMore:     (resultTabId: string) => void
  onEditSql:    (resultTabId: string, sql: string) => void
  elapsed:      Map<string, number>  // resultTabId → start timestamp
}

// ── Table display ─────────────────────────────────────────────────────────

function ResultTable({ result, tab, fkColumns, fkRefs, onSort, onColumnFilter, onFkClick, onBack, onLoadMore }: {
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

// ── SQL preview bar ───────────────────────────────────────────────────────

function SqlPreview({ sql, tabId, onEdit }: { sql: string; tabId: string; onEdit: (id: string, sql: string) => void }) {
  const [hovered,  setHovered]  = useState(false)
  const [expanded, setExpanded] = useState(false)

  const preview = sql.replace(/\s+/g, ' ').trim()
  const truncated = preview.length > 120 ? preview.slice(0, 120) + '…' : preview

  return (
    <div className="shrink-0 relative" style={{ borderBottom: '1px solid var(--border)', background: 'var(--sidebar-bg)' }}
      onMouseEnter={() => setHovered(true)} onMouseLeave={() => { setHovered(false); setExpanded(false) }}>
      <div className="flex items-center gap-2 px-3" style={{ height: 22, cursor: 'default' }}
        onClick={() => setExpanded(e => !e)}>
        <span className="text-[10px] font-mono text-th-dim truncate flex-1">{truncated}</span>
        {hovered && (
          <button title="Edit SQL" className="text-th-dim hover:text-th-accent shrink-0"
            onClick={e => { e.stopPropagation(); onEdit(tabId, sql) }}>
            <Edit2 size={10} />
          </button>
        )}
      </div>
      {expanded && (
        <div className="absolute left-0 right-0 z-10 p-2 text-[11px] font-mono"
          style={{ background: 'var(--sidebar-bg)', border: '1px solid var(--border)',
                   boxShadow: '0 4px 12px rgba(0,0,0,0.3)', whiteSpace: 'pre-wrap', maxHeight: 200, overflow: 'auto' }}>
          {sql}
        </div>
      )}
    </div>
  )
}

// ── Main component ─────────────────────────────────────────────────────────

export default function ResultsPane({
  tabs, activeId, fkColumns, fkRefs, onSetActive, onCloseTab, onRenameTab, onReorderTab,
  onFkClick, onBack, onSort, onColumnFilter, onLoadMore, onEditSql, elapsed,
}: Props) {
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editTitle, setEditTitle] = useState('')
  const [dragIdx,   setDragIdx]   = useState<number | null>(null)
  const [dropIdx,   setDropIdx]   = useState<number | null>(null)
  const dragSrc         = useRef<number | null>(null)
  const dropTarget      = useRef<number | null>(null)
  const onFkClickPRef   = useRef(onFkClick)
  const onBackPRef      = useRef(onBack)
  useEffect(() => { onFkClickPRef.current = onFkClick }, [onFkClick])
  useEffect(() => { onBackPRef.current    = onBack    }, [onBack])

  const activeTab = tabs.find(t => t.id === activeId)

  const startRename = (t: ResultTab) => { setEditingId(t.id); setEditTitle(t.title) }
  const commitRename = (id: string) => {
    if (editTitle.trim()) onRenameTab(id, editTitle.trim())
    setEditingId(null)
  }

  // Mouse-event drag — more reliable than HTML5 drag API in React
  const startDrag = (e: React.MouseEvent, idx: number) => {
    if (e.button !== 0) return
    e.preventDefault()
    dragSrc.current    = idx
    dropTarget.current = idx
    setDragIdx(idx)

    const onMove = (ev: MouseEvent) => {
      // Find which tab we're hovering by querying tab elements
      const els = document.querySelectorAll('[data-result-tab-idx]')
      for (const el of els) {
        const r = el.getBoundingClientRect()
        const i = Number((el as HTMLElement).dataset.resultTabIdx)
        if (ev.clientX >= r.left && ev.clientX <= r.right) {
          if (dropTarget.current !== i) { dropTarget.current = i; setDropIdx(i) }
          break
        }
      }
    }
    const onUp = () => {
      const from = dragSrc.current
      const to   = dropTarget.current
      if (from !== null && to !== null && from !== to) onReorderTab(from, to)
      dragSrc.current = null; dropTarget.current = null
      setDragIdx(null); setDropIdx(null)
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup',   onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup',   onUp)
  }

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Result tab bar */}
      <div className="flex items-center shrink-0 overflow-x-auto"
        style={{ background: 'var(--sidebar-bg)', borderBottom: '1px solid var(--border)' }}>
        {tabs.map((t, idx) => {
          const isActive  = t.id === activeId
          const isDragged = dragIdx === idx
          const isTarget  = dropIdx !== null && dropIdx === idx && dragIdx !== idx
          return (
            <div key={t.id}
              data-result-tab-idx={idx}
              onMouseDown={e => startDrag(e, idx)}
              onClick={() => { if (dragSrc.current === null) onSetActive(t.id) }}
              onDoubleClick={() => startRename(t)}
              className="group flex items-center gap-1 shrink-0 select-none"
              style={{
                height: 28, padding: '0 8px 0 10px', fontSize: 11,
                borderRight: '1px solid var(--border)',
                cursor: dragIdx !== null ? 'grabbing' : 'pointer',
                background: isActive ? 'var(--bg)' : 'transparent',
                color: isActive ? 'var(--text-bright)' : 'var(--text-dim)',
                borderTop: isActive ? '1px solid var(--tab-accent)' : '1px solid transparent',
                opacity: isDragged ? 0.5 : 1,
                outline: isTarget ? '2px solid var(--tab-accent)' : 'none',
              }}>
              {t.running && <Loader2 size={10} className="animate-spin shrink-0" />}
              {editingId === t.id ? (
                <input autoFocus value={editTitle} onChange={e => setEditTitle(e.target.value)}
                  onBlur={() => commitRename(t.id)}
                  onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur(); if (e.key === 'Escape') setEditingId(null) }}
                  onMouseDown={e => e.stopPropagation()}
                  onClick={e => e.stopPropagation()}
                  className="bg-transparent outline outline-1 outline-th-accent px-1 w-20" style={{ fontSize: 11 }} />
              ) : <span>{t.title}</span>}
              <button
                className="flex items-center justify-center w-4 h-4 rounded transition-colors"
                style={{ flexShrink: 0, color: 'var(--text-dim)', background: 'transparent', border: 'none', cursor: 'pointer', padding: 0 }}
                onMouseEnter={e => (e.currentTarget.style.color = 'var(--text-bright)')}
                onMouseLeave={e => (e.currentTarget.style.color = 'var(--text-dim)')}
                onMouseDown={e => e.stopPropagation()}
                onClick={e => { e.stopPropagation(); onCloseTab(t.id) }}>
                <X size={10} />
              </button>
            </div>
          )
        })}
      </div>

      {/* SQL preview */}
      {activeTab?.sql && (
        <SqlPreview sql={activeTab.sql} tabId={activeTab.id} onEdit={onEditSql} />
      )}

      {/* Content */}
      <div className="flex-1 min-h-0 overflow-hidden">
        {!activeTab || activeTab.running ? (
          <div className="flex items-center justify-center h-full gap-2 text-th-dim text-[13px]">
            {activeTab?.running ? (
              <>
                <Loader2 size={14} className="animate-spin" />
                <span>Running…</span>
                {elapsed.has(activeTab.id) && (
                  <span className="text-[11px] font-mono">
                    {((Date.now() - elapsed.get(activeTab.id)!) / 1000).toFixed(1)}s
                  </span>
                )}
              </>
            ) : (
              <span className="text-[12px]">Press <kbd className="mx-1 px-1.5 py-0.5 rounded text-[11px]"
                style={{ background: 'var(--hover)', border: '1px solid var(--border)' }}>⌘↵</kbd>to run</span>
            )}
          </div>
        ) : activeTab.error ? (
          <div className="flex items-start gap-2 p-4 text-[12px]" style={{ color: 'var(--error-text, #f87171)' }}>
            <XCircle size={14} className="shrink-0 mt-0.5" />
            <pre className="whitespace-pre-wrap font-mono">{activeTab.error}</pre>
          </div>
        ) : activeTab.data ? (
          <ResultTable key={activeTab.id} result={activeTab.data} tab={activeTab}
            fkColumns={fkColumns} fkRefs={fkRefs}
            onSort={(col, dir) => onSort(activeTab.id, col, dir)}
            onColumnFilter={(col, val, op) => onColumnFilter(activeTab.id, col, val, op)}
            onFkClick={(table, col, val, newTab) => onFkClickPRef.current?.(activeTab.id, table, col, val, newTab)}
            onBack={() => onBackPRef.current?.(activeTab.id)}
            onLoadMore={activeTab.hasMore !== false ? () => onLoadMore(activeTab.id) : undefined} />
        ) : (
          <div className="flex items-center justify-center h-full text-th-dim text-[12px]">
            Press <kbd className="mx-1 px-1.5 py-0.5 rounded text-[11px]"
              style={{ background: 'var(--hover)', border: '1px solid var(--border)' }}>⌘↵</kbd> to run
          </div>
        )}
      </div>
    </div>
  )
}
