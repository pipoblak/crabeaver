# Optimistic Cache Layer — Design

**Date:** 2026-05-30
**Status:** Approved (pending spec review)

## Problem

Most read/introspection `invoke()` calls in the frontend refetch on every mount,
showing a loading spinner each time even when the data was just fetched. Only two
surfaces cache today:

- **SqlEditor completion schema** — full stale-while-revalidate (module `Map` +
  `localStorage`, 5-min soft / 30-min hard TTL). The gold-standard pattern, but it
  never tells the user *when* the data was fetched and offers no manual refresh.
- **Query results** — `localStorage` per tab file path (2 MB cap).

Everything else is uncached:

- `get_schema_details` (SchemaDetailsTab) — refetch + spinner every open.
- `get_table_details` (TableDetailsTab) — refetch + spinner every open.
- Sidebar `list_databases` / `get_schemas` — in-memory `useState` only; lost on
  unmount, disconnect, and app restart.
- `get_sessions` (SessionManagerTab) / `get_locks` (LockManagerTab) — refetch on
  open; no last snapshot.
- `has_password` (ConnectionsSection), `list_databases` (EditorTabs) — small repeat
  reads.

## Goals

1. **Optimistic cache everywhere it helps** — show last-known data instantly, refresh
   in the background.
2. **Always show "last fetched"** for every cached surface, with a manual refresh
   control.
3. **One reusable abstraction** — collapse the bespoke SqlEditor pattern into a
   generic store + hook so every consumer shares TTL / persistence /
   stale-while-revalidate / age-reporting logic.

Non-goals: caching mutations or volatile health signals (`connect`, `disconnect`,
`set_setting`, `write/rename/delete_query_file`, `test_connection`, `cancel_query`,
`connection_status`, `list_connections`, biometric calls). These stay live.

## Architecture

Two new core modules plus one UI component, then per-consumer swaps.

### `src/lib/cache.ts` — generic cache store

```ts
export interface CacheEntry<T> { data: T; fetchedAt: number }

interface NamespaceConfig {
  /** localStorage hard TTL — entry dropped on read if older. */
  hardTtlMs: number
  /** persist to localStorage (default true). false = in-memory only. */
  persist?: boolean
}
```

- Module-level `Map<string, CacheEntry<unknown>>` for in-memory (survives tab
  switches / component remounts within a session).
- `localStorage` mirror under key `cb:cache:<namespace>:<key>`, gated by
  `persist`. Hard TTL drop on read (mirrors `loadFromStorage` today).
- API:
  - `cacheGet<T>(ns, key): CacheEntry<T> | null` — in-memory first, then
    localStorage (warming memory on hit), dropping entries past `hardTtlMs`.
  - `cacheSet<T>(ns, key, data): CacheEntry<T>` — stamps `fetchedAt = Date.now()`,
    writes both layers (localStorage best-effort, swallows quota).
  - `cacheDelete(ns, key)` / `cacheClear(ns)` — for disconnect / invalidation.
- Namespaces register their config once (TTLs below). Unknown namespace = sane
  default (persist, 30-min hard TTL).

The `fetchedAt`-as-version idea SqlEditor uses for Rust index priming is preserved
by exposing `fetchedAt` on every entry.

### `src/hooks/useCachedResource.ts` — stale-while-revalidate hook

```ts
function useCachedResource<T>(opts: {
  namespace: string
  key: string | null        // null = disabled (e.g. no connectionId yet)
  fetcher: () => Promise<T>
  softTtlMs?: number         // bg-refresh threshold; default 5 min
  enabled?: boolean          // extra gate; default true
}): {
  data: T | null
  error: string | null       // fatal: cold fetch failed, no cached data
  loading: boolean           // true only when NO cached data yet
  refreshing: boolean        // bg refresh in flight over existing data
  staleError: string | null  // bg refresh failed; stale data still shown
  fetchedAt: number | null
  refresh: () => void        // force immediate refetch
}
```

Behavior (lifted directly from `SqlEditor.tsx:279-294`, generalized):

1. `key === null` or `!enabled` → idle, no fetch.
2. On key change: read `cacheGet`.
   - **Hit** → set `data` immediately, `loading = false`. If
     `Date.now() - fetchedAt > softTtlMs` → kick bg refresh (`refreshing = true`).
   - **Miss** → `loading = true`, fetch, `cacheSet`, populate.
3. `refresh()` → always refetch now; keeps current data visible while in flight.
4. Bg/`refresh()` failure → keep stale data, set `staleError`, leave `fetchedAt`.
   Cold failure → fatal `error`.
5. `fetcher` identity is held in a ref so callers can pass inline closures without
   retriggering; the effect keys off `[namespace, key, enabled]`.

`fetcher` does NOT need to be the raw `invoke` — consumers can post-process (e.g.
SqlEditor flattens schema infos into its index shape inside the fetcher).

### `src/components/CacheFooter.tsx` — "last fetched" bar

Thin bar rendered at the bottom of each cached view.

```
Updated 2m ago   ⟳
```

- `timeAgo(fetchedAt)` util (`src/lib/timeAgo.ts`): "just now", "Ns ago", "Nm ago",
  "Nh ago", or absolute date past a day. Re-renders on a shared 30 s interval
  (internal `useEffect` tick; cleared on unmount).
- `⟳` icon → `onRefresh()`. Spins (`animate-spin`) while `refreshing`.
- `staleError` → append " · refresh failed" in `--error-text`; stale data stays.
- Props: `{ fetchedAt: number | null; refreshing: boolean; staleError?: string | null;
  onRefresh: () => void; label?: string }`. `label` overrides "Updated" (e.g.
  "Sessions as of" for live monitors).
- Styling matches existing footers (`--border` top, `--sidebar-bg`, `text-[10px]
  text-th-dim`), consistent with `SectionHeader` / `StatusBar`.

## Consumers

### Tier A — Core ask

**SchemaDetailsTab** (`SchemaDetailsTab.tsx:33-49`)
- Replace `useState/useEffect/invoke` triplet with:
  ```ts
  const { data: details, loading, error, refreshing, staleError, fetchedAt, refresh } =
    useCachedResource<SchemaDetails>({
      namespace: 'schema-details',
      key: connectionId ? `${connectionId}:${schema}` : null,
      fetcher: () => invoke('get_schema_details', { connectionId, schema }),
    })
  ```
- Spinner only on cold load (`loading && !details`). Otherwise render cached
  instantly. Add `<CacheFooter>` at the bottom of the content pane.

**TableDetailsTab** (`TableDetailsTab.tsx:25-40`)
- Same swap, namespace `table-details`, key
  `${connectionId}:${schema}:${table}`.
- `<CacheFooter>` in the section-content column.

### Tier B — Persistence + age

**Sidebar tree** (`Sidebar.tsx:99-165`)
- Back `databases` and `schemas` loads with the cache store (namespaces
  `databases` key `${connId}`, `schemas` key `${connId}:${dbName}`), so an expand
  after restart paints from `localStorage` instantly then bg-refreshes.
- Keep the existing `LoadState` machine for the spinner/refreshing affordance, but
  seed initial state from `cacheGet` and write through `cacheSet` on success.
- On disconnect (`:173`), call `cacheDelete` for that connection's `databases` and
  `schemas` keys (both memory and localStorage) so a reconnect doesn't paint a tree
  from a dead session.
- Add a small `timeAgo` hint to the existing per-node refresh buttons' title
  attribute (tooltip), rather than a full footer in the dense tree.

**SqlEditor completion schema** (`SqlEditor.tsx:30-84, 279-294`)
- Migrate the bespoke `schemaCache` Map + `loadFromStorage/saveToStorage` onto the
  cache store (namespace `schema`, key `${connectionId}:${database ?? ''}`,
  softTtl 5 min, hardTtl 30 min). Preserve `set_schema_index` priming via the
  entry's `fetchedAt` and the existing `primedVersions` map (unchanged).
- Expose `fetchedAt` to the editor's status surface so the schema age + a refresh
  control appear near the existing schema-status indicator (reuse `CacheFooter` or
  feed `onSchemaStatus`). This is the one piece that gives the already-working
  cache a visible "last fetched".

**Query results** (`EditorTabs.tsx:34-109`)
- Storage stays as-is (separate 2 MB-capped scheme). Add a `fetchedAt` to the
  cached `TabResults` payload and surface it in the results footer
  (`ResultsPane`) next to `executionMs` — "fetched 3m ago". No bg refresh (results
  are query output, not introspection); refresh = re-run query, already available.

### Tier C — Live-monitor snapshot cache

**SessionManagerTab** (`SessionManagerTab.tsx:66`) and **LockManagerTab**
(`LockManagerTab.tsx:66`)
- Wrap `get_sessions` / `get_locks` in `useCachedResource` with a short
  `softTtlMs` (~15 s) and `hardTtlMs` (~2 min), namespaces `sessions` / `locks`,
  key `${connectionId}`.
- On reopen, show the last snapshot instantly, bg-refresh. `<CacheFooter
  label="… as of">` makes staleness explicit. Existing manual-refresh button wires
  to `refresh()`.

### Tier D — Small wins

**`has_password`** (`ConnectionsSection.tsx:73`)
- Cache per `connectionId`, namespace `has-password`, in-memory + localStorage,
  long hard TTL. Invalidate (`cacheDelete`) on add/update/delete connection and on
  enabling biometric — i.e. wherever password state can change.

**`list_databases`** (`EditorTabs.tsx:143`)
- Reuse namespace `databases` key `${connectionId}` (shared with Sidebar — same
  data), softTtl 5 min. Both surfaces benefit from one cache.

## Namespace TTL table

| Namespace        | softTtl | hardTtl | persist | invalidate on |
|------------------|---------|---------|---------|---------------|
| `schema`         | 5 min   | 30 min  | yes     | reconnect (epoch) |
| `schema-details` | 5 min   | 30 min  | yes     | manual refresh |
| `table-details`  | 5 min   | 30 min  | yes     | manual refresh |
| `databases`      | 5 min   | 30 min  | yes     | disconnect |
| `schemas`        | 5 min   | 30 min  | yes     | disconnect |
| `sessions`       | 15 s    | 2 min   | no      | manual refresh |
| `locks`          | 15 s    | 2 min   | no      | manual refresh |
| `has-password`   | 1 h     | 24 h    | yes     | conn add/update/delete, biometric enable |

(`sessions`/`locks` are in-memory only — no point persisting volatile monitor data
across restarts.)

## Error handling

- **Cold fetch fails** → fatal `error`, existing error UI (`XCircle` + message).
- **Bg/manual refresh fails over cached data** → `staleError`; data stays visible,
  footer shows "… · refresh failed". Never blank a populated view on a refresh
  error.
- **localStorage quota / parse errors** → swallowed (best-effort), as today.

## Testing

- **`cache.ts` unit tests** (Vitest if present; else co-located): get/set/delete
  round-trip; hard-TTL drop on read; in-memory hit warms from localStorage;
  unknown-namespace default; quota error swallowed.
- **`useCachedResource` tests** (React Testing Library): cold load → loading→data;
  cache hit → no loading, no fetch when fresh; stale hit → data immediately +
  refreshing→data; refresh() forces fetch; bg failure keeps data + sets staleError;
  cold failure sets fatal error; key=null disables.
- **`timeAgo` unit tests**: boundaries (just now / s / m / h / day).
- **Manual / integration**: open SchemaDetailsTab twice → second open paints
  instantly with footer; disconnect clears sidebar cache; sessions show "as of"
  and refresh.

Match whatever test runner the repo already uses; if none for frontend, add Vitest
config only if trivial, otherwise keep logic in pure functions covered by node
tests.

## Files

New:
- `src/lib/cache.ts`
- `src/lib/timeAgo.ts`
- `src/hooks/useCachedResource.ts`
- `src/components/CacheFooter.tsx`

Modified:
- `src/components/SchemaDetailsTab.tsx`
- `src/components/TableDetailsTab.tsx`
- `src/components/Sidebar.tsx`
- `src/components/SqlEditor.tsx`
- `src/components/SessionManagerTab.tsx`
- `src/components/LockManagerTab.tsx`
- `src/components/EditorTabs.tsx` + `src/components/ResultsPane.tsx` (results footer)
- `src/components/settings/ConnectionsSection.tsx`

No backend (Rust) changes — this is purely a frontend caching layer over existing
`invoke` commands.
