import { describe, it, expect, beforeEach, vi } from 'vitest'
import { renderHook, waitFor, act } from '@testing-library/react'
import { useCachedResource } from './useCachedResource'
import { cacheSet, cacheClear } from '@/lib/cache'

const NS = 'table-details' // persistent, 30min hard TTL

beforeEach(() => { localStorage.clear(); cacheClear(NS) })

describe('useCachedResource', () => {
  it('cold load: loading → data', async () => {
    const fetcher = vi.fn().mockResolvedValue({ n: 1 })
    const { result } = renderHook(() =>
      useCachedResource({ namespace: NS, key: 'k', fetcher }))

    expect(result.current.loading).toBe(true)
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.data).toEqual({ n: 1 })
    expect(result.current.fetchedAt).toBeTypeOf('number')
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('fresh cache hit: no loading, no fetch', async () => {
    cacheSet(NS, 'k', { n: 9 })
    const fetcher = vi.fn().mockResolvedValue({ n: 99 })
    const { result } = renderHook(() =>
      useCachedResource({ namespace: NS, key: 'k', fetcher }))

    expect(result.current.loading).toBe(false)
    expect(result.current.data).toEqual({ n: 9 })
    // give any stray async a tick
    await act(async () => { await Promise.resolve() })
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('stale cache hit: shows data immediately then background-refreshes', async () => {
    // softTtl -1 → any cached entry counts as stale, forcing a bg refresh
    cacheSet(NS, 'k', { n: 1 })
    const fetcher = vi.fn().mockResolvedValue({ n: 2 })
    const { result } = renderHook(() =>
      useCachedResource({ namespace: NS, key: 'k', fetcher, softTtlMs: -1 }))

    expect(result.current.data).toEqual({ n: 1 }) // instant stale
    expect(result.current.loading).toBe(false)
    await waitFor(() => expect(result.current.data).toEqual({ n: 2 }))
    expect(result.current.refreshing).toBe(false)
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('refresh() forces a refetch keeping data visible', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce({ n: 1 })
      .mockResolvedValueOnce({ n: 2 })
    const { result } = renderHook(() =>
      useCachedResource({ namespace: NS, key: 'k', fetcher }))
    await waitFor(() => expect(result.current.data).toEqual({ n: 1 }))

    act(() => result.current.refresh())
    expect(result.current.data).toEqual({ n: 1 }) // still visible
    await waitFor(() => expect(result.current.data).toEqual({ n: 2 }))
  })

  it('cold failure is fatal', async () => {
    const fetcher = vi.fn().mockRejectedValue('boom')
    const { result } = renderHook(() =>
      useCachedResource({ namespace: NS, key: 'k', fetcher }))
    await waitFor(() => expect(result.current.error).toBe('boom'))
    expect(result.current.data).toBeNull()
  })

  it('background-refresh failure keeps stale data and sets staleError', async () => {
    cacheSet(NS, 'k', { n: 1 })
    const fetcher = vi.fn().mockRejectedValue('net down')
    const { result } = renderHook(() =>
      useCachedResource({ namespace: NS, key: 'k', fetcher, softTtlMs: -1 }))
    await waitFor(() => expect(result.current.staleError).toBe('net down'))
    expect(result.current.data).toEqual({ n: 1 }) // stale data retained
    expect(result.current.error).toBeNull()
  })

  it('key=null disables fetching', async () => {
    const fetcher = vi.fn().mockResolvedValue({ n: 1 })
    const { result } = renderHook(() =>
      useCachedResource({ namespace: NS, key: null, fetcher }))
    await act(async () => { await Promise.resolve() })
    expect(fetcher).not.toHaveBeenCalled()
    expect(result.current.loading).toBe(false)
    expect(result.current.data).toBeNull()
  })
})
