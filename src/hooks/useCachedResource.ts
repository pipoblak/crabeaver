import { useCallback, useEffect, useRef, useState } from 'react'
import { cacheGet, cacheSet } from '@/lib/cache'

// Stale-while-revalidate over the generic cache store. Show last-known data
// instantly, refresh in the background. Generalizes the bespoke pattern that
// lived in SqlEditor's schema-fetch effect.

export interface CachedResource<T> {
  data: T | null
  /** Fatal: a cold fetch failed and there is no cached data to fall back on. */
  error: string | null
  /** True only while there is NO cached data yet (first load). */
  loading: boolean
  /** True while a background refresh is in flight over already-shown data. */
  refreshing: boolean
  /** A background/manual refresh failed; stale data is still shown. */
  staleError: string | null
  fetchedAt: number | null
  /** Force an immediate refetch, keeping current data visible meanwhile. */
  refresh: () => void
}

const DEFAULT_SOFT_TTL = 5 * 60 * 1000

interface Options<T> {
  namespace: string
  /** null disables the resource (e.g. no connection selected yet). */
  key: string | null
  fetcher: () => Promise<T>
  /** Background-refresh threshold. Default 5 min. */
  softTtlMs?: number
  enabled?: boolean
}

export function useCachedResource<T>(opts: Options<T>): CachedResource<T> {
  const { namespace, key, softTtlMs = DEFAULT_SOFT_TTL, enabled = true } = opts

  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [staleError, setStaleError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [fetchedAt, setFetchedAt] = useState<number | null>(null)

  // Hold the latest fetcher in a ref so callers can pass inline closures without
  // retriggering the effect; we key off [namespace, key, enabled] only.
  const fetcherRef = useRef(opts.fetcher)
  fetcherRef.current = opts.fetcher

  // Guards against state writes from a fetch whose key is no longer current.
  const reqId = useRef(0)

  const run = useCallback((cacheKey: string, isBackground: boolean) => {
    const id = ++reqId.current
    if (isBackground) setRefreshing(true)
    else setLoading(true)
    fetcherRef.current()
      .then(result => {
        if (id !== reqId.current) return
        const entry = cacheSet<T>(namespace, cacheKey, result)
        setData(result)
        setFetchedAt(entry.fetchedAt)
        setError(null)
        setStaleError(null)
      })
      .catch(e => {
        if (id !== reqId.current) return
        if (isBackground) setStaleError(String(e))   // keep stale data visible
        else setError(String(e))                     // cold failure is fatal
      })
      .finally(() => {
        if (id !== reqId.current) return
        setLoading(false)
        setRefreshing(false)
      })
  }, [namespace])

  useEffect(() => {
    reqId.current++ // invalidate any in-flight fetch from a previous key
    if (!enabled || key === null) {
      setData(null); setError(null); setStaleError(null)
      setLoading(false); setRefreshing(false); setFetchedAt(null)
      return
    }

    const cached = cacheGet<T>(namespace, key)
    if (cached) {
      setData(cached.data)
      setFetchedAt(cached.fetchedAt)
      setError(null); setStaleError(null); setLoading(false)
      if (Date.now() - cached.fetchedAt > softTtlMs) run(key, true)
      return
    }

    setData(null); setError(null); setStaleError(null); setFetchedAt(null)
    run(key, false)
  }, [namespace, key, enabled, softTtlMs, run])

  const refresh = useCallback(() => {
    if (!enabled || key === null) return
    run(key, data !== null) // background-style if data already shown
  }, [enabled, key, run, data])

  return { data, error, loading, refreshing, staleError, fetchedAt, refresh }
}
