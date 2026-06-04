import { useState, useCallback, useEffect } from 'react'
import { invoke } from '@tauri-apps/api/core'

export interface McpStatus { running: boolean; port: number; url: string; has_token: boolean; autostart: boolean }
export interface ClientTarget { id: string; name: string; installed: boolean; detected: boolean; can_setup: boolean }
export interface ActivityEntry { at: number; tool: string; connection: string; summary: string }
export type ConnFlags = Record<string, { expose: boolean; allow_write: boolean }>

const ACTIVITY_MAX = 100

export function useMcp() {
  const [status, setStatus] = useState<McpStatus | null>(null)
  const [token, setToken] = useState<string | null>(null)
  const [clients, setClients] = useState<ClientTarget[]>([])
  const [flags, setFlags] = useState<ConnFlags>({})
  const [activity, setActivity] = useState<ActivityEntry[]>([])

  const refresh = useCallback(async () => {
    const [s, t, c, f, a] = await Promise.all([
      invoke<McpStatus>('mcp_status').catch(() => null),
      invoke<string | null>('mcp_get_token').catch(() => null),
      invoke<ClientTarget[]>('mcp_list_clients').catch(() => []),
      invoke<ConnFlags>('mcp_connection_flags').catch(() => ({})),
      invoke<ActivityEntry[]>('mcp_recent_activity').catch(() => []),
    ])
    if (s) setStatus(s)
    setToken(t); setClients(c); setFlags(f)
    setActivity([...a].reverse()) // backend stores newest-last; show newest-first
  }, [])

  useEffect(() => { refresh() }, [refresh])

  // Live-ish activity: poll the ring buffer (avoids needing event:listen perms).
  useEffect(() => {
    const id = setInterval(async () => {
      const a = await invoke<ActivityEntry[]>('mcp_recent_activity').catch(() => null)
      if (a) setActivity([...a].reverse().slice(0, ACTIVITY_MAX))
    }, 2000)
    return () => clearInterval(id)
  }, [])

  const start = useCallback(async () => { setStatus(await invoke<McpStatus>('mcp_start')) }, [])
  const stop  = useCallback(async () => { setStatus(await invoke<McpStatus>('mcp_stop')) }, [])
  const rotate = useCallback(async () => { setToken(await invoke<string>('mcp_rotate_token')) }, [])
  const setAutostart = useCallback(async (on: boolean) => { await invoke('mcp_set_autostart', { on }); await refresh() }, [refresh])
  const setPort = useCallback(async (port: number) => { await invoke('mcp_set_port', { port }); await refresh() }, [refresh])
  const setupClient = useCallback(async (id: string) => { await invoke('mcp_setup_client', { clientId: id }); await refresh() }, [refresh])
  const setConnFlags = useCallback(async (connectionId: string, expose: boolean, allowWrite: boolean) => {
    await invoke('mcp_set_connection_flags', { connectionId, expose, allowWrite }); await refresh()
  }, [refresh])

  return { status, token, clients, flags, activity, refresh, start, stop, rotate, setAutostart, setPort, setupClient, setConnFlags }
}
