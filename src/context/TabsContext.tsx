import { createContext, useContext, useState, useCallback, useEffect, useRef } from 'react'
import { invoke } from '@tauri-apps/api/core'
import type { Tab } from '@/lib/tabs'

interface QueryFileMeta { name: string; path: string }
interface WorkspaceMeta { name: string; queries: QueryFileMeta[] }
type ConnMap = Record<string, { id: string; name: string; database?: string }>

// Derive the query title (file stem) and owning workspace (parent dir name).
const stemOf = (path: string) => (path.split('/').pop() ?? path).replace(/\.sql$/i, '')
const workspaceOf = (path: string) => {
  const parts = path.split('/')
  return parts.length >= 2 ? parts[parts.length - 2] : undefined
}

interface TabsContextValue {
  tabs: Tab[]
  activeId: number
  restored: boolean
  setActiveId: (id: number) => void
  /** Create a new query in the active tab's workspace (falls back to Default). */
  openQueryTab: () => Promise<void>
  /** Create a query in a specific workspace and open it. */
  createQuery: (workspace: string, title?: string) => Promise<void>
  /** Open an existing query by path — focuses it if already open. */
  openQueryByPath: (path: string) => Promise<void>
  /** Close the tab backing a query path, if open (does NOT delete the file). */
  closeQueryByPath: (path: string) => void
  /** Close all open tabs belonging to a workspace (used when it's deleted). */
  closeWorkspaceTabs: (workspace: string) => void
  openSpecialTab: (type: Tab['type'], title: string, extra?: Partial<Tab>) => void
  closeTab: (id: number) => void
  updateContent: (id: number, content: string) => void
  renameTab: (id: number, newTitle: string) => Promise<void>
  reloadTabs: () => Promise<void>
  setTabConnection: (id: number, connectionId: string | undefined, connectionName: string | undefined) => void
  setTabDatabase:    (id: number, database: string | undefined) => void
  setTabQueryLimit:  (id: number, limit: number | undefined) => void
}

const TabsContext = createContext<TabsContextValue>(null!)

export function TabsProvider({ children }: { children: React.ReactNode }) {
  const [tabs, setTabs] = useState<Tab[]>([])
  const [activeId, setActiveIdState] = useState(0)
  const [restored, setRestored] = useState(false)
  const saveTimers = useRef(new Map<number, ReturnType<typeof setTimeout>>())
  const tabsRef = useRef<Tab[]>([])
  const nextIdRef = useRef(1)
  const activeIdRef = useRef(0)

  useEffect(() => { tabsRef.current = tabs }, [tabs])
  useEffect(() => { activeIdRef.current = activeId }, [activeId])
  useEffect(() => () => {
    saveTimers.current.forEach(t => clearTimeout(t))
    saveTimers.current.clear()
  }, [])

  // ── Persist the set of open query tabs (by path) for next-session restore ──
  const persistOpenTabs = (list: Tab[]) => {
    const paths = list.filter(t => (!t.type || t.type === 'query') && t.filePath).map(t => t.filePath)
    invoke('set_setting', { key: 'open_query_tabs', value: JSON.stringify(paths) }).catch(() => {})
  }
  const persistActivePath = (path: string) => {
    invoke('set_setting', { key: 'active_query_path', value: path }).catch(() => {})
  }
  // Per-tab connection map, keyed by file path (titles collide across workspaces).
  const persistConnMap = (list: Tab[]) => {
    const map: ConnMap = {}
    list.forEach(t => {
      if (t.filePath && t.connectionId && t.connectionName)
        map[t.filePath] = { id: t.connectionId, name: t.connectionName, database: t.database }
    })
    invoke('set_setting', { key: 'tab_query_connections', value: JSON.stringify(map) }).catch(() => {})
  }
  const persistSpecialTabs = (list: Tab[]) => {
    const specials = list.filter(t => t.type && t.type !== 'query').map(t => ({ ...t }))
    invoke('set_setting', { key: 'open_special_tabs', value: JSON.stringify(specials) }).catch(() => {})
  }

  // ── Session restore: reopen only last session's tabs (not every file) ──────
  const loadTabs = useCallback(async () => {
    saveTimers.current.forEach(t => clearTimeout(t))
    saveTimers.current.clear()
    setRestored(false)

    try {
      const [openRaw, activePath, connRaw, specialRaw] = await Promise.all([
        invoke<string | null>('get_setting', { key: 'open_query_tabs' }).catch(() => null),
        invoke<string | null>('get_setting', { key: 'active_query_path' }).catch(() => null),
        invoke<string | null>('get_setting', { key: 'tab_query_connections' }).catch(() => null),
        invoke<string | null>('get_setting', { key: 'open_special_tabs' }).catch(() => null),
      ])
      const connMap: ConnMap = connRaw ? JSON.parse(connRaw) : {}
      let openPaths: string[] = openRaw ? JSON.parse(openRaw) : []

      // First run (or nothing remembered): open the first existing query, or
      // create Default/Query 1.sql. list_workspaces also runs the root→Default migration.
      if (openPaths.length === 0) {
        const wss = await invoke<WorkspaceMeta[]>('list_workspaces').catch(() => [] as WorkspaceMeta[])
        const first = wss.flatMap(w => w.queries)[0]
        openPaths = first
          ? [first.path]
          : [await invoke<string>('create_query', { workspace: 'Default', name: 'Query 1' })]
      }

      let nextId = 1
      const queryTabs: Tab[] = []
      for (const path of openPaths) {
        const content = await invoke<string>('read_query_file', { path }).catch(() => null)
        if (content === null) continue // deleted out from under us — drop it
        queryTabs.push({
          id: nextId++, title: stemOf(path), filePath: path, workspace: workspaceOf(path),
          content, isDirty: false,
          connectionId: connMap[path]?.id, connectionName: connMap[path]?.name, database: connMap[path]?.database,
        })
      }
      if (queryTabs.length === 0) {
        const path = await invoke<string>('create_query', { workspace: 'Default', name: 'Query 1' })
        queryTabs.push({ id: nextId++, title: stemOf(path), filePath: path, workspace: workspaceOf(path), content: '', isDirty: false })
      }

      const specialMeta: Array<Partial<Tab> & { type: string }> = specialRaw ? JSON.parse(specialRaw) : []
      const specialTabs: Tab[] = specialMeta.map(m => ({
        id: nextId++, title: m.title ?? '', filePath: '', content: '', isDirty: false,
        type: m.type as Tab['type'], ...(m as Partial<Tab>),
      }))

      nextIdRef.current = nextId
      const allTabs = [...queryTabs, ...specialTabs]
      setTabs(allTabs)
      const active = allTabs.find(t => t.filePath && t.filePath === activePath) ?? allTabs[0]
      setActiveIdState(active.id)
    } catch (e) {
      console.error('Session restore failed:', e)
      setTabs([{ id: 1, title: 'Query 1', filePath: '', content: '', isDirty: false }])
      setActiveIdState(1)
      nextIdRef.current = 2
    } finally {
      setRestored(true)
    }
  }, [])

  useEffect(() => { loadTabs() }, [loadTabs])

  const setActiveId = useCallback((id: number) => {
    setActiveIdState(id)
    const tab = tabsRef.current.find(t => t.id === id)
    if (tab?.filePath) persistActivePath(tab.filePath)
  }, [])

  // ── Open an existing query (focus if already open) ────────────────────────
  const openQueryByPath = useCallback(async (path: string) => {
    const open = tabsRef.current.find(t => t.filePath === path)
    if (open) { setActiveId(open.id); return }
    const content = await invoke<string>('read_query_file', { path }).catch(() => null)
    if (content === null) return // stale entry
    const id = nextIdRef.current++
    setTabs(prev => {
      const next = [...prev, { id, title: stemOf(path), filePath: path, workspace: workspaceOf(path), content, isDirty: false }]
      persistOpenTabs(next)
      return next
    })
    setActiveIdState(id)
    persistActivePath(path)
  }, [setActiveId])

  // ── Create a query in a workspace and open it ─────────────────────────────
  const createQuery = useCallback(async (workspace: string, title?: string) => {
    // Default name: next free "Query N" among currently-open titles (backend
    // still guarantees filesystem uniqueness within the workspace).
    let name = title
    if (!name) {
      const taken = new Set(tabsRef.current.map(t => t.title))
      let n = 1
      while (taken.has(`Query ${n}`)) n++
      name = `Query ${n}`
    }
    const path = await invoke<string>('create_query', { workspace, name }).catch(e => {
      console.error('Failed to create query:', e); return null
    })
    if (path) await openQueryByPath(path)
  }, [openQueryByPath])

  const openQueryTab = useCallback(async () => {
    const active = tabsRef.current.find(t => t.id === activeIdRef.current)
    await createQuery(active?.workspace ?? 'Default')
  }, [createQuery])

  const openSpecialTab = useCallback((type: Tab['type'], title: string, extra?: Partial<Tab>) => {
    const existing = tabsRef.current.find(t => {
      if (t.type !== type) return false
      if (t.connectionId !== (extra as { connectionId?: string } | undefined)?.connectionId) return false
      if (type === 'table-details') return (t as Tab & { schema?: string; table?: string }).schema === (extra as { schema?: string })?.schema && (t as Tab & { table?: string }).table === (extra as { table?: string })?.table
      if (type === 'schema-details') return (t as Tab & { schema?: string }).schema === (extra as { schema?: string })?.schema
      return true
    })
    if (existing) { setActiveIdState(existing.id); return }
    const id = nextIdRef.current++
    setTabs(prev => {
      const next = [...prev, { id, title, filePath: '', content: '', isDirty: false, type, ...extra }]
      persistSpecialTabs(next)
      return next
    })
    setActiveIdState(id)
  }, [])

  // ── Close a tab — keeps the saved query file (delete is a workspace action) ─
  const closeTab = useCallback((id: number) => {
    const existing = saveTimers.current.get(id)
    if (existing) clearTimeout(existing)
    saveTimers.current.delete(id)

    setTabs(prev => {
      if (prev.length <= 1) return prev
      const idx  = prev.findIndex(t => t.id === id)
      if (idx === -1) return prev
      const next = prev.filter(t => t.id !== id)
      if (id === activeIdRef.current) {
        const newActive = next[Math.min(idx, next.length - 1)]
        if (newActive) {
          setActiveIdState(newActive.id)
          if (newActive.filePath) persistActivePath(newActive.filePath)
        }
      }
      persistOpenTabs(next)
      persistSpecialTabs(next)
      return next
    })
  }, [])

  const closeQueryByPath = useCallback((path: string) => {
    const tab = tabsRef.current.find(t => t.filePath === path)
    if (tab) closeTab(tab.id)
  }, [closeTab])

  const closeWorkspaceTabs = useCallback((workspace: string) => {
    tabsRef.current.filter(t => t.workspace === workspace).forEach(t => closeTab(t.id))
  }, [closeTab])

  const updateContent = useCallback((id: number, content: string) => {
    setTabs(prev => prev.map(t => t.id === id ? { ...t, content, isDirty: true } : t))
    const existing = saveTimers.current.get(id)
    if (existing) clearTimeout(existing)
    const timer = setTimeout(async () => {
      saveTimers.current.delete(id)
      const tab = tabsRef.current.find(t => t.id === id)
      if (!tab || !tab.filePath) return
      try {
        await invoke('write_query_file', { path: tab.filePath, content })
        setTabs(prev => prev.map(t => t.id === id ? { ...t, isDirty: false } : t))
      } catch (e) {
        console.error(`Save failed for tab ${id}:`, e)
      }
    }, 800)
    saveTimers.current.set(id, timer)
  }, [])

  // ── Rename: moves the file within its workspace, keeping history ──────────
  const renameTab = useCallback(async (id: number, newTitle: string) => {
    const existing = saveTimers.current.get(id)
    if (existing) { clearTimeout(existing); saveTimers.current.delete(id) }
    const tab = tabsRef.current.find(t => t.id === id)
    if (!tab || !tab.filePath || tab.title === newTitle || !newTitle.trim()) return
    if (tab.isDirty) {
      try {
        await invoke('write_query_file', { path: tab.filePath, content: tab.content })
        setTabs(prev => prev.map(t => t.id === id ? { ...t, isDirty: false } : t))
      } catch { /* non-fatal */ }
    }
    const dir = tab.filePath.substring(0, tab.filePath.lastIndexOf('/'))
    const newPath = `${dir}/${newTitle}.sql`
    try {
      await invoke('rename_query_file', { oldPath: tab.filePath, newPath })
      setTabs(prev => {
        const next = prev.map(t => t.id === id ? { ...t, title: newTitle, filePath: newPath } : t)
        persistOpenTabs(next)
        persistConnMap(next)
        return next
      })
      persistActivePath(newPath)
    } catch (e) {
      console.error('Rename failed:', e)
    }
  }, [])

  const setTabConnection = useCallback((id: number, connectionId: string | undefined, connectionName: string | undefined) => {
    setTabs(prev => {
      const updated = prev.map(t => t.id === id ? { ...t, connectionId, connectionName } : t)
      persistConnMap(updated)
      return updated
    })
  }, [])

  const setTabDatabase = useCallback((id: number, database: string | undefined) => {
    setTabs(prev => {
      const updated = prev.map(t => t.id === id ? { ...t, database } : t)
      persistConnMap(updated)
      return updated
    })
  }, [])

  const setTabQueryLimit = useCallback((id: number, limit: number | undefined) => {
    setTabs(prev => prev.map(t => t.id === id ? { ...t, queryLimit: limit } : t))
  }, [])

  return (
    <TabsContext.Provider value={{
      tabs, activeId, restored,
      setActiveId, openQueryTab, createQuery, openQueryByPath, closeQueryByPath, closeWorkspaceTabs,
      openSpecialTab, closeTab, updateContent, renameTab, reloadTabs: loadTabs,
      setTabConnection, setTabDatabase, setTabQueryLimit,
    }}>
      {children}
    </TabsContext.Provider>
  )
}

export const useTabs = () => useContext(TabsContext)
