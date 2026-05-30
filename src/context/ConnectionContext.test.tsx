import { describe, it, expect, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'

// Mock the Tauri bridge before importing the context (vi.mock is hoisted).
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async (cmd: string) => {
    if (cmd === 'list_connections') return []
    if (cmd === 'connection_status') return false
    return undefined
  }),
}))

import { ConnectionProvider, useConnections } from './ConnectionContext'

function wrapper({ children }: { children: React.ReactNode }) {
  return <ConnectionProvider>{children}</ConnectionProvider>
}

// Regression: after reconnecting, the editor must re-fetch schema so a stale
// connection error clears. That hinges on connect() bumping a per-connection
// epoch the editor depends on. (The Monaco-side refetch is wired off this signal.)
describe('ConnectionContext connectEpoch (reconnect signal)', () => {
  it('bumps the epoch on each connect of the same connection', async () => {
    const { result } = renderHook(() => useConnections(), { wrapper })
    expect(result.current.connectEpoch('c1')).toBe(0)
    await act(async () => { await result.current.connect('c1') })
    expect(result.current.connectEpoch('c1')).toBe(1)
    await act(async () => { await result.current.connect('c1') }) // reconnect
    expect(result.current.connectEpoch('c1')).toBe(2)
  })

  it('is scoped per connection id (reconnecting A does not signal B)', async () => {
    const { result } = renderHook(() => useConnections(), { wrapper })
    await act(async () => { await result.current.connect('a') })
    expect(result.current.connectEpoch('a')).toBe(1)
    expect(result.current.connectEpoch('b')).toBe(0)
  })

  it('disconnect does not bump the epoch', async () => {
    const { result } = renderHook(() => useConnections(), { wrapper })
    await act(async () => { await result.current.connect('c1') })
    const before = result.current.connectEpoch('c1')
    await act(async () => { await result.current.disconnect('c1') })
    expect(result.current.connectEpoch('c1')).toBe(before)
  })
})
