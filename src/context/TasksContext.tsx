import { createContext, useContext, useState, useCallback, useRef, useEffect } from 'react'
import { invoke } from '@tauri-apps/api/core'

const DOCK_SETTING = 'activity_docked'

export type TaskKind = 'query' | 'load-more' | 'schema' | 'connection'

export interface Task {
  id: string             // caller-stable, e.g. `query:${resultTabId}`
  kind: TaskKind
  label: string          // tab title / "Schema · mydb" / "Heartbeat"
  detail?: string        // SQL preview for queries
  connectionId?: string  // present when the task can be cancelled
  cancellable?: boolean  // true only for `query`
  background?: boolean    // schema / connection → subdued, not counted in the badge
  startedAt: number      // Date.now() at registration, for the live elapsed timer
}

interface TasksContextValue {
  tasks: Task[]
  startTask: (task: Omit<Task, 'startedAt'>) => void
  endTask: (id: string) => void
  cancelTask: (id: string) => void
  // Activity panel placement: floating popover (false) vs docked bottom tab (true).
  docked: boolean
  // Whether the panel is currently shown (popover open / dock visible).
  dockOpen: boolean
  setDocked: (v: boolean) => void
  setDockOpen: (v: boolean) => void
}

// No-op default (matches ConnectionContext): useTasks() outside a provider is a
// harmless no-op, so consumers/tests that don't wrap with TasksProvider still work.
const TasksContext = createContext<TasksContextValue>({
  tasks: [],
  startTask: () => {},
  endTask: () => {},
  cancelTask: () => {},
  docked: false,
  dockOpen: false,
  setDocked: () => {},
  setDockOpen: () => {},
})

export function TasksProvider({ children }: { children: React.ReactNode }) {
  const [tasks, setTasks] = useState<Task[]>([])
  // Mirror of `tasks` so cancelTask (stable, no deps) can read the latest list.
  const tasksRef = useRef<Task[]>([])
  tasksRef.current = tasks

  const startTask = useCallback((task: Omit<Task, 'startedAt'>) => {
    const entry: Task = { ...task, startedAt: Date.now() }
    // Overwrite any existing task with the same id (a re-run reuses its id).
    setTasks(prev => [...prev.filter(t => t.id !== entry.id), entry])
  }, [])

  const endTask = useCallback((id: string) => {
    setTasks(prev => prev.filter(t => t.id !== id))
  }, [])

  const cancelTask = useCallback((id: string) => {
    const task = tasksRef.current.find(t => t.id === id)
    if (!task?.cancellable || !task.connectionId) return
    // Best-effort: the query's own error path removes the task via endTask.
    invoke('cancel_query', { connectionId: task.connectionId }).catch(() => {})
  }, [])

  // Activity panel dock state. Persisted; when docked, the panel shows on launch.
  const [docked, setDockedState] = useState(false)
  const [dockOpen, setDockOpen]  = useState(false)
  useEffect(() => {
    invoke<string | null>('get_setting', { key: DOCK_SETTING })
      .then(v => { if (v === 'true') { setDockedState(true); setDockOpen(true) } })
      .catch(() => {})
  }, [])
  const setDocked = useCallback((v: boolean) => {
    setDockedState(v)
    setDockOpen(true) // keep the panel visible across the mode switch
    invoke('set_setting', { key: DOCK_SETTING, value: v ? 'true' : 'false' }).catch(() => {})
  }, [])

  return (
    <TasksContext.Provider value={{ tasks, startTask, endTask, cancelTask, docked, dockOpen, setDocked, setDockOpen }}>
      {children}
    </TasksContext.Provider>
  )
}

export const useTasks = () => useContext(TasksContext)
