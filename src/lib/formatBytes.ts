// Humanize a byte count for size badges: "1.5 GB", "820 MB", "3.0 TB".
// Base-1024 units (matches pg_size_pretty's KiB-as-kB convention closely enough
// for an at-a-glance sidebar badge). Whole bytes/KB show no decimal; MB and up
// show one.

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'] as const

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024
    unit++
  }
  // No decimals for B/KB (they're already small/whole-ish); one decimal above.
  const decimals = unit <= 1 ? 0 : 1
  return `${value.toFixed(decimals)} ${UNITS[unit]}`
}
