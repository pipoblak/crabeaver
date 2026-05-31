import { describe, it, expect, vi, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'

// Mock the Tauri bridge before importing the context (vi.mock is hoisted).
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async (cmd: string) => {
    if (cmd === 'list_connections') return []
    if (cmd === 'connection_status') return false
    return undefined
  }),
}))

import { invoke } from '@tauri-apps/api/core'
import { ConnectionProvider, useConnections } from './ConnectionContext'

const invokeMock = invoke as unknown as ReturnType<typeof vi.fn>

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

// The heartbeat pings each connected pool every 30s and drops any that no longer
// answer, so the StatusBar dot flips offline on a dropped connection.
describe('ConnectionContext heartbeat', () => {
  afterEach(() => {
    vi.useRealTimers()
    // Restore the default bridge behaviour for sibling tests.
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === 'list_connections') return []
      if (cmd === 'connection_status') return false
      return undefined
    })
  })

  function mockInvoke(pingResult: boolean) {
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === 'list_connections') return []
      if (cmd === 'connection_status') return false
      if (cmd === 'ping_connection') return pingResult
      return undefined
    })
  }

  // The provider runs reload() on mount, which resets `connected` from
  // list_connections. Flush it before marking, so it can't later wipe our state.
  async function flushMount() {
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
  }

  it('drops a connection whose ping fails', async () => {
    vi.useFakeTimers()
    mockInvoke(false)
    const { result } = renderHook(() => useConnections(), { wrapper })
    await flushMount()
    await act(async () => { result.current.markConnected('c1') })
    expect(result.current.isConnected('c1')).toBe(true)

    await act(async () => { await vi.advanceTimersByTimeAsync(30_000) })
    expect(result.current.isConnected('c1')).toBe(false)
  })

  it('keeps a connection whose ping succeeds', async () => {
    vi.useFakeTimers()
    mockInvoke(true)
    const { result } = renderHook(() => useConnections(), { wrapper })
    await flushMount()
    await act(async () => { result.current.markConnected('c1') })

    await act(async () => { await vi.advanceTimersByTimeAsync(30_000) })
    expect(result.current.isConnected('c1')).toBe(true)
  })

  it('does not ping while the tab is hidden', async () => {
    vi.useFakeTimers()
    mockInvoke(false)
    const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true)
    const { result } = renderHook(() => useConnections(), { wrapper })
    await flushMount()
    await act(async () => { result.current.markConnected('c1') })

    invokeMock.mockClear()
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000) })

    const pinged = invokeMock.mock.calls.some(c => c[0] === 'ping_connection')
    expect(pinged).toBe(false)
    expect(result.current.isConnected('c1')).toBe(true)
    hidden.mockRestore()
  })
})
