import { useEffect, useRef, useState, useCallback } from 'react'
import { X, Database, Play, PlayCircle, Square } from 'lucide-react'
import { invoke } from '@tauri-apps/api/core'
import { useTabs } from '@/context/TabsContext'
import SqlEditor, { type SqlEditorRef } from '@/components/SqlEditor'
import SessionManagerTab from '@/components/SessionManagerTab'
import LockManagerTab from '@/components/LockManagerTab'
import TableDetailsTab from '@/components/TableDetailsTab'
import ResultsPane, { type QueryResult, type ResultTab } from '@/components/ResultsPane'
import ResizeHandle from '@/components/ResizeHandle'

interface Connection { id: string; name: string; driver: string; database: string }

interface TabResults {
  tabs:     ResultTab[]
  activeId: string
}

const DEFAULT_LIMIT      = 200
const CACHE_MAX_BYTES    = 2 * 1024 * 1024   // 2 MB per result tab set — warn above this
const DEFAULT_RESULTS_H  = 240
const MIN_EDITOR_H       = 80
const MIN_RESULTS_H      = 60

// Preserve column schema when a query returns 0 rows (SQLx gives empty columns on empty result)
function withColumns(fresh: QueryResult, prev?: QueryResult): QueryResult {
  if (fresh.columns.length === 0 && prev?.columns.length) {
    return { ...fresh, columns: prev.columns }
  }
  return fresh
}

function cacheKey(filePath: string) {
  return `cb:results:${filePath}`
}

function loadCachedResults(filePath: string): TabResults | null {
  try {
    const raw = localStorage.getItem(cacheKey(filePath))
    if (!raw) return null
    return JSON.parse(raw) as TabResults
  } catch { return null }
}

function saveCachedResults(filePath: string, tr: TabResults): 'ok' | 'too_large' {
  const json = JSON.stringify(tr)
  if (json.length > CACHE_MAX_BYTES) return 'too_large'
  try { localStorage.setItem(cacheKey(filePath), json) } catch { /* quota */ }
  return 'ok'
}

function newResultId() { return `r${Date.now()}-${Math.random().toString(36).slice(2, 7)}` }

export default function EditorTabs() {
  const { tabs, activeId, setActiveId, openQueryTab, closeTab, updateContent, renameTab,
          setTabConnection, setTabDatabase, setTabQueryLimit } = useTabs()
  const DEFAULT_LIMIT_VAL = DEFAULT_LIMIT

  const [editingId, setEditingId]      = useState<number | null>(null)
  const [editTitle, setEditTitle]      = useState('')
  const [connections, setConnections]  = useState<Connection[]>([])
  const [databases, setDatabases]      = useState<string[]>([])
  const [schemaStatus, setSchemaStatus]= useState<{
    tables: number; error?: string;
    fkColumns?: Set<string>;
    fkRefs?: Map<string, { table: string; col: string }>
  } | null>(null)
  const [resultMap, setResultMap]      = useState<Map<number, TabResults>>(new Map())
  const [cacheWarn, setCacheWarn]      = useState<string | null>(null)
  // elapsed timer: Map<resultTabId, startMs>
  const [elapsed, setElapsed]          = useState<Map<string, number>>(new Map())
  const elapsedTimer                   = useRef<ReturnType<typeof setInterval> | null>(null)
  const [resultsHeight, setResultsH]   = useState(DEFAULT_RESULTS_H)
  const editorAreaRef = useRef<HTMLDivElement>(null)
  const sqlEditorRef  = useRef<SqlEditorRef>(null)
  const draggingRef   = useRef(false)
  const dragStartY    = useRef(0)
  const dragStartH    = useRef(0)

  useEffect(() => {
    invoke<Connection[]>('list_connections').then(setConnections).catch(() => {})
  }, [])

  // ── Restore cached results when a tab becomes active ──────────────────────
  useEffect(() => {
    const tab = tabs.find(t => t.id === activeId)
    if (!tab?.filePath || resultMap.has(activeId)) return
    const cached = loadCachedResults(tab.filePath)
    if (cached) {
      // Strip running state from cached tabs
      const restored: TabResults = {
        ...cached,
        tabs: cached.tabs.map(t => ({ ...t, running: false })),
      }
      setResultMap(prev => new Map(prev).set(activeId, restored))
    }
  }, [activeId])

  // ── Save results to cache when they change ─────────────────────────────────
  const persistResults = useCallback((tabId: number, tr: TabResults) => {
    const tab = tabs.find(t => t.id === tabId)
    if (!tab?.filePath) return
    const status = saveCachedResults(tab.filePath, tr)
    if (status === 'too_large') {
      setCacheWarn(`Results too large to cache (>${(CACHE_MAX_BYTES / 1024 / 1024).toFixed(0)}MB). Not saved.`)
      setTimeout(() => setCacheWarn(null), 4000)
    }
  }, [tabs])

  // ── Keyboard shortcuts ────────────────────────────────────────────────────
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey) {
        if (e.key === 't') { e.preventDefault(); openQueryTab() }
        if (e.key === 'w') { e.preventDefault(); closeTab(activeId) }
        if (e.key === 'Enter') { e.preventDefault(); runQuery() }
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [activeId, tabs, resultMap])

  const startRename = (id: number, title: string) => { setEditingId(id); setEditTitle(title) }
  const commitRename = async () => {
    if (editingId !== null) {
      const current = tabs.find(t => t.id === editingId)
      const newTitle = editTitle.trim() || current?.title || ''
      const isDuplicate = tabs.some(t => t.id !== editingId && t.title === newTitle)
      await renameTab(editingId, isDuplicate ? (current?.title ?? newTitle) : newTitle)
    }
    setEditingId(null)
  }

  const active     = tabs.find(t => t.id === activeId)
  const isQueryTab = !active?.type || active?.type === 'query'
  const tr         = active ? resultMap.get(active.id) : undefined
  const showResults = isQueryTab && !!tr

  // ── Fetch databases when connection changes ───────────────────────────────
  useEffect(() => {
    if (!active?.connectionId) { setDatabases([]); return }
    invoke<string[]>('list_databases', { connectionId: active.connectionId })
      .then(setDatabases).catch(() => setDatabases([]))
  }, [active?.connectionId])

  // ── Limit helper ──────────────────────────────────────────────────────────
  const applyLimit = (sql: string, limit: number): string => {
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

  // ── Ensure result tabs exist, return target tab id ────────────────────────
  const ensureResultTab = useCallback((
    tabId: number,
    opts: { forceNew?: boolean } = {}
  ): string => {
    const existing = resultMap.get(tabId)
    if (!opts.forceNew && existing && existing.tabs.length > 0) {
      return existing.activeId
    }
    const id      = newResultId()
    const usedNums = new Set((existing?.tabs ?? []).map(t => {
      const m = t.title.match(/^Result (\d+)$/)
      return m ? parseInt(m[1]) : 0
    }))
    let num = 1
    while (usedNums.has(num)) num++
    const fresh: ResultTab = { id, title: `Result ${num}` }
    const next: TabResults = opts.forceNew && existing
      ? { tabs: [...existing.tabs, fresh], activeId: id }
      : { tabs: [fresh], activeId: id }
    setResultMap(prev => new Map(prev).set(tabId, next))
    if (!showResults) setResultsH(DEFAULT_RESULTS_H)
    return id
  }, [resultMap, showResults])

  // ── Run query ─────────────────────────────────────────────────────────────
  const runQuery = useCallback(async (inNewResultTab = false) => {
    const tab = tabs.find(t => t.id === activeId)
    if (!tab || (!tab.type || tab.type === 'query') === false) return
    if (!tab.connectionId) return

    const rawSql = (await sqlEditorRef.current?.getStatementAtCursor()) ?? tab.content.trim()
    if (!rawSql.trim()) return

    const limit  = tab.queryLimit ?? DEFAULT_LIMIT_VAL
    const sql    = applyLimit(rawSql, limit)
    const resultTabId = ensureResultTab(tab.id, { forceNew: inNewResultTab })

    // Start elapsed timer
    const startMs = Date.now()
    setElapsed(prev => new Map(prev).set(resultTabId, startMs))
    if (elapsedTimer.current) clearInterval(elapsedTimer.current)
    elapsedTimer.current = setInterval(() => setElapsed(prev => new Map(prev).set(resultTabId, startMs)), 50)

    // Mark tab as running, store the SQL being executed
    setResultMap(prev => {
      const curr = prev.get(tab.id)
      if (!curr) return prev
      return new Map(prev).set(tab.id, {
        ...curr,
        activeId: resultTabId,
        tabs: curr.tabs.map(t => t.id === resultTabId
          ? { ...t, running: true, data: undefined, error: undefined, sql, baseSql: rawSql, colFilters: undefined, colFilterOps: undefined }
          : t),
      })
    })

    try {
      const data = await invoke<QueryResult>('execute_query', { connectionId: tab.connectionId, sql })
      if (elapsedTimer.current) { clearInterval(elapsedTimer.current); elapsedTimer.current = null }
      setResultMap(prev => {
        const curr = prev.get(tab.id)
        if (!curr) return prev
        const hasMore = limit > 0 && data.rows.length >= limit
        const next: TabResults = {
          ...curr,
          tabs: curr.tabs.map(t => t.id === resultTabId
            ? { ...t, running: false, data: withColumns(data, t.data), error: undefined, sql, baseSql: rawSql,
                offset: data.rows.length, hasMore, colFilters: undefined, colFilterOps: undefined }
            : t),
        }
        persistResults(tab.id, next)
        return new Map(prev).set(tab.id, next)
      })
    } catch (e) {
      if (elapsedTimer.current) { clearInterval(elapsedTimer.current); elapsedTimer.current = null }
      setResultMap(prev => {
        const curr = prev.get(tab.id)
        if (!curr) return prev
        const next: TabResults = {
          ...curr,
          tabs: curr.tabs.map(t => t.id === resultTabId
            ? { ...t, running: false, error: String(e), sql, baseSql: rawSql }
            : t),
        }
        return new Map(prev).set(tab.id, next)
      })
    }
  }, [activeId, tabs, resultMap, ensureResultTab, persistResults])

  // ── Result tab management ─────────────────────────────────────────────────
  const setActiveResultTab = (tabId: number, resultId: string) =>
    setResultMap(prev => {
      const curr = prev.get(tabId)
      if (!curr) return prev
      return new Map(prev).set(tabId, { ...curr, activeId: resultId })
    })

  const closeResultTab = (tabId: number, resultId: string) =>
    setResultMap(prev => {
      const curr = prev.get(tabId)
      if (!curr) return prev
      const tabs = curr.tabs.filter(t => t.id !== resultId)
      if (tabs.length === 0) return new Map(prev).set(tabId, { tabs: [], activeId: '' })
      const activeId = curr.activeId === resultId ? tabs[tabs.length - 1].id : curr.activeId
      return new Map(prev).set(tabId, { tabs, activeId })
    })

  const renameResultTab = (tabId: number, resultId: string, title: string) =>
    setResultMap(prev => {
      const curr = prev.get(tabId)
      if (!curr) return prev
      const next: TabResults = { ...curr, tabs: curr.tabs.map(t => t.id === resultId ? { ...t, title } : t) }
      persistResults(tabId, next)
      return new Map(prev).set(tabId, next)
    })

  // ── Load more (pagination) ────────────────────────────────────────────────
  const handleLoadMore = useCallback(async (editorTabId: number, resultTabId: string) => {
    const editorTab = tabs.find(t => t.id === editorTabId)
    if (!editorTab?.connectionId) return
    const tr = resultMap.get(editorTabId)
    const rt = tr?.tabs.find(t => t.id === resultTabId)
    if (!rt?.baseSql || !rt.hasMore || rt.loadingMore || rt.running) return

    const limit  = editorTab.queryLimit ?? DEFAULT_LIMIT_VAL
    const offset = rt.offset ?? 0

    let newSql = rt.baseSql.trim().replace(/;\s*$/, '').trimEnd()
    if (rt.sortCol) newSql += `\nORDER BY ${rt.sortCol} ${(rt.sortDir ?? 'asc').toUpperCase()}`
    if (limit > 0) newSql += `\nLIMIT ${limit} OFFSET ${offset}`

    setResultMap(prev => {
      const curr = prev.get(editorTabId)
      if (!curr) return prev
      return new Map(prev).set(editorTabId, {
        ...curr,
        tabs: curr.tabs.map(t => t.id === resultTabId ? { ...t, loadingMore: true } : t),
      })
    })

    try {
      const data = await invoke<QueryResult>('execute_query', { connectionId: editorTab.connectionId, sql: newSql })
      setResultMap(prev => {
        const curr = prev.get(editorTabId)
        const rt2  = curr?.tabs.find(t => t.id === resultTabId)
        if (!curr || !rt2?.data) return prev
        const merged  = { ...data, rows: [...rt2.data.rows, ...data.rows] }
        const hasMore = limit > 0 && data.rows.length >= limit
        const next: TabResults = {
          ...curr,
          tabs: curr.tabs.map(t => t.id === resultTabId
            ? { ...t, loadingMore: false, data: merged, offset: offset + data.rows.length, hasMore }
            : t),
        }
        persistResults(editorTabId, next)
        return new Map(prev).set(editorTabId, next)
      })
    } catch {
      setResultMap(prev => {
        const curr = prev.get(editorTabId)
        if (!curr) return prev
        return new Map(prev).set(editorTabId, {
          ...curr,
          tabs: curr.tabs.map(t => t.id === resultTabId ? { ...t, loadingMore: false } : t),
        })
      })
    }
  }, [tabs, resultMap, persistResults])

  // ── Sort → re-run with ORDER BY ───────────────────────────────────────────
  const handleSort = useCallback(async (editorTabId: number, resultTabId: string, col: string | null, dir: 'asc' | 'desc') => {
    const editorTab = tabs.find(t => t.id === editorTabId)
    if (!editorTab?.connectionId) return
    const tr = resultMap.get(editorTabId)
    const rt = tr?.tabs.find(t => t.id === resultTabId)
    if (!rt) return

    const base = rt.baseSql ?? rt.sql ?? ''
    if (!base.trim()) return

    const limit = editorTab.queryLimit ?? DEFAULT_LIMIT_VAL
    let newSql = base.trim().replace(/;\s*$/, '').trimEnd()
    if (col) newSql += `\nORDER BY ${col} ${dir.toUpperCase()}`
    if (limit > 0) newSql += `\nLIMIT ${limit}`

    // Update sortCol/sortDir optimistically
    setResultMap(prev => {
      const curr = prev.get(editorTabId)
      if (!curr) return prev
      return new Map(prev).set(editorTabId, {
        ...curr,
        tabs: curr.tabs.map(t => t.id === resultTabId
          ? { ...t, running: true, sortCol: col ?? undefined, sortDir: dir }
          : t),
      })
    })

    const startMs = Date.now()
    setElapsed(prev => new Map(prev).set(resultTabId, startMs))
    if (elapsedTimer.current) clearInterval(elapsedTimer.current)
    elapsedTimer.current = setInterval(() => setElapsed(prev => new Map(prev).set(resultTabId, startMs)), 50)

    try {
      const data = await invoke<QueryResult>('execute_query', { connectionId: editorTab.connectionId, sql: newSql })
      if (elapsedTimer.current) { clearInterval(elapsedTimer.current); elapsedTimer.current = null }
      setResultMap(prev => {
        const curr = prev.get(editorTabId)
        if (!curr) return prev
        const next: TabResults = {
          ...curr,
          tabs: curr.tabs.map(t => t.id === resultTabId
            ? { ...t, running: false, data: withColumns(data, t.data), sql: newSql, sortCol: col ?? undefined, sortDir: dir }
            : t),
        }
        persistResults(editorTabId, next)
        return new Map(prev).set(editorTabId, next)
      })
    } catch (e) {
      if (elapsedTimer.current) { clearInterval(elapsedTimer.current); elapsedTimer.current = null }
      setResultMap(prev => {
        const curr = prev.get(editorTabId)
        if (!curr) return prev
        return new Map(prev).set(editorTabId, {
          ...curr,
          tabs: curr.tabs.map(t => t.id === resultTabId ? { ...t, running: false, error: String(e) } : t),
        })
      })
    }
  }, [tabs, resultMap, persistResults])

  // ── Column filter → re-run with WHERE ────────────────────────────────────
  const handleColumnFilter = useCallback(async (editorTabId: number, resultTabId: string, col: string, value: string, op = '~') => {
    const editorTab = tabs.find(t => t.id === editorTabId)
    if (!editorTab?.connectionId) return
    const tr = resultMap.get(editorTabId)
    const rt = tr?.tabs.find(t => t.id === resultTabId)
    if (!rt?.baseSql) return

    const newFilters = { ...(rt.colFilters ?? {}), [col]: value }
    if (!value) delete newFilters[col]
    const newOps = { ...(rt.colFilterOps ?? {}), [col]: op }
    if (!value) delete newOps[col]

    const limit = editorTab.queryLimit ?? DEFAULT_LIMIT_VAL
    const base  = rt.baseSql.trim().replace(/;\s*$/, '')
    const conditions = Object.entries(newFilters)
      .filter(([, v]) => v.trim())
      .map(([c, v]) => {
        const o    = newOps[c] ?? '~'
        const esc  = v.replace(/'/g, "''")
        if (o === '~')  return `"${c}"::text ILIKE '%${esc}%'`
        if (o === '!=') return `"${c}"::text != '${esc}'`
        if (o === '>')  return `"${c}"::text > '${esc}'`
        if (o === '<')  return `"${c}"::text < '${esc}'`
        return `"${c}"::text = '${esc}'`   // '='
      })

    let newSql: string
    if (conditions.length > 0) {
      // Wrap in subquery so WHERE is always safe regardless of original SQL shape
      newSql = `SELECT * FROM (\n${base}\n) _q\nWHERE ${conditions.join(' AND ')}`
    } else {
      // No filters — run baseSql directly (faster, no subquery overhead)
      newSql = base
    }
    if (rt.sortCol) newSql += `\nORDER BY "${rt.sortCol}" ${(rt.sortDir ?? 'asc').toUpperCase()}`
    if (limit > 0) newSql += `\nLIMIT ${limit}`

    setResultMap(prev => {
      const curr = prev.get(editorTabId)
      if (!curr) return prev
      return new Map(prev).set(editorTabId, {
        ...curr, tabs: curr.tabs.map(t => t.id === resultTabId ? { ...t, running: true, colFilters: newFilters, colFilterOps: newOps } : t),
      })
    })

    try {
      const data = await invoke<QueryResult>('execute_query', { connectionId: editorTab.connectionId, sql: newSql })
      const hasMore = limit > 0 && data.rows.length >= limit
      setResultMap(prev => {
        const curr = prev.get(editorTabId)
        if (!curr) return prev
        const next: TabResults = {
          ...curr,
          tabs: curr.tabs.map(t => t.id === resultTabId
            ? { ...t, running: false, data: withColumns(data, t.data), sql: newSql, colFilters: newFilters, colFilterOps: newOps, offset: withColumns(data, t.data).rows.length, hasMore }
            : t),
        }
        persistResults(editorTabId, next)
        return new Map(prev).set(editorTabId, next)
      })
    } catch (e) {
      setResultMap(prev => {
        const curr = prev.get(editorTabId)
        if (!curr) return prev
        return new Map(prev).set(editorTabId, {
          ...curr, tabs: curr.tabs.map(t => t.id === resultTabId ? { ...t, running: false, error: String(e) } : t),
        })
      })
    }
  }, [tabs, resultMap, persistResults])

  // ── FK cell click → navigate to referenced row ───────────────────────────
  const handleFkClick = useCallback(async (
    editorTabId: number, resultTabId: string,
    refTable: string, refCol: string, value: string, newTab: boolean,
  ) => {
    const editorTab = tabs.find(t => t.id === editorTabId)
    if (!editorTab?.connectionId) return
    const limit = editorTab.queryLimit ?? DEFAULT_LIMIT_VAL
    const esc   = value.replace(/'/g, "''")
    const sql   = `SELECT * FROM ${refTable}\nWHERE ${refCol} = '${esc}'\nLIMIT ${limit}`

    let targetId = resultTabId
    if (newTab) {
      targetId = newResultId()
      const tr = resultMap.get(editorTabId)
      const num = (tr?.tabs.length ?? 0) + 1
      setResultMap(prev => {
        const curr = prev.get(editorTabId)
        if (!curr) return prev
        return new Map(prev).set(editorTabId, {
          tabs: [...curr.tabs, { id: targetId, title: `Result ${num}` }],
          activeId: targetId,
        })
      })
      if (!showResults) setResultsH(DEFAULT_RESULTS_H)
    }

    // Save current state to history (only for replace-current)
    setResultMap(prev => {
      const curr = prev.get(editorTabId)
      if (!curr) return prev
      return new Map(prev).set(editorTabId, {
        ...curr,
        activeId: targetId,
        tabs: curr.tabs.map(t => {
          if (t.id !== targetId) return t
          const snapshot = newTab ? undefined : {
            data: t.data, sql: t.sql, baseSql: t.baseSql,
            sortCol: t.sortCol, sortDir: t.sortDir,
            colFilters: t.colFilters, colFilterOps: t.colFilterOps,
            offset: t.offset, hasMore: t.hasMore,
          }
          return { ...t, running: true, sql,
            history: snapshot ? [...(t.history ?? []), snapshot] : (t.history ?? []) }
        }),
      })
    })

    try {
      const data = await invoke<QueryResult>('execute_query', { connectionId: editorTab.connectionId, sql })
      const hasMore = limit > 0 && data.rows.length >= limit
      setResultMap(prev => {
        const curr = prev.get(editorTabId)
        if (!curr) return prev
        const next: TabResults = {
          ...curr,
          tabs: curr.tabs.map(t => t.id === targetId
            ? { ...t, running: false, data: withColumns(data, t.data), sql, baseSql: sql,
                offset: data.rows.length, hasMore, sortCol: undefined, sortDir: undefined,
                colFilters: undefined, colFilterOps: undefined }
            : t),
        }
        persistResults(editorTabId, next)
        return new Map(prev).set(editorTabId, next)
      })
    } catch (e) {
      setResultMap(prev => {
        const curr = prev.get(editorTabId)
        if (!curr) return prev
        return new Map(prev).set(editorTabId, {
          ...curr, tabs: curr.tabs.map(t => t.id === targetId ? { ...t, running: false, error: String(e) } : t),
        })
      })
    }
  }, [tabs, resultMap, showResults, persistResults])

  // ── Back — restore previous state from history ────────────────────────────
  const handleBack = useCallback((editorTabId: number, resultTabId: string) => {
    setResultMap(prev => {
      const curr = prev.get(editorTabId)
      if (!curr) return prev
      const rt = curr.tabs.find(t => t.id === resultTabId)
      if (!rt?.history?.length) return prev
      const history   = [...rt.history]
      const prevState = history.pop()!
      const next: TabResults = {
        ...curr,
        tabs: curr.tabs.map(t => t.id === resultTabId
          ? { ...t, ...prevState, running: false, history }
          : t),
      }
      return new Map(prev).set(editorTabId, next)
    })
  }, [])

  // ── Edit SQL → paste into editor ──────────────────────────────────────────
  const handleEditSql = useCallback((editorTabId: number, sql: string) => {
    updateContent(editorTabId, sql)
  }, [updateContent])

  const reorderResultTab = (tabId: number, fromIdx: number, toIdx: number) =>
    setResultMap(prev => {
      const curr = prev.get(tabId)
      if (!curr) return prev
      const tabs = [...curr.tabs]
      const [item] = tabs.splice(fromIdx, 1)
      tabs.splice(toIdx, 0, item)
      return new Map(prev).set(tabId, { ...curr, tabs })
    })

  // ── Resizable split ───────────────────────────────────────────────────────
  const onDragStart = (e: React.MouseEvent) => {
    draggingRef.current = true
    dragStartY.current  = e.clientY
    dragStartH.current  = resultsHeight
    const onMove = (ev: MouseEvent) => {
      if (!draggingRef.current) return
      const delta = dragStartY.current - ev.clientY
      const total = editorAreaRef.current?.getBoundingClientRect().height ?? 600
      setResultsH(Math.min(total - MIN_EDITOR_H, Math.max(MIN_RESULTS_H, dragStartH.current + delta)))
    }
    const onUp = () => { draggingRef.current = false; window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp) }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  return (
    <div className="flex flex-col flex-1 min-h-0">
      {/* Tab bar */}
      <div className="flex items-center overflow-x-auto shrink-0 bg-th-tab-inactive border-b border-b-th-border">
        {tabs.map(tab => {
          const isActive  = tab.id === activeId
          const isEditing = editingId === tab.id
          return (
            // Use div instead of button to avoid nested-button click conflicts in WebKit
            <div key={tab.id}
              onClick={() => setActiveId(tab.id)}
              onDoubleClick={() => startRename(tab.id, tab.title)}
              role="tab"
              aria-selected={isActive}
              className={`flex items-center h-9 px-4 gap-2 text-[13px] cursor-pointer select-none shrink-0 transition-colors border-r border-r-th-border border-t
                ${isActive ? 'bg-th-tab-active text-th-bright border-t-th-accent' : 'bg-transparent text-th-dim border-t-transparent hover:text-th-text hover:bg-th-hover'}`}>
              {tab.isDirty && <span className="text-th-dim text-[10px] leading-none">●</span>}
              {isEditing ? (
                <input autoFocus value={editTitle} onChange={e => setEditTitle(e.target.value)} onBlur={commitRename}
                  onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.blur() } if (e.key === 'Escape') setEditingId(null) }}
                  onClick={e => e.stopPropagation()}
                  className="bg-transparent outline outline-1 outline-th-accent text-th-bright px-1 w-24 text-[13px]" />
              ) : <span className="shrink-0">{tab.title}</span>}
              {tabs.length > 1 && (
                <button
                  aria-label={`Close ${tab.title}`}
                  className="flex items-center justify-center w-4 h-4 rounded transition-colors"
                  style={{ flexShrink: 0, color: 'var(--text-dim)', background: 'transparent', border: 'none', cursor: 'pointer', padding: 0 }}
                  onMouseEnter={e => (e.currentTarget.style.color = 'var(--text-bright)')}
                  onMouseLeave={e => (e.currentTarget.style.color = 'var(--text-dim)')}
                  onMouseDown={e => e.stopPropagation()}
                  onClick={e => { e.stopPropagation(); closeTab(tab.id) }}>
                  <X size={12} />
                </button>
              )}
            </div>
          )
        })}
        <button onClick={openQueryTab}
          className="flex items-center justify-center w-9 h-9 shrink-0 text-lg transition-colors rounded-none text-th-dim hover:text-th-text hover:bg-th-hover">+</button>
      </div>

      {/* Connection + run bar */}
      {isQueryTab && active && (
        <div className="flex items-center gap-2 shrink-0 px-3"
          style={{ height: 28, borderBottom: '1px solid var(--border)', background: 'var(--sidebar-bg)' }}>
          {connections.length > 0 && (
            <>
              <Database size={11} style={{ color: 'var(--text-dim)', flexShrink: 0 }} />
              <select value={active.connectionId ?? ''} onChange={e => { const c = connections.find(c => c.id === e.target.value); setSchemaStatus(null); setTabConnection(active.id, c?.id, c?.name) }}
                className="text-[11px] bg-transparent outline-none cursor-pointer" style={{ color: active.connectionId ? 'var(--text)' : 'var(--text-dim)', border: 'none' }}>
                <option value="">no connection</option>
                {connections.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
              {active.connectionId && databases.length > 0 && (
                <>
                  <span style={{ color: 'var(--border)', fontSize: 10 }}>·</span>
                  <select value={active.database ?? ''} onChange={e => { setSchemaStatus(null); setTabDatabase(active.id, e.target.value || undefined) }}
                    className="text-[11px] bg-transparent outline-none cursor-pointer" style={{ color: active.database ? 'var(--text)' : 'var(--text-dim)', border: 'none' }}>
                    <option value="">select database…</option>
                    {databases.map(db => <option key={db} value={db}>{db}</option>)}
                  </select>
                </>
              )}
              {active.connectionId && (
                <span className="text-[10px]" style={{ color: schemaStatus?.error ? 'var(--error-text, #f87171)' : 'var(--text-dim)' }}>
                  {schemaStatus?.error ? `⚠ ${schemaStatus.error}` : schemaStatus ? `${schemaStatus.tables} tables` : 'loading…'}
                </span>
              )}
            </>
          )}
          <div className="flex items-center gap-1 ml-auto text-[11px] text-th-dim">
            <span>LIMIT</span>
            <input type="number" min={0} value={active.queryLimit ?? DEFAULT_LIMIT_VAL}
              onChange={e => { const v = parseInt(e.target.value); setTabQueryLimit(active.id, isNaN(v) || v < 0 ? 0 : v) }}
              title="Row limit (0 = no limit)"
              className="text-[11px] outline-none text-center bg-transparent"
              style={{ width: 52, border: '1px solid var(--border)', borderRadius: 3, padding: '1px 4px', color: 'var(--text)' }} />
          </div>
          <div className="flex items-center gap-1">
            {/* Show Cancel when a query is running, otherwise Run buttons */}
            {tr?.tabs.some(t => t.running) ? (
              <button
                onClick={() => active.connectionId && invoke('cancel_query', { connectionId: active.connectionId })}
                title="Cancel running query"
                className="flex items-center gap-1 px-2 py-0.5 rounded text-[11px] transition-colors"
                style={{ background: '#ef4444', color: '#fff' }}>
                <Square size={10} />Cancel
              </button>
            ) : (
              <>
                <button onClick={() => runQuery(false)} disabled={!active.connectionId}
                  title="Run query (⌘↵)"
                  className="flex items-center gap-1 px-2 py-0.5 rounded text-[11px] transition-colors disabled:opacity-40"
                  style={{ background: 'var(--tab-accent)', color: '#fff' }}>
                  <Play size={10} />Run
                </button>
                <button onClick={() => runQuery(true)} disabled={!active.connectionId}
                  title="Run in new result tab (⌘⇧↵)"
                  className="flex items-center gap-1 px-2 py-0.5 rounded text-[11px] transition-colors disabled:opacity-40"
                  style={{ border: '1px solid var(--border)', color: 'var(--text)' }}>
                  <PlayCircle size={10} />New tab
                </button>
              </>
            )}
          </div>
        </div>
      )}

      {/* Cache warning */}
      {cacheWarn && (
        <div className="shrink-0 px-3 py-1 text-[11px]" style={{ background: 'rgba(251,191,36,0.1)', color: '#fbbf24', borderBottom: '1px solid var(--border)' }}>
          ⚠ {cacheWarn}
        </div>
      )}

      {/* Editor + results area */}
      <div ref={editorAreaRef} className="relative flex-1 min-h-0 bg-th-bg flex flex-col">
        {active?.type === 'session-manager' && active.connectionId && (
          <SessionManagerTab key={active.id} connectionId={active.connectionId} connectionName={active.connectionName ?? active.title} />
        )}
        {active?.type === 'lock-manager' && active.connectionId && (
          <LockManagerTab key={active.id} connectionId={active.connectionId} connectionName={active.connectionName ?? active.title} />
        )}
        {active?.type === 'table-details' && active.connectionId && (
          <TableDetailsTab key={active.id} connectionId={active.connectionId} schema={(active as any).schema ?? 'public'} table={(active as any).table ?? ''} />
        )}
        {isQueryTab && active && (
          <>
            <div style={{ flex: 1, minHeight: MIN_EDITOR_H, position: 'relative', overflow: 'hidden' }}>
              <SqlEditor
                key={active.id}
                ref={sqlEditorRef}
                value={active.content}
                onChange={v => updateContent(active.id, v)}
                connectionId={active.connectionId}
                driver={connections.find(c => c.id === active.connectionId)?.driver}
                database={active.database}
                onSchemaStatus={setSchemaStatus}
                onRunQuery={(_sql, newTab) => runQuery(newTab)}
              />
            </div>

            {showResults && tr && tr.tabs.length > 0 && (
              <>
                <ResizeHandle direction="vertical" onMouseDown={onDragStart} />
                <div style={{ height: resultsHeight, flexShrink: 0, overflow: 'hidden', borderTop: '1px solid var(--border)' }}>
                  <ResultsPane
                    tabs={tr.tabs}
                    activeId={tr.activeId}
                    onSetActive={id => setActiveResultTab(active.id, id)}
                    onCloseTab={id => closeResultTab(active.id, id)}
                    onRenameTab={(id, t) => renameResultTab(active.id, id, t)}
                    onReorderTab={(f, t) => reorderResultTab(active.id, f, t)}
                    fkColumns={schemaStatus?.fkColumns}
                    fkRefs={schemaStatus?.fkRefs}
                    onFkClick={(resultTabId, table, col, val, newTab) => handleFkClick(active.id, resultTabId, table, col, val, newTab)}
                    onBack={resultTabId => handleBack(active.id, resultTabId)}
                    onSort={(resultTabId, col, dir) => handleSort(active.id, resultTabId, col, dir)}
                    onColumnFilter={(resultTabId, col, val, op) => handleColumnFilter(active.id, resultTabId, col, val, op)}
                    onEditSql={(_resultTabId, sql) => handleEditSql(active.id, sql)}
                    onLoadMore={resultTabId => handleLoadMore(active.id, resultTabId)}
                    elapsed={elapsed}
                  />
                </div>
              </>
            )}
          </>
        )}
      </div>
    </div>
  )
}
