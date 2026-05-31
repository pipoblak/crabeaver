import { useEffect, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import { timeAgo } from '@/lib/timeAgo'

// "Last fetched" bar shown at the bottom of cached views. Relative time
// re-renders on a 30s tick; the refresh icon spins while a background refresh
// is in flight and tolerates refresh failures without blanking the data above.

interface Props {
  fetchedAt: number | null
  refreshing: boolean
  staleError?: string | null
  onRefresh: () => void
  /** Override the leading word, e.g. "Sessions as of". Default "Updated". */
  label?: string
}

export default function CacheFooter({ fetchedAt, refreshing, staleError, onRefresh, label = 'Updated' }: Props) {
  // Re-render every 30s so the relative time stays current without per-second churn.
  const [, setTick] = useState(0)
  useEffect(() => {
    const id = setInterval(() => setTick(t => t + 1), 30_000)
    return () => clearInterval(id)
  }, [])

  return (
    <div
      className="flex items-center gap-2 px-3 py-1 text-[10px] text-th-dim shrink-0"
      style={{ borderTop: '1px solid var(--border)', background: 'var(--sidebar-bg)' }}
    >
      <span>
        {refreshing
          ? 'Refreshing…'
          : fetchedAt != null
            ? `${label} ${timeAgo(fetchedAt)}`
            : '—'}
        {staleError && !refreshing && (
          <span style={{ color: 'var(--error-text)' }}> · refresh failed</span>
        )}
      </span>
      <button
        onClick={onRefresh}
        disabled={refreshing}
        title="Refresh now"
        className="ml-auto flex items-center transition-colors hover:text-th-bright"
        style={{ cursor: refreshing ? 'default' : 'pointer' }}
      >
        <RefreshCw size={11} className={refreshing ? 'animate-spin' : ''} />
      </button>
    </div>
  )
}
