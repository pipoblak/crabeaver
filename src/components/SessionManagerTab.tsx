import { useState, useEffect, useCallback } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { RefreshCw, XCircle, Loader2, X } from 'lucide-react'
import ResizeHandle from '@/components/ResizeHandle'
import { beginResizeDrag } from '@/lib/resizeDrag'
import { useResize } from '@/hooks/useResize'
import { useCachedResource } from '@/hooks/useCachedResource'
import { timeAgo } from '@/lib/timeAgo'

const PRIV_ERR = '<insufficient privilege>'

function cleanQuery(q: string | null): string | null {
  if (!q || q === PRIV_ERR) return null
  return q
}

function queryDisplay(q: string | null): string {
  if (!q) return '—'
  if (q === PRIV_ERR) return '⚠ insufficient privilege'
  return q
}

interface Session {
  pid:              number
  usename:          string | null
  datname:          string | null
  applicationName:  string | null
  state:            string | null
  waitEvent:        string | null
  queryStart:       string | null
  query:            string | null
  clientAddr:       string | null
  clientPort:       number | null
  backendType:      string | null
}

interface Props {
  connectionId: string
  connectionName: string
}

const STATE_COLOR: Record<string, string> = {
  'active':              '#22c55e',
  'idle':                'var(--text-dim)',
  'idle in transaction': '#f59e0b',
  'idle in transaction (aborted)': '#ef4444',
  'fastpath function call': '#8b5cf6',
  'disabled':            'var(--text-dim)',
}

export default function SessionManagerTab({ connectionId, connectionName }: Props) {
  const [selected, setSelected]   = useState<Session | null>(null)
  const [autoRefresh, setAuto]    = useState(false)
  const [refreshInterval, setInterval_] = useState(5000)
  const [detailW, setDetailW]     = useState(256)
  const [sqlH, setSqlH]           = useState(120)
  const onDetailResize  = useCallback((w: number) => setDetailW(w), [])
  // The returned drag state is currently unwired, but useResize is kept (called
  // for its hook/side effects) so the resize handles still register.
  useResize(detailW, onDetailResize, 'horizontal', 160, 500)
  useResize(sqlH, (h) => setSqlH(h), 'vertical', 60, 300)

  // Live monitor: show the last snapshot instantly on reopen, refresh in the
  // background. Short TTL so a reopen within ~15s won't even hit the wire.
  const { data, error, loading, refreshing, staleError, fetchedAt, refresh } =
    useCachedResource<Session[]>({
      namespace: 'sessions',
      key: connectionId,
      fetcher: () => invoke<Session[]>('get_sessions', { connectionId }),
      softTtlMs: 15_000,
    })
  const sessions = data ?? []
  const load = refresh

  useEffect(() => {
    if (!autoRefresh) return
    const t = setInterval(load, refreshInterval)
    return () => clearInterval(t)
  }, [autoRefresh, load, refreshInterval])

  const COLS = [
    { key: 'pid',             label: 'PID',        w: 64  },
    { key: 'usename',         label: 'User',       w: 140 },
    { key: 'datname',         label: 'Database',   w: 110 },
    { key: 'applicationName', label: 'App Name',   w: 180 },
    { key: 'state',           label: 'State',      w: 160 },
    { key: 'queryStart',      label: 'Query Start', w: 180 },
    { key: 'query',           label: 'Brief Query', w: undefined },
  ]

  return (
    <div className="flex flex-col h-full bg-th-bg overflow-hidden">
      {/* Toolbar */}
      <div className="flex items-center gap-3 px-4 shrink-0" style={{ height: 36, borderBottom: '1px solid var(--border)' }}>
        <span className="text-[13px] font-medium text-th-text">Sessions</span>
        <span className="text-[11px] text-th-dim">— {connectionName}</span>
        <div className="ml-auto flex items-center gap-2">
          <span className="text-[11px] text-th-dim">
            {sessions.length} sessions
            {fetchedAt && <span> · as of {timeAgo(fetchedAt)}</span>}
          </span>
          <label className="flex items-center gap-1.5 cursor-pointer text-[11px] text-th-dim">
            <input type="checkbox" checked={autoRefresh} onChange={e => setAuto(e.target.checked)}
              className="w-3 h-3 accent-[var(--tab-accent)]" />
            Auto-refresh
          </label>
          {autoRefresh && (
            <select
              value={refreshInterval}
              onChange={e => setInterval_(Number(e.target.value))}
              className="text-[11px] rounded px-1.5 py-0.5 outline-none"
              style={{ background: 'var(--sidebar-bg)', border: '1px solid var(--border)', color: 'var(--text)' }}
            >
              <option value={2000}>2s</option>
              <option value={5000}>5s</option>
              <option value={10000}>10s</option>
              <option value={30000}>30s</option>
              <option value={60000}>1 min</option>
              <option value={300000}>5 min</option>
            </select>
          )}
          <button onClick={load} disabled={loading || refreshing} title="Refresh"
            className="flex items-center gap-1.5 px-2 py-1 rounded text-[12px] transition-colors text-th-dim hover:text-th-text"
            style={{ border: '1px solid var(--border)' }}>
            {loading || refreshing ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
            Refresh
          </button>
        </div>
      </div>

      {/* Error — fatal (no snapshot) or a failed background refresh over a stale one */}
      {(error || staleError) && (
        <div className="mx-4 mt-2 px-3 py-2 rounded text-[12px] flex items-center gap-2"
          style={{ background: 'var(--error-bg)', color: 'var(--error-text)' }}>
          <XCircle size={13} /> {error ?? `Refresh failed: ${staleError}`}
        </div>
      )}

      {/* Table + Details */}
      <div className="flex flex-1 min-h-0">
        {/* Table */}
        <div className="flex flex-col flex-1 min-w-0 overflow-hidden">
          {/* Header */}
          <div className="flex shrink-0 text-[11px] font-semibold text-th-dim select-none"
            style={{ borderBottom: '1px solid var(--border)', background: 'var(--sidebar-bg)' }}>
            {COLS.map(c => (
              <div key={c.key} className="px-3 py-2 shrink-0 truncate"
                style={{ width: c.w, flex: c.w ? 'none' : 1 }}>
                {c.label}
              </div>
            ))}
          </div>

          {/* Rows */}
          <div className="flex-1 overflow-y-auto">
            {sessions.map(s => {
              const isSelected = selected?.pid === s.pid
              const stateColor = STATE_COLOR[s.state ?? ''] ?? 'var(--text-dim)'
              return (
                <div
                  key={s.pid}
                  onClick={() => setSelected(isSelected ? null : s)}
                  className="flex items-center text-[12px] cursor-pointer transition-colors"
                  style={{
                    borderBottom: '1px solid var(--border)',
                    background: isSelected ? 'var(--selection)' : 'transparent',
                    color: isSelected ? '#fff' : 'var(--text)',
                  }}
                  onMouseEnter={e => { if (!isSelected) e.currentTarget.style.background = 'var(--hover)' }}
                  onMouseLeave={e => { if (!isSelected) e.currentTarget.style.background = 'transparent' }}
                >
                  {COLS.map(c => {
                    const raw = s[c.key as keyof Session]
                    const display = c.key === 'query'
                      ? queryDisplay(raw as string | null)
                      : (raw === null || raw === undefined ? '' : String(raw))
                    return (
                      <div key={c.key} className="px-3 py-1.5 truncate shrink-0"
                        style={{
                          width: c.w, flex: c.w ? 'none' : 1,
                          color: c.key === 'state' ? stateColor : undefined,
                          fontFamily: c.key === 'query' ? "'Cascadia Code', Consolas, monospace" : undefined,
                          fontSize: c.key === 'query' ? 11 : undefined,
                        }}>
                        {display}
                      </div>
                    )
                  })}
                </div>
              )
            })}
          </div>
        </div>

        {/* Session Details panel */}
        {selected && (
          <>
          <ResizeHandle direction="horizontal" onMouseDown={e => { const startW = detailW; beginResizeDrag(e, 'x', d => setDetailW(Math.max(160, Math.min(500, startW - d)))) }} />
          <div className="shrink-0 overflow-y-auto flex flex-col"
            style={{ width: detailW, borderLeft: '1px solid var(--border)', background: 'var(--sidebar-bg)' }}>
            <div className="flex items-center justify-between px-3 py-2" style={{ borderBottom: '1px solid var(--border)' }}>
              <span className="text-[11px] font-semibold tracking-widest uppercase text-th-dim">Session Details</span>
              <button onClick={() => setSelected(null)} className="text-th-dim hover:text-th-text transition-colors"><X size={12} /></button>
            </div>

            <div className="flex flex-col gap-0">
              <DetailGroup label="General">
                <DetailRow label="PID"         value={String(selected.pid)} />
                <DetailRow label="Database"    value={selected.datname} />
                <DetailRow label="State"       value={selected.state} color={STATE_COLOR[selected.state ?? '']} />
                {selected.waitEvent && <DetailRow label="Wait Event" value={selected.waitEvent} />}
                <DetailRow label="Brief Query" value={cleanQuery(selected.query)}
                  mono hint={selected.query === PRIV_ERR ? 'Grant pg_monitor role to see queries from other sessions' : undefined} />
              </DetailGroup>
              <DetailGroup label="Client">
                <DetailRow label="User"        value={selected.usename} />
                <DetailRow label="Client Host" value={selected.clientAddr} />
                {selected.clientPort != null && <DetailRow label="Client Port" value={String(selected.clientPort)} />}
                <DetailRow label="App Name"    value={selected.applicationName} />
              </DetailGroup>
              <DetailGroup label="Timing">
                <DetailRow label="Query Start" value={selected.queryStart} />
              </DetailGroup>
            </div>
          </div>
          </>
        )}
      </div>

      {/* Query preview at bottom — resizable */}
      {selected && cleanQuery(selected.query) && (
        <>
          <ResizeHandle direction="vertical" onMouseDown={e => { const startH = sqlH; beginResizeDrag(e, 'y', d => setSqlH(Math.max(60, Math.min(300, startH - d)))) }} />
        <div style={{ borderTop: '1px solid var(--border)', height: sqlH, flexShrink: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
          <div className="px-3 py-1 text-[10px] font-semibold tracking-widest uppercase text-th-dim"
            style={{ borderBottom: '1px solid var(--border)', flexShrink: 0 }}>SQL</div>
          <pre className="px-3 py-2 text-[12px] overflow-auto flex-1"
            style={{ fontFamily: "'Cascadia Code', Consolas, monospace", color: 'var(--text)' }}>
            {cleanQuery(selected.query)}
          </pre>
        </div>
        </>
      )}
    </div>
  )
}

function DetailGroup({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ borderBottom: '1px solid var(--border)' }}>
      <div className="px-3 py-1 text-[10px] font-semibold tracking-wider uppercase text-th-dim"
        style={{ background: 'var(--bg)' }}>{label}</div>
      {children}
    </div>
  )
}

function DetailRow({ label, value, color, mono, hint }: {
  label: string; value?: string | null; color?: string; mono?: boolean; hint?: string
}) {
  if (!value && !hint) return null
  return (
    <div className="flex flex-col px-3 py-1 gap-0.5" style={{ borderBottom: '1px solid var(--border)' }}>
      <span className="text-[10px] text-th-dim">{label}</span>
      {value && (
        <span className="text-[11px] break-all" style={{
          color: color ?? 'var(--text)',
          fontFamily: mono ? "'Cascadia Code', Consolas, monospace" : undefined,
        }}>{value}</span>
      )}
      {hint && (
        <span className="text-[10px]" style={{ color: 'var(--text-dim)', fontStyle: 'italic' }}>
          {hint}
        </span>
      )}
    </div>
  )
}
