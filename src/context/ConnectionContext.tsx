import { createContext, useContext, useState, useCallback, useEffect } from 'react'
import { invoke } from '@tauri-apps/api/core'

interface Connection { id: string; name: string; driver: string; host: string; port: number; database: string }

interface ConnectionContextValue {
  connections:    Connection[]
  connected:      Set<string>
  revalidating:   boolean          // true while checking connection statuses
  reload:         () => Promise<void>
  connect:        (id: string) => Promise<void>
  disconnect:     (id: string) => Promise<void>
  isConnected:    (id: string) => boolean
  markConnected:  (id: string) => void
}

const ConnectionContext = createContext<ConnectionContextValue>({
  connections: [], connected: new Set(), revalidating: false,
  reload: async () => {}, connect: async () => {}, disconnect: async () => {},
  isConnected: () => false, markConnected: () => {},
})

export function ConnectionProvider({ children }: { children: React.ReactNode }) {
  const [connections, setConnections]   = useState<Connection[]>([])
  const [connected, setConnected]       = useState(new Set<string>())
  const [revalidating, setRevalidating] = useState(false)

  const reload = useCallback(async () => {
    setRevalidating(true)
    try {
      const list = await invoke<Connection[]>('list_connections').catch(() => [])
      setConnections(list)
      const statuses = await Promise.all(
        list.map(c => invoke<boolean>('connection_status', { id: c.id }).catch(() => false))
      )
      setConnected(new Set(list.filter((_, i) => statuses[i]).map(c => c.id)))
    } finally {
      setRevalidating(false)
    }
  }, [])

  useEffect(() => { reload() }, [reload])

  const connect = useCallback(async (id: string) => {
    await invoke('connect', { id })
    setConnected(prev => new Set([...prev, id]))
  }, [])

  const disconnect = useCallback(async (id: string) => {
    await invoke('disconnect', { id })
    setConnected(prev => { const s = new Set(prev); s.delete(id); return s })
  }, [])

  const isConnected   = useCallback((id: string) => connected.has(id), [connected])
  const markConnected = useCallback((id: string) => {
    setConnected(prev => prev.has(id) ? prev : new Set([...prev, id]))
  }, [])

  return (
    <ConnectionContext.Provider value={{
      connections, connected, revalidating,
      reload, connect, disconnect, isConnected, markConnected,
    }}>
      {children}
    </ConnectionContext.Provider>
  )
}

export const useConnections = () => useContext(ConnectionContext)
