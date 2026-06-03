import { useState, useRef, useEffect, useCallback } from 'react'
import { Loader2, XCircle, X, Edit2, Copy, Check } from 'lucide-react'
import type { ResultTab, QueryResult } from '@/lib/results'
export type { QueryResult, ResultTab } from '@/lib/results'
import ResultTable from '@/components/ResultTable'

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
  onForward?:     (resultTabId: string) => void
  onSort:         (resultTabId: string, col: string | null, dir: 'asc' | 'desc') => void
  onColumnFilter: (resultTabId: string, col: string, value: string, op: string) => void
  onLoadMore:     (resultTabId: string) => void
  onEditSql:    (resultTabId: string, sql: string) => void
  /** Fetch the full (unlimited) result set for a result tab — used by download. */
  onFetchAll?:    (resultTabId: string) => Promise<QueryResult>
  elapsed:      Map<string, number>  // resultTabId → start timestamp
}


// ── SQL preview bar ───────────────────────────────────────────────────────

function SqlPreview({ sql, tabId, onEdit }: { sql: string; tabId: string; onEdit: (id: string, sql: string) => void }) {
  const [hovered,  setHovered]  = useState(false)
  const [expanded, setExpanded] = useState(false)
  const [copied,   setCopied]   = useState(false)
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => { if (copyTimer.current) clearTimeout(copyTimer.current) }, [])

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(sql)
      setCopied(true)
      if (copyTimer.current) clearTimeout(copyTimer.current)
      copyTimer.current = setTimeout(() => setCopied(false), 1500)
    } catch { /* clipboard unavailable */ }
  }

  const preview = sql.replace(/\s+/g, ' ').trim()
  const truncated = preview.length > 120 ? preview.slice(0, 120) + '…' : preview

  return (
    <div className="shrink-0 relative" style={{ borderBottom: '1px solid var(--border)', background: 'var(--sidebar-bg)' }}
      onMouseEnter={() => setHovered(true)} onMouseLeave={() => { setHovered(false); setExpanded(false) }}>
      <div className="flex items-center gap-2 px-3" style={{ height: 22, cursor: 'default' }}
        onClick={() => setExpanded(e => !e)}>
        <span className="text-[10px] font-mono text-th-dim truncate flex-1">{truncated}</span>
        {(hovered || copied) && (
          <button title={copied ? 'Copied' : 'Copy SQL'}
            className={`shrink-0 ${copied ? 'text-th-accent' : 'text-th-dim hover:text-th-accent'}`}
            onClick={e => { e.stopPropagation(); copy() }}>
            {copied ? <Check size={10} /> : <Copy size={10} />}
          </button>
        )}
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

// ── Elapsed clock ───────────────────────────────────────────────────────────
// Self-ticking leaf: owns its own interval so the running-time readout updates
// without re-rendering ResultsPane / ResultTable. Only this tiny span repaints.
function ElapsedClock({ startMs }: { startMs: number }) {
  const [, setTick] = useState(0)
  useEffect(() => {
    const id = setInterval(() => setTick(n => n + 1), 100)
    return () => clearInterval(id)
  }, [])
  return (
    <span className="text-[10px] font-mono text-th-dim">
      {((Date.now() - startMs) / 1000).toFixed(1)}s
    </span>
  )
}

// ── Main component ─────────────────────────────────────────────────────────

export default function ResultsPane({
  tabs, activeId, fkColumns, fkRefs, onSetActive, onCloseTab, onRenameTab, onReorderTab,
  onFkClick, onBack, onForward, onSort, onColumnFilter, onLoadMore, onEditSql, onFetchAll, elapsed,
}: Props) {
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editTitle, setEditTitle] = useState('')
  const [dragIdx,   setDragIdx]   = useState<number | null>(null)
  const [dropIdx,   setDropIdx]   = useState<number | null>(null)
  const dragSrc         = useRef<number | null>(null)
  const dropTarget      = useRef<number | null>(null)
  // Keep the latest handlers in refs so the callbacks handed to the (memoised)
  // ResultTable stay referentially stable across editor keystrokes — otherwise
  // every keystroke (which re-renders this pane via the tabs context) would
  // re-render the whole result grid.
  const onFkClickPRef     = useRef(onFkClick)
  const onBackPRef        = useRef(onBack)
  const onForwardPRef     = useRef(onForward)
  const onSortPRef        = useRef(onSort)
  const onColumnFilterPRef= useRef(onColumnFilter)
  const onLoadMorePRef    = useRef(onLoadMore)
  const onFetchAllPRef    = useRef(onFetchAll)
  useEffect(() => { onFkClickPRef.current = onFkClick }, [onFkClick])
  useEffect(() => { onBackPRef.current    = onBack    }, [onBack])
  useEffect(() => { onForwardPRef.current = onForward }, [onForward])
  useEffect(() => { onSortPRef.current        = onSort },        [onSort])
  useEffect(() => { onColumnFilterPRef.current= onColumnFilter },[onColumnFilter])
  useEffect(() => { onLoadMorePRef.current    = onLoadMore },    [onLoadMore])
  useEffect(() => { onFetchAllPRef.current    = onFetchAll },    [onFetchAll])

  const activeTab = tabs.find(t => t.id === activeId)
  const activeTabId = activeTab?.id

  // Stable per-result-tab callbacks (identity changes only when the active
  // result tab changes, not on every parent re-render).
  const cbSort         = useCallback((col: string | null, dir: 'asc' | 'desc') => { if (activeTabId) onSortPRef.current(activeTabId, col, dir) }, [activeTabId])
  const cbColumnFilter = useCallback((col: string, val: string, op: string) => { if (activeTabId) onColumnFilterPRef.current(activeTabId, col, val, op) }, [activeTabId])
  const cbFkClick      = useCallback((table: string, col: string, val: string, newTab: boolean) => { if (activeTabId) onFkClickPRef.current?.(activeTabId, table, col, val, newTab) }, [activeTabId])
  const cbBack         = useCallback(() => { if (activeTabId) onBackPRef.current?.(activeTabId) }, [activeTabId])
  const cbForward      = useCallback(() => { if (activeTabId) onForwardPRef.current?.(activeTabId) }, [activeTabId])
  const cbLoadMore     = useCallback(() => { if (activeTabId) onLoadMorePRef.current(activeTabId) }, [activeTabId])
  const cbFetchAll     = useCallback(() => onFetchAllPRef.current!(activeTabId!), [activeTabId])

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

    let raf = 0
    const onMove = (ev: MouseEvent) => {
      if (raf) return
      const x = ev.clientX
      raf = requestAnimationFrame(() => {
        raf = 0
        // Find which tab we're hovering by querying tab elements
        const els = document.querySelectorAll('[data-result-tab-idx]')
        for (const el of els) {
          const r = el.getBoundingClientRect()
          const i = Number((el as HTMLElement).dataset.resultTabIdx)
          if (x >= r.left && x <= r.right) {
            if (dropTarget.current !== i) { dropTarget.current = i; setDropIdx(i) }
            break
          }
        }
      })
    }
    const onUp = () => {
      if (raf) cancelAnimationFrame(raf)
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

      {/* Content — prior results stay visible while a new query runs; the
          footer bar below shows the running indicator instead of a takeover. */}
      <div className="flex-1 min-h-0 overflow-hidden">
        {activeTab?.error ? (
          <div className="flex items-start gap-2 p-4 text-[12px]" style={{ color: 'var(--error-text, #f87171)' }}>
            <XCircle size={14} className="shrink-0 mt-0.5" />
            <pre className="whitespace-pre-wrap font-mono">{activeTab.error}</pre>
          </div>
        ) : activeTab?.data ? (
          <ResultTable key={activeTab.id} result={activeTab.data} tab={activeTab}
            fkColumns={fkColumns} fkRefs={fkRefs}
            onSort={cbSort}
            onColumnFilter={cbColumnFilter}
            onFkClick={cbFkClick}
            onBack={cbBack}
            onForward={cbForward}
            fetchAll={onFetchAll ? cbFetchAll : undefined}
            onLoadMore={activeTab.hasMore !== false ? cbLoadMore : undefined} />
        ) : activeTab?.running ? (
          // First run on this tab — no prior results to keep; footer shows progress.
          <div className="h-full" />
        ) : (
          <div className="flex items-center justify-center h-full text-th-dim text-[12px]">
            Press <kbd className="mx-1 px-1.5 py-0.5 rounded text-[11px]"
              style={{ background: 'var(--hover)', border: '1px solid var(--border)' }}>⌘↵</kbd> to run
          </div>
        )}
      </div>

      {/* Running indicator — lives in the footer, not over the results */}
      {activeTab?.running && (
        <div className="shrink-0 flex items-center gap-2 px-3"
          style={{ height: 22, borderTop: '1px solid var(--border)', background: 'var(--sidebar-bg)' }}>
          <Loader2 size={11} className="animate-spin" style={{ color: 'var(--tab-accent)' }} />
          <span className="text-[11px] text-th-dim">Running…</span>
          {elapsed.has(activeTab.id) && <ElapsedClock startMs={elapsed.get(activeTab.id)!} />}
        </div>
      )}
    </div>
  )
}
