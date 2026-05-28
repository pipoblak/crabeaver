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
  closeTab: (id: number) => void
  updateContent: (id: number, content: string) => void
  renameTab: (id: number, newTitle: string) => Promise<void>
  reloadTabs: () => Promise<void>
}

const TabsContext = createContext<TabsContextValue>(null!)
let nextId = 1

export function TabsProvider({ children }: { children: React.ReactNode }) {
  const [tabs, setTabs] = useState<Tab[]>([])
  const [activeId, setActiveIdState] = useState(0)
  const [restored, setRestored] = useState(false)
  const saveTimers = useRef(new Map<number, ReturnType<typeof setTimeout>>())
  const tabsRef = useRef<Tab[]>([])

  // Keep tabsRef in sync so callbacks can read current tabs without stale closures
  useEffect(() => { tabsRef.current = tabs }, [tabs])

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
        nextId = 2
        setTabs([{ id: 1, title: 'Query 1', filePath, content: '', isDirty: false }])
        setActiveIdState(1)
      } else {
        const loadedTabs: Tab[] = await Promise.all(
          files.map(async (f, i) => {
            const id = i + 1
            const content = await invoke<string>('read_query_file', { path: f.path })
            return { id, title: f.name, filePath: f.path, content, isDirty: false }
          })
        )
        nextId = loadedTabs.length + 1
        setTabs(loadedTabs)

        const activeFile = await invoke<string | null>('get_setting', { key: 'active_query_file' })
        const activeTab = loadedTabs.find(t => t.title === activeFile) ?? loadedTabs[0]
        setActiveIdState(activeTab.id)
      }
    } catch (e) {
      console.error('Session restore failed:', e)
      setTabs([{ id: 1, title: 'Query 1', filePath: '', content: '', isDirty: false }])
      setActiveIdState(1)
      nextId = 2
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
      const id = nextId++
      setTabs(prev => [...prev, { id, title, filePath, content: '', isDirty: false }])
      setActiveIdState(id)
      invoke('set_setting', { key: 'active_query_file', value: title }).catch(() => {})
    } catch (e) {
      console.error('Failed to create query tab:', e)
    }
  }, [])

  const closeTab = useCallback((id: number) => {
    const existing = saveTimers.current.get(id)
    if (existing) clearTimeout(existing)
    saveTimers.current.delete(id)

    const current = tabsRef.current
    if (current.length <= 1) return
    const idx = current.findIndex(t => t.id === id)
    const next = current.filter(t => t.id !== id)
    setTabs(next)

    if (id === activeId) {
      const newActive = next[Math.min(idx, next.length - 1)]
      setActiveIdState(newActive.id)
      invoke('set_setting', { key: 'active_query_file', value: newActive.title }).catch(() => {})
    }
  }, [activeId])

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
    const tab = tabsRef.current.find(t => t.id === id)
    if (!tab || tab.title === newTitle || !newTitle.trim()) return
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

  return (
    <TabsContext.Provider value={{
      tabs, activeId, restored,
      setActiveId, openQueryTab, closeTab, updateContent, renameTab, reloadTabs: loadTabs,
    }}>
      {children}
    </TabsContext.Provider>
  )
}

export const useTabs = () => useContext(TabsContext)
