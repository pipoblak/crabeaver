import { createContext, useContext, useState, useCallback, useEffect, useRef } from 'react'
import { invoke } from '@tauri-apps/api/core'
import type { Tab } from '@/lib/tabs'

interface QueryFileMeta {
  name: string
  path: string
}

interface TabsContextValue {
  tabs: Tab[]
  activeId: number
  restored: boolean
  setActiveId: (id: number) => void
  openQueryTab: () => Promise<void>
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

  // Keep tabsRef in sync so callbacks can read current tabs without stale closures
  useEffect(() => { tabsRef.current = tabs }, [tabs])

  // Keep activeIdRef in sync so closeTab never captures a stale activeId
  useEffect(() => { activeIdRef.current = activeId }, [activeId])

  // Clear all pending save timers on unmount
  useEffect(() => {
    return () => {
      saveTimers.current.forEach(t => clearTimeout(t))
      saveTimers.current.clear()
    }
  }, [])

  const loadTabs = useCallback(async () => {
    saveTimers.current.forEach(t => clearTimeout(t))
    saveTimers.current.clear()
    setRestored(false)

    try {
      const files = await invoke<QueryFileMeta[]>('list_query_files')

      if (files.length === 0) {
        const dir = await invoke<string>('get_queries_dir')
        const filePath = `${dir}/Query 1.sql`
        await invoke('write_query_file', { path: filePath, content: '' })
        nextIdRef.current = 2
        setTabs([{ id: 1, title: 'Query 1', filePath, content: '', isDirty: false }])
        setActiveIdState(1)
      } else {
        // Load tab connections map alongside file contents
        const [loadedTabs, connMapRaw] = await Promise.all([
          Promise.all(files.map(async (f, i) => {
            const id = i + 1
            const content = await invoke<string>('read_query_file', { path: f.path })
            return { id, title: f.name, filePath: f.path, content, isDirty: false } as Tab
          })),
          invoke<string | null>('get_setting', { key: 'tab_query_connections' }).catch(() => null),
        ])

        const connMap: Record<string, { id: string; name: string; database?: string }> = connMapRaw
          ? JSON.parse(connMapRaw)
          : {}
        const tabsWithConns = loadedTabs.map(t => ({
          ...t,
          connectionId:   connMap[t.title]?.id,
          connectionName: connMap[t.title]?.name,
          database:       connMap[t.title]?.database,
        }))

        // Also restore special tabs (session-manager, lock-manager, table-details)
        const specialRaw = await invoke<string | null>('get_setting', { key: 'open_special_tabs' }).catch(() => null)
        const specialMeta: Array<Partial<Tab> & { type: string }> = specialRaw ? JSON.parse(specialRaw) : []
        let nextId = tabsWithConns.length + 1
        const specialTabs: Tab[] = specialMeta.map(m => ({
          id:          nextId++,
          title:       m.title ?? '',
          filePath:    '',
          content:     '',
          isDirty:     false,
          type:        m.type as Tab['type'],
          connectionId:   (m as any).connectionId,
          connectionName: (m as any).connectionName,
          ...(m as any),
        }))

        nextIdRef.current = nextId
        const allTabs = [...tabsWithConns, ...specialTabs]
        setTabs(allTabs)

        const activeFile = await invoke<string | null>('get_setting', { key: 'active_query_file' })
        const activeTab = allTabs.find(t => t.title === activeFile) ?? allTabs[0]
        setActiveIdState(activeTab.id)
      }
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
    if (tab) {
      invoke('set_setting', { key: 'active_query_file', value: tab.title }).catch(() => {})
    }
  }, [])

  const openQueryTab = useCallback(async () => {
    try {
      const dir = await invoke<string>('get_queries_dir')
      const existing = new Set(tabsRef.current.map(t => t.title))
      let n = tabsRef.current.length + 1
      while (existing.has(`Query ${n}`)) n++
      const title = `Query ${n}`
      const filePath = `${dir}/${title}.sql`
      await invoke('write_query_file', { path: filePath, content: '' })
      const id = nextIdRef.current++
      setTabs(prev => [...prev, { id, title, filePath, content: '', isDirty: false }])
      setActiveIdState(id)
      invoke('set_setting', { key: 'active_query_file', value: title }).catch(() => {})
    } catch (e) {
      console.error('Failed to create query tab:', e)
    }
  }, [])

  const persistSpecialTabs = (tabs: Tab[]) => {
    const specials = tabs
      .filter(t => t.type && t.type !== 'query')
      .map(t => ({ ...t }))
    invoke('set_setting', { key: 'open_special_tabs', value: JSON.stringify(specials) }).catch(() => {})
  }

  const openSpecialTab = useCallback((type: Tab['type'], title: string, extra?: Partial<Tab>) => {
    const existing = tabsRef.current.find(t => {
      if (t.type !== type) return false
      if (t.connectionId !== (extra as any)?.connectionId) return false
      if (type === 'table-details') {
        return (t as any).schema === (extra as any)?.schema && (t as any).table === (extra as any)?.table
      }
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

  const closeTab = useCallback((id: number) => {
    const existing = saveTimers.current.get(id)
    if (existing) clearTimeout(existing)
    saveTimers.current.delete(id)

    const tab = tabsRef.current.find(t => t.id === id)
    // Delete the file so it doesn't reappear on next app launch
    if (tab?.filePath && (!tab.type || tab.type === 'query')) {
      invoke('delete_query_file', { path: tab.filePath }).catch(() => {})
    }

    setTabs(prev => {
      if (prev.length <= 1) return prev
      const idx  = prev.findIndex(t => t.id === id)
      const next = prev.filter(t => t.id !== id)
      if (id === activeIdRef.current) {
        const newActive = next[Math.min(idx, next.length - 1)]
        if (newActive) {
          setActiveIdState(newActive.id)
          invoke('set_setting', { key: 'active_query_file', value: newActive.title }).catch(() => {})
        }
      }
      persistSpecialTabs(next)
      return next
    })
  }, [])

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
        // isDirty stays true — content still in memory
      }
    }, 800)

    saveTimers.current.set(id, timer)
  }, [])

  const renameTab = useCallback(async (id: number, newTitle: string) => {
    const existing = saveTimers.current.get(id)
    if (existing) {
      clearTimeout(existing)
      saveTimers.current.delete(id)
    }
    const tab = tabsRef.current.find(t => t.id === id)
    if (!tab || tab.title === newTitle || !newTitle.trim()) return
    // Flush pending unsaved content before renaming
    if (tab.filePath && tab.isDirty) {
      try {
        await invoke('write_query_file', { path: tab.filePath, content: tab.content })
        setTabs(prev => prev.map(t => t.id === id ? { ...t, isDirty: false } : t))
      } catch {
        // Non-fatal: proceed with rename even if flush fails
      }
    }
    const dir = tab.filePath.substring(0, tab.filePath.lastIndexOf('/'))
    const newPath = `${dir}/${newTitle}.sql`
    try {
      await invoke('rename_query_file', { oldPath: tab.filePath, newPath })
      setTabs(prev => prev.map(t => t.id === id ? { ...t, title: newTitle, filePath: newPath } : t))
      invoke('set_setting', { key: 'active_query_file', value: newTitle }).catch(() => {})
    } catch (e) {
      console.error('Rename failed:', e)
      // title reverts — state unchanged
    }
  }, [])

  const persistConnMap = (tabs: Tab[]) => {
    const map: Record<string, { id: string; name: string; database?: string }> = {}
    tabs.forEach(t => {
      if (t.connectionId && t.connectionName)
        map[t.title] = { id: t.connectionId, name: t.connectionName, database: t.database }
    })
    invoke('set_setting', { key: 'tab_query_connections', value: JSON.stringify(map) }).catch(() => {})
  }

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
      setActiveId, openQueryTab, openSpecialTab, closeTab, updateContent, renameTab, reloadTabs: loadTabs,
      setTabConnection, setTabDatabase, setTabQueryLimit,
    }}>
      {children}
    </TabsContext.Provider>
  )
}

export const useTabs = () => useContext(TabsContext)
