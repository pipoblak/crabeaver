import { createContext, useContext, useState, useCallback } from 'react'

export interface Tab {
  id: number
  title: string
  content: string
}

interface TabsContextValue {
  tabs: Tab[]
  activeId: number
  setActiveId: (id: number) => void
  openQueryTab: () => void
  closeTab: (id: number) => void
  updateContent: (id: number, content: string) => void
}

const TabsContext = createContext<TabsContextValue>(null!)

let nextId = 2

export function TabsProvider({ children }: { children: React.ReactNode }) {
  const [tabs, setTabs] = useState<Tab[]>([
    { id: 1, title: 'Query 1', content: '' },
  ])
  const [activeId, setActiveId] = useState(1)

  const openQueryTab = useCallback(() => {
    const id = nextId++
    // derive count inside updater to avoid stale closure
    setTabs(prev => {
      const n = prev.length + 1
      return [...prev, { id, title: `Query ${n}`, content: '' }]
    })
    setActiveId(id)
  }, [])

  const closeTab = useCallback((id: number) => {
    setTabs(prev => {
      if (prev.length <= 1) return prev
      const idx = prev.findIndex(t => t.id === id)
      const next = prev.filter(t => t.id !== id)
      // compute new active outside updater, then set separately
      const newActive = next[Math.min(idx, next.length - 1)]
      if (id === activeId && newActive) setActiveId(newActive.id)
      return next
    })
  }, [activeId])

  const updateContent = useCallback((id: number, content: string) => {
    setTabs(prev => prev.map(t => t.id === id ? { ...t, content } : t))
  }, [])

  return (
    <TabsContext.Provider value={{
      tabs, activeId, setActiveId,
      openQueryTab, closeTab, updateContent,
    }}>
      {children}
    </TabsContext.Provider>
  )
}

export const useTabs = () => useContext(TabsContext)
