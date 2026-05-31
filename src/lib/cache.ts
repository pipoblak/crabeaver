// Generic optimistic cache store: in-memory Map (survives tab switches and
// component remounts within a session) mirrored to localStorage (survives app
// restart). Each entry is stamped with `fetchedAt` so consumers can show "last
// fetched" and decide when to background-refresh.
//
// Consumed by `useCachedResource`, which layers stale-while-revalidate on top.

export interface CacheEntry<T> {
  data: T
  /** epoch ms when the data was fetched. */
  fetchedAt: number
}

export interface NamespaceConfig {
  /** localStorage hard TTL — entries older than this are dropped on read. */
  hardTtlMs: number
  /** Persist to localStorage. false = in-memory only (volatile monitor data). */
  persist?: boolean
}

const DEFAULT_CONFIG: NamespaceConfig = { hardTtlMs: 30 * 60 * 1000, persist: true }

const MIN = 60 * 1000
const HOUR = 60 * MIN

// Per-namespace TTL / persistence. See the design's namespace table.
const NAMESPACES: Record<string, NamespaceConfig> = {
  'schema':         { hardTtlMs: 30 * MIN, persist: true },
  'schema-details': { hardTtlMs: 30 * MIN, persist: true },
  'table-details':  { hardTtlMs: 30 * MIN, persist: true },
  'databases':      { hardTtlMs: 30 * MIN, persist: true },
  'schemas':        { hardTtlMs: 30 * MIN, persist: true },
  'sessions':       { hardTtlMs: 2 * MIN,  persist: false },
  'locks':          { hardTtlMs: 2 * MIN,  persist: false },
  'has-password':   { hardTtlMs: 24 * HOUR, persist: true },
}

function configFor(ns: string): NamespaceConfig {
  return NAMESPACES[ns] ?? DEFAULT_CONFIG
}

// Module-level in-memory cache, keyed by `${namespace}:${key}`.
const memory = new Map<string, CacheEntry<unknown>>()

function memKey(ns: string, key: string) { return `${ns}:${key}` }
function lsKey(ns: string, key: string) { return `cb:cache:${ns}:${key}` }

function isExpired(entry: CacheEntry<unknown>, cfg: NamespaceConfig): boolean {
  return Date.now() - entry.fetchedAt > cfg.hardTtlMs
}

/**
 * Read an entry. In-memory first; on miss, fall back to localStorage (warming
 * the in-memory copy on hit). Entries past the namespace hard TTL are dropped
 * and treated as a miss. Returns null on miss.
 */
export function cacheGet<T>(ns: string, key: string): CacheEntry<T> | null {
  const cfg = configFor(ns)
  const mem = memory.get(memKey(ns, key)) as CacheEntry<T> | undefined
  if (mem) {
    if (isExpired(mem, cfg)) { cacheDelete(ns, key); return null }
    return mem
  }
  if (!cfg.persist) return null
  try {
    const raw = localStorage.getItem(lsKey(ns, key))
    if (!raw) return null
    const entry = JSON.parse(raw) as CacheEntry<T>
    if (isExpired(entry, cfg)) { localStorage.removeItem(lsKey(ns, key)); return null }
    memory.set(memKey(ns, key), entry) // warm in-memory
    return entry
  } catch { return null }
}

/** Write an entry, stamping `fetchedAt`. Persists to localStorage best-effort. */
export function cacheSet<T>(ns: string, key: string, data: T): CacheEntry<T> {
  const cfg = configFor(ns)
  const entry: CacheEntry<T> = { data, fetchedAt: Date.now() }
  memory.set(memKey(ns, key), entry)
  if (cfg.persist) {
    try { localStorage.setItem(lsKey(ns, key), JSON.stringify(entry)) } catch { /* quota */ }
  }
  return entry
}

/** Drop a single entry from both layers. */
export function cacheDelete(ns: string, key: string): void {
  memory.delete(memKey(ns, key))
  try { localStorage.removeItem(lsKey(ns, key)) } catch { /* ignore */ }
}

/** Drop every entry in a namespace (both layers). Used on disconnect. */
export function cacheClear(ns: string): void {
  const prefix = `${ns}:`
  for (const k of [...memory.keys()]) {
    if (k.startsWith(prefix)) memory.delete(k)
  }
  try {
    const lsPrefix = `cb:cache:${ns}:`
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i)
      if (k && k.startsWith(lsPrefix)) localStorage.removeItem(k)
    }
  } catch { /* ignore */ }
}
