export interface Tab {
  id: number
  title: string
  content: string
}

export interface TabsState {
  tabs: Tab[]
  activeId: number
}

export function openTab(state: TabsState, id: number): TabsState {
  const n = state.tabs.length + 1
  return {
    tabs: [...state.tabs, { id, title: `Query ${n}`, content: '' }],
    activeId: id,
  }
}

export function closeTab(state: TabsState, id: number): TabsState {
  if (state.tabs.length <= 1) return state
  const idx = state.tabs.findIndex(t => t.id === id)
  const tabs = state.tabs.filter(t => t.id !== id)
  const activeId = id === state.activeId
    ? tabs[Math.min(idx, tabs.length - 1)].id
    : state.activeId
  return { tabs, activeId }
}

export function updateContent(state: TabsState, id: number, content: string): TabsState {
  return {
    ...state,
    tabs: state.tabs.map(t => t.id === id ? { ...t, content } : t),
  }
}

export function initialState(): TabsState {
  return { tabs: [{ id: 1, title: 'Query 1', content: '' }], activeId: 1 }
}
