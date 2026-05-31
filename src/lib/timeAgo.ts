// Relative-time formatter for "last fetched" labels. Coarse on purpose —
// cache freshness only needs human-scale buckets, not seconds-perfect output.

const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR

/**
 * Human-readable age of an epoch-ms timestamp relative to now.
 * "just now" (<5s), "Ns ago", "Nm ago", "Nh ago", else an absolute date.
 */
export function timeAgo(fetchedAt: number, now: number = Date.now()): string {
  const diff = now - fetchedAt
  if (diff < 5_000) return 'just now'
  if (diff < MIN) return `${Math.floor(diff / 1000)}s ago`
  if (diff < HOUR) return `${Math.floor(diff / MIN)}m ago`
  if (diff < DAY) return `${Math.floor(diff / HOUR)}h ago`
  return new Date(fetchedAt).toLocaleDateString()
}
