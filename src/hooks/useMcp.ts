import { useState, useCallback, useEffect } from 'react'
import { invoke } from '@tauri-apps/api/core'

export interface McpStatus { running: boolean; port: number; url: string; has_token: boolean }
export interface ClientTarget { id: string; name: string; installed: boolean; detected: boolean; can_setup: boolean }
export type ConnFlags = Record<string, { expose: boolean; allow_write: boolean }>

export function useMcp() {
  const [status, setStatus] = useState<McpStatus | null>(null)
  const [token, setToken] = useState<string | null>(null)
  const [clients, setClients] = useState<ClientTarget[]>([])
  const [flags, setFlags] = useState<ConnFlags>({})

  const refresh = useCallback(async () => {
    const [s, t, c, f] = await Promise.all([
      invoke<McpStatus>('mcp_status').catch(() => null),
      invoke<string | null>('mcp_get_token').catch(() => null),
      invoke<ClientTarget[]>('mcp_list_clients').catch(() => []),
      invoke<ConnFlags>('mcp_connection_flags').catch(() => ({})),
    ])
    if (s) setStatus(s)
    setToken(t); setClients(c); setFlags(f)
  }, [])

  useEffect(() => { refresh() }, [refresh])

  const start = useCallback(async () => { setStatus(await invoke<McpStatus>('mcp_start')) }, [])
  const stop  = useCallback(async () => { setStatus(await invoke<McpStatus>('mcp_stop')) }, [])
  const rotate = useCallback(async () => { setToken(await invoke<string>('mcp_rotate_token')) }, [])
  const setPort = useCallback(async (port: number) => { await invoke('mcp_set_port', { port }); await refresh() }, [refresh])
  const setupClient = useCallback(async (id: string) => { await invoke('mcp_setup_client', { clientId: id }); await refresh() }, [refresh])
  const setConnFlags = useCallback(async (connectionId: string, expose: boolean, allowWrite: boolean) => {
    await invoke('mcp_set_connection_flags', { connectionId, expose, allowWrite }); await refresh()
  }, [refresh])

  return { status, token, clients, flags, refresh, start, stop, rotate, setPort, setupClient, setConnFlags }
}
