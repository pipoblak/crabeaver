export type TabType = 'query' | 'session-manager' | 'lock-manager' | 'table-details' | 'schema-details'

export interface Tab {
  id:           number
  title:        string
  filePath:     string
  content:      string
  isDirty:      boolean
  type?:        TabType
  connectionId?: string
  connectionName?: string
  database?: string
  queryLimit?: number   // undefined = use app default (1000); 0 = no limit
}

export interface TabsState {
  tabs: Tab[]
  activeId: number
}

export function openTab(state: TabsState, id: number, filePath: string): TabsState {
  const n = state.tabs.length + 1
  return {
    tabs: [...state.tabs, { id, title: `Query ${n}`, filePath, content: '', isDirty: false }],
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
    tabs: state.tabs.map(t => t.id === id ? { ...t, content, isDirty: true } : t),
  }
}

export function markClean(state: TabsState, id: number): TabsState {
  return {
    ...state,
    tabs: state.tabs.map(t => t.id === id ? { ...t, isDirty: false } : t),
  }
}

// filePath defaults to a temp path so existing tests don't need to supply it
export function initialState(filePath = '/tmp/Query 1.sql'): TabsState {
  return {
    tabs: [{ id: 1, title: 'Query 1', filePath, content: '', isDirty: false }],
    activeId: 1,
  }
}
