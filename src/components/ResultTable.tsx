import {
  useReactTable, getCoreRowModel,
  getFilteredRowModel,
  type ColumnDef,
} from '@tanstack/react-table'
import { useState, useMemo, useRef, useEffect } from 'react'
import { ChevronUp, ChevronDown, ChevronsUpDown, Loader2, Filter, Link, Copy, Check, Download, ExternalLink } from 'lucide-react'
import { invoke } from '@tauri-apps/api/core'
import type { QueryResult, ResultTab } from '@/lib/results'
import { timeAgo } from '@/lib/timeAgo'
import { formatResult, exportFilename, type ExportFormat } from '@/lib/clipboardExport'

export default function ResultTable({ result, tab, fkColumns, fkRefs, onSort, onColumnFilter, onFkClick, onBack, onForward, onLoadMore, fetchAll }: {
  result:          QueryResult
  tab:             ResultTab
  fkColumns?:      Set<string>
  fkRefs?:         Map<string, { table: string; col: string }>
  onSort:          (col: string | null, dir: 'asc' | 'desc') => void
  onColumnFilter?: (col: string, value: string, op: string) => void
  onFkClick?:      (refTable: string, refCol: string, value: string, newTab: boolean) => void
  onBack?:         () => void
  onForward?:      () => void
  onLoadMore?:     () => void
  /** Fetch the FULL result set (no row limit) for download. Falls back to the
   *  currently-loaded rows when omitted. */
  fetchAll?:       () => Promise<QueryResult>
}) {
  const [globalFilter,   setGlobalFilter]  = useState('')
  const [localFilters,   setLocalFilters]  = useState<Record<string, string>>(tab.colFilters ?? {})
  const [localOps,       setLocalOps]      = useState<Record<string, string>>(tab.colFilterOps ?? {})
  const filterTimers       = useRef<Record<string, ReturnType<typeof setTimeout>>>({})
  const onColumnFilterRef  = useRef(onColumnFilter)
  const onBackRef          = useRef(onBack)
  const onForwardRef       = useRef(onForward)
  const onFkClickRef       = useRef(onFkClick)
  useEffect(() => { onColumnFilterRef.current = onColumnFilter }, [onColumnFilter])
  useEffect(() => { onBackRef.current = onBack },             [onBack])
  useEffect(() => { onForwardRef.current = onForward },       [onForward])
  useEffect(() => { onFkClickRef.current = onFkClick },       [onFkClick])

  // Back/forward shortcuts (⌘/Ctrl + [ and ]) — scoped to the result body so they
  // never collide with Monaco's outdent (⌘[) while editing. The scroll container
  // is focusable; clicking the table focuses it.
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!(e.metaKey || e.ctrlKey) || e.altKey) return
    // ⌘/Ctrl+C copies selected rows (only when rows are selected — otherwise let
    // the browser copy any highlighted text).
    if (e.key === 'c' && hasSelection) { e.preventDefault(); copySelected() }
    // ⌘/Ctrl+A selects every row in the result (clears any cell selection).
    if (e.key === 'a') { e.preventDefault(); setSelected(new Set(rows.map(r => r.id))); setSelCells(new Set()) }
    if (e.shiftKey) return
    if (e.key === '[') { e.preventDefault(); onBackRef.current?.() }
    else if (e.key === ']') { e.preventDefault(); onForwardRef.current?.() }
  }

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

  // Copy-all dropdown (CSV / JSON / Text).
  const [copyMenu, setCopyMenu] = useState(false)
  const [copied,   setCopied]   = useState<ExportFormat | null>(null)
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    if (!copyMenu) return
    const close = () => setCopyMenu(false)
    window.addEventListener('click', close)
    return () => window.removeEventListener('click', close)
  }, [copyMenu])
  useEffect(() => () => { if (copiedTimer.current) clearTimeout(copiedTimer.current) }, [])

  const copyAs = async (fmt: ExportFormat) => {
    setCopyMenu(false)
    try {
      await navigator.clipboard.writeText(formatResult(result, fmt))
      setCopied(fmt)
      if (copiedTimer.current) clearTimeout(copiedTimer.current)
      copiedTimer.current = setTimeout(() => setCopied(null), 1500)
    } catch { /* clipboard unavailable */ }
  }

  // Download-all dropdown (CSV / JSON / Text) — fetches the FULL result set.
  const [downloadMenu, setDownloadMenu] = useState(false)
  const [downloading,  setDownloading]  = useState(false)
  const [saved,        setSaved]        = useState<string | null>(null)
  const savedTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    if (!downloadMenu) return
    const close = () => setDownloadMenu(false)
    window.addEventListener('click', close)
    return () => window.removeEventListener('click', close)
  }, [downloadMenu])
  useEffect(() => () => { if (savedTimer.current) clearTimeout(savedTimer.current) }, [])

  const downloadAs = async (fmt: ExportFormat) => {
    setDownloadMenu(false)
    setDownloading(true)
    setSaved(null)
    try {
      const data = fetchAll ? await fetchAll() : result
      const path = await invoke<string>('save_to_downloads', {
        filename: exportFilename(tab.title, fmt),
        contents: formatResult(data, fmt),
      })
      setSaved(path)
      if (savedTimer.current) clearTimeout(savedTimer.current)
      savedTimer.current = setTimeout(() => setSaved(null), 4000)
    } catch { /* save failed (e.g. directory unavailable) */ }
    finally { setDownloading(false) }
  }
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

  // ── Selection ─────────────────────────────────────────────────────────────
  // Two modes, mutually exclusive: click the row NUMBER to select whole rows
  // (⌘/Ctrl-click toggles, Shift-click ranges); click a CELL to select that cell
  // (⌘/Ctrl-click toggles individual cells). Cleared when the result changes.
  // ⌘/Ctrl+C copies the current selection (rows → TSV grid, cells → values).
  const [selected, setSelected]   = useState<Set<string>>(new Set())   // row ids
  const [selCells, setSelCells]   = useState<Set<string>>(new Set())   // `${rowId}::${colId}`
  const anchorRef = useRef<string | null>(null)
  useEffect(() => { setSelected(new Set()); setSelCells(new Set()); anchorRef.current = null }, [tab.id, result])

  const cellKey = (rowId: string, colId: string) => `${rowId}::${colId}`

  const selectRow = (e: React.MouseEvent, rowId: string, displayIdx: number) => {
    setSelCells(new Set())
    setSelected(prev => {
      if (e.shiftKey && anchorRef.current !== null) {
        const a = rows.findIndex(r => r.id === anchorRef.current)
        if (a >= 0) {
          const [lo, hi] = a <= displayIdx ? [a, displayIdx] : [displayIdx, a]
          return new Set(rows.slice(lo, hi + 1).map(r => r.id))
        }
      }
      const next = new Set(prev)
      if (e.metaKey || e.ctrlKey) {
        if (next.has(rowId)) next.delete(rowId); else next.add(rowId)
      } else {
        next.clear()
        next.add(rowId)
      }
      anchorRef.current = rowId
      return next
    })
  }

  const selectCell = (e: React.MouseEvent, rowId: string, colId: string) => {
    setSelected(new Set())
    anchorRef.current = null
    setSelCells(prev => {
      const key = cellKey(rowId, colId)
      const next = new Set(prev)
      if (e.metaKey || e.ctrlKey) {
        if (next.has(key)) next.delete(key); else next.add(key)
      } else {
        next.clear()
        next.add(key)
      }
      return next
    })
  }

  const hasSelection = selected.size > 0 || selCells.size > 0
  const copySelected = () => {
    if (selected.size) {
      const picked = rows.filter(r => selected.has(r.id)).map(r => r.original as unknown[])
      navigator.clipboard.writeText(formatResult({ ...result, rows: picked }, 'text')).catch(() => {})
    } else if (selCells.size) {
      // Copy selected cell values in display order (row-major), tab/newline joined.
      const colIds = result.columns.map(c => c.name)
      const lines = rows.flatMap(r => {
        const vals = colIds
          .filter(c => selCells.has(cellKey(r.id, c)))
          .map(c => { const v = (r.original as unknown[])[colIds.indexOf(c)]; return v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v) })
        return vals.length ? [vals.join('\t')] : []
      })
      navigator.clipboard.writeText(lines.join('\n')).catch(() => {})
    }
  }

  if (result.affectedRows !== undefined && result.affectedRows !== null) {
    return (
      <div className="flex items-center gap-2 p-4 text-[12px] text-th-dim">
        ✓ {result.affectedRows} row{result.affectedRows !== 1 ? 's' : ''} affected
        <span className="ml-auto">{tab.ranAt ? `${timeAgo(tab.ranAt)} · ` : ''}{result.executionMs}ms</span>
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
            title="Go back (⌘[)">
            ← back
          </button>
        ) : null}
        {tab.future?.length ? (
          <button onClick={() => onForwardRef.current?.()}
            className="flex items-center gap-1 text-th-dim hover:text-th-accent transition-colors text-[11px]"
            title="Go forward (⌘])">
            forward →
          </button>
        ) : null}
        <span>{total} row{total !== 1 ? 's' : ''}</span>
        <span>{result.columns.length} col{result.columns.length !== 1 ? 's' : ''}</span>
        {selected.size > 0 && (
          <span style={{ color: 'var(--tab-accent)' }} title="⌘C copies selected rows">
            {selected.size} row{selected.size !== 1 ? 's' : ''} selected
          </span>
        )}
        {selCells.size > 0 && (
          <span style={{ color: 'var(--tab-accent)' }} title="⌘C copies selected cells">
            {selCells.size} cell{selCells.size !== 1 ? 's' : ''} selected
          </span>
        )}
        <span className="ml-auto" title={tab.ranAt ? `fetched ${timeAgo(tab.ranAt)}` : undefined}>{tab.ranAt ? `${timeAgo(tab.ranAt)} · ` : ''}{result.executionMs}ms</span>
        <input value={globalFilter} onChange={e => setGlobalFilter(e.target.value)} placeholder="filter all…"
          className="text-[11px] bg-transparent outline-none"
          style={{ borderBottom: '1px solid var(--border)', color: 'var(--text)', width: 120, padding: '1px 4px' }} />
        {/* Copy-all dropdown */}
        <div className="relative shrink-0">
          <button
            onClick={e => { e.stopPropagation(); setDownloadMenu(false); setCopyMenu(o => !o) }}
            className={`flex items-center gap-1 transition-colors text-[11px] ${copied ? 'text-th-accent' : 'text-th-dim hover:text-th-accent'}`}
            title="Copy all results">
            {copied ? <Check size={11} /> : <Copy size={11} />}
            copy
          </button>
          {copyMenu && (
            <div className="absolute right-0 z-20"
              style={{ top: '100%', marginTop: 4, background: 'var(--sidebar-bg)', border: '1px solid var(--border)',
                       borderRadius: 4, boxShadow: '0 4px 12px rgba(0,0,0,0.3)', minWidth: 90, overflow: 'hidden' }}
              onClick={e => e.stopPropagation()}>
              {([['csv', 'CSV'], ['json', 'JSON'], ['text', 'Text']] as const).map(([fmt, label]) => (
                <button key={fmt} onClick={() => copyAs(fmt)}
                  className="block w-full text-left text-[11px] px-3 py-1 text-th-dim hover:text-th-bright"
                  style={{ background: 'transparent' }}
                  onMouseEnter={e => (e.currentTarget.style.background = 'var(--hover)')}
                  onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
                  {label}
                </button>
              ))}
            </div>
          )}
        </div>
        {/* Download-all dropdown — exports every row (no limit) to Downloads */}
        <div className="relative shrink-0">
          <button
            onClick={e => { e.stopPropagation(); setCopyMenu(false); setDownloadMenu(o => !o) }}
            disabled={downloading}
            className="flex items-center gap-1 transition-colors text-[11px] text-th-dim hover:text-th-accent disabled:opacity-50"
            title={saved ? `Saved to ${saved}` : 'Download all results'}>
            {downloading ? <Loader2 size={11} className="animate-spin" /> : <Download size={11} />}
            {saved ? 'saved' : 'download'}
          </button>
          {downloadMenu && (
            <div className="absolute right-0 z-20"
              style={{ top: '100%', marginTop: 4, background: 'var(--sidebar-bg)', border: '1px solid var(--border)',
                       borderRadius: 4, boxShadow: '0 4px 12px rgba(0,0,0,0.3)', minWidth: 90, overflow: 'hidden' }}
              onClick={e => e.stopPropagation()}>
              {([['csv', 'CSV'], ['json', 'JSON'], ['text', 'Text']] as const).map(([fmt, label]) => (
                <button key={fmt} onClick={() => downloadAs(fmt)}
                  className="block w-full text-left text-[11px] px-3 py-1 text-th-dim hover:text-th-bright"
                  style={{ background: 'transparent' }}
                  onMouseEnter={e => (e.currentTarget.style.background = 'var(--hover)')}
                  onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
                  {label}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Table */}
      <div ref={scrollRef} tabIndex={0} onKeyDown={onKeyDown}
        className="flex-1 overflow-auto focus:outline-none" style={{ overscrollBehavior: 'none' }}>
        <table className="text-[12px] border-collapse" style={{ width: 'max-content', minWidth: '100%' }}>
          <thead style={{ position: 'sticky', top: 0, zIndex: 2, background: 'var(--sidebar-bg)' }}>
            {table.getHeaderGroups().map(hg => (
              <tr key={hg.id}>
                {/* Row-number gutter header — shrinks to content */}
                <th style={{ width: 1, padding: '4px 6px', borderBottom: '1px solid var(--border)',
                             borderRight: '1px solid var(--border)', textAlign: 'right',
                             userSelect: 'none', color: 'var(--text-dim)', fontWeight: 600,
                             fontSize: 10, whiteSpace: 'nowrap', background: 'var(--sidebar-bg)' }}>#</th>
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
              <tr key={row.id}
                style={{ background: selected.has(row.id)
                           ? 'color-mix(in srgb, var(--tab-accent) 22%, transparent)'
                           : ri % 2 === 0 ? 'transparent' : 'var(--hover)' }}>
                {/* Row number — click selects the whole row */}
                <td onClick={e => selectRow(e, row.id, ri)}
                    title="Select row"
                    style={{ width: 1, padding: '3px 6px', borderBottom: '1px solid var(--border)',
                             borderRight: '1px solid var(--border)', textAlign: 'right', cursor: 'pointer',
                             color: 'var(--text-dim)', userSelect: 'none', whiteSpace: 'nowrap', fontSize: 10 }}>
                  {ri + 1}
                </td>
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
                  const cellSel = selCells.has(cellKey(row.id, colId))
                  return (
                    <td key={cell.id}
                      onClick={e => selectCell(e, row.id, colId)}
                      style={{ padding: '3px 10px', borderBottom: '1px solid var(--border)',
                               borderRight: '1px solid var(--border)', whiteSpace: 'nowrap',
                               maxWidth: 400, overflow: 'hidden', textOverflow: 'ellipsis', cursor: 'cell',
                               background: cellSel ? 'color-mix(in srgb, var(--tab-accent) 30%, transparent)' : undefined,
                               color: val === null ? 'var(--text-dim)' : 'var(--text)' }}>
                      {isFk && fkRef ? (
                        <span className="inline-flex items-center gap-1">
                          <span>{display}</span>
                          <button
                            title={`Go to ${fkRef.table} (⌘click = new tab)`}
                            className="text-th-dim hover:text-th-accent shrink-0"
                            style={{ lineHeight: 0 }}
                            onClick={e => { e.stopPropagation(); onFkClickRef.current?.(fkRef.table, fkRef.col, String(val), e.metaKey || e.ctrlKey) }}>
                            <ExternalLink size={10} />
                          </button>
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
