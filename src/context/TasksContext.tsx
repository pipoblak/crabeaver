import { createContext, useContext, useState, useCallback, useRef } from 'react'
import { invoke } from '@tauri-apps/api/core'

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
}

// No-op default (matches ConnectionContext): useTasks() outside a provider is a
// harmless no-op, so consumers/tests that don't wrap with TasksProvider still work.
const TasksContext = createContext<TasksContextValue>({
  tasks: [],
  startTask: () => {},
  endTask: () => {},
  cancelTask: () => {},
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

  return (
    <TasksContext.Provider value={{ tasks, startTask, endTask, cancelTask }}>
      {children}
    </TasksContext.Provider>
  )
}

export const useTasks = () => useContext(TasksContext)
