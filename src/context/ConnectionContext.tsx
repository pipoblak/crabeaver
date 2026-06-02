import { createContext, useContext, useState, useCallback, useEffect, useRef } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { useTaskActions } from '@/context/TasksContext'

interface Connection { id: string; name: string; driver: string; host: string; port: number; database: string }

interface ConnectionContextValue {
  connections:    Connection[]
  connected:      Set<string>
  reload:         () => Promise<void>
  connect:        (id: string) => Promise<void>
  disconnect:     (id: string) => Promise<void>
  isConnected:    (id: string) => boolean
  markConnected:  (id: string) => void
  /** Increments each time `connect(id)` runs — consumers use it to re-fetch
   *  connection-derived state (schema, completions) after a (re)connect. */
  connectEpoch:   (id: string) => number
}

const ConnectionContext = createContext<ConnectionContextValue>({
  connections: [], connected: new Set(),
  reload: async () => {}, connect: async () => {}, disconnect: async () => {},
  isConnected: () => false, markConnected: () => {}, connectEpoch: () => 0,
})

export function ConnectionProvider({ children }: { children: React.ReactNode }) {
  const [connections, setConnections]   = useState<Connection[]>([])
  const [connected, setConnected]       = useState(new Set<string>())
  // Bumped per connection on each explicit connect(), so the editor refetches
  // schema (and clears a stale connection error) after a reconnect.
  const [connectEpochs, setConnectEpochs] = useState<Record<string, number>>({})

  const { startTask, endTask } = useTaskActions()

  const reload = useCallback(async () => {
    startTask({ id: 'revalidate', kind: 'connection', label: 'Checking connections', background: true })
    try {
      const list = await invoke<Connection[]>('list_connections').catch(() => [])
      setConnections(list)
      const statuses = await Promise.all(
        list.map(c => invoke<boolean>('connection_status', { id: c.id }).catch(() => false))
      )
      setConnected(new Set(list.filter((_, i) => statuses[i]).map(c => c.id)))
    } finally {
      endTask('revalidate')
    }
  }, [startTask, endTask])

  useEffect(() => { reload() }, [reload])

  // Periodic heartbeat: ping each connected pool with a real `SELECT 1` and drop
  // any that no longer answer, so the status dot flips offline on a dropped
  // connection. Pauses while the tab is hidden; fires once on refocus.
  const connectedRef = useRef(connected)
  connectedRef.current = connected
  useEffect(() => {
    const HEARTBEAT_MS = 30_000

    const beat = async () => {
      if (document.hidden) return
      const ids = [...connectedRef.current]
      if (ids.length === 0) return
      startTask({ id: 'heartbeat', kind: 'connection', label: 'Heartbeat', background: true })
      try {
        const alive = await Promise.all(
          ids.map(id => invoke<boolean>('ping_connection', { id }).catch(() => false))
        )
        const dead = ids.filter((_, i) => !alive[i])
        if (dead.length) {
          setConnected(prev => {
            const s = new Set(prev)
            dead.forEach(id => s.delete(id))
            return s
          })
        }
      } finally {
        endTask('heartbeat')
      }
    }

    const timer = setInterval(beat, HEARTBEAT_MS)
    const onVisible = () => { if (!document.hidden) beat() }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [])

  const connect = useCallback(async (id: string) => {
    await invoke('connect', { id })
    setConnected(prev => new Set([...prev, id]))
    setConnectEpochs(prev => ({ ...prev, [id]: (prev[id] ?? 0) + 1 }))
  }, [])

  const disconnect = useCallback(async (id: string) => {
    await invoke('disconnect', { id })
    setConnected(prev => { const s = new Set(prev); s.delete(id); return s })
  }, [])

  const isConnected   = useCallback((id: string) => connected.has(id), [connected])
  const markConnected = useCallback((id: string) => {
    setConnected(prev => prev.has(id) ? prev : new Set([...prev, id]))
  }, [])
  const connectEpoch  = useCallback((id: string) => connectEpochs[id] ?? 0, [connectEpochs])

  return (
    <ConnectionContext.Provider value={{
      connections, connected,
      reload, connect, disconnect, isConnected, markConnected, connectEpoch,
    }}>
      {children}
    </ConnectionContext.Provider>
  )
}

export const useConnections = () => useContext(ConnectionContext)
