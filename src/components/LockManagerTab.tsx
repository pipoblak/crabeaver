import { useState, useEffect, useCallback } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { RefreshCw, XCircle, Loader2, X } from 'lucide-react'
import ResizeHandle from '@/components/ResizeHandle'

interface Lock {
  pid:             number
  locktype:        string | null
  relation:        string | null
  mode:            string | null
  granted:         boolean | null
  usename:         string | null
  datname:         string | null
  applicationName: string | null
  state:           string | null
  query:           string | null
  queryStart:      string | null
  blockingPids:    string | null
}

interface Props {
  connectionId:   string
  connectionName: string
}

const PRIV_ERR = '<insufficient privilege>'

// Highlight exclusive/dangerous modes
const MODE_COLOR: Record<string, string> = {
  'AccessExclusiveLock': '#ef4444',
  'ExclusiveLock':       '#f97316',
  'ShareRowExclusiveLock': '#f59e0b',
  'ShareUpdateExclusiveLock': '#eab308',
  'RowExclusiveLock':    '#a3e635',
  'ShareLock':           '#38bdf8',
  'RowShareLock':        '#7dd3fc',
  'AccessShareLock':     'var(--text-dim)',
}

const COLS = [
  { key: 'granted',        label: 'Granted',   w: 72  },
  { key: 'pid',            label: 'PID',        w: 64  },
  { key: 'locktype',       label: 'Type',       w: 100 },
  { key: 'relation',       label: 'Relation',   w: 160 },
  { key: 'mode',           label: 'Mode',       w: 190 },
  { key: 'usename',        label: 'User',       w: 130 },
  { key: 'datname',        label: 'Database',   w: 100 },
  { key: 'blockingPids',   label: 'Blocked By', w: 100 },
  { key: 'query',          label: 'Query',      w: undefined },
]

export default function LockManagerTab({ connectionId, connectionName }: Props) {
  const [locks, setLocks]         = useState<Lock[]>([])
  const [selected, setSelected]   = useState<Lock | null>(null)
  const [loading, setLoading]     = useState(false)
  const [error, setError]         = useState<string | null>(null)
  const [autoRefresh, setAuto]    = useState(false)
  const [interval_, setInterval_] = useState(5000)
  const [detailW, setDetailW]     = useState(240)
  const [sqlH, setSqlH]           = useState(110)
  const [hideShare, setHideShare] = useState(true)

  const load = useCallback(async () => {
    setLoading(true); setError(null)
    try {
      setLocks(await invoke<Lock[]>('get_locks', { connectionId }))
    } catch (e) { setError(String(e)) }
    finally { setLoading(false) }
  }, [connectionId])

  useEffect(() => { load() }, [load])
  useEffect(() => {
    if (!autoRefresh) return
    const t = setInterval(load, interval_)
    return () => clearInterval(t)
  }, [autoRefresh, load, interval_])

  const visible  = hideShare ? locks.filter(l => l.mode !== 'AccessShareLock') : locks
  const blocked  = visible.filter(l => l.granted === false).length
  const total    = visible.length

  const cellVal = (lock: Lock, key: string): string => {
    const v = lock[key as keyof Lock]
    if (v === null || v === undefined) return ''
    if (key === 'granted') return v ? '✓' : '✗ blocked'
    if (key === 'query' && String(v) === PRIV_ERR) return '⚠ insufficient privilege'
    return String(v)
  }

  const cellColor = (lock: Lock, key: string): string | undefined => {
    if (key === 'granted') return lock.granted ? '#22c55e' : '#ef4444'
    if (key === 'mode')    return MODE_COLOR[lock.mode ?? '']
    if (key === 'query' && lock.query === PRIV_ERR) return 'var(--text-dim)'
    return undefined
  }

  return (
    <div className="flex flex-col h-full bg-th-bg overflow-hidden">
      {/* Toolbar */}
      <div className="flex items-center gap-3 px-4 shrink-0" style={{ height: 36, borderBottom: '1px solid var(--border)' }}>
        <span className="text-[13px] font-medium text-th-text">Locks</span>
        <span className="text-[11px] text-th-dim">— {connectionName}</span>
        <div className="ml-auto flex items-center gap-2">
          <span className="text-[11px]" style={{ color: blocked > 0 ? '#ef4444' : 'var(--text-dim)' }}>
            {total} lock{total !== 1 ? 's' : ''}{blocked > 0 ? ` · ${blocked} blocked` : ''}
          </span>
          <label className="flex items-center gap-1.5 cursor-pointer text-[11px] text-th-dim">
            <input type="checkbox" checked={hideShare} onChange={e => setHideShare(e.target.checked)}
              className="w-3 h-3 accent-[var(--tab-accent)]" />
            Hide AccessShareLock
          </label>
          <label className="flex items-center gap-1.5 cursor-pointer text-[11px] text-th-dim">
            <input type="checkbox" checked={autoRefresh} onChange={e => setAuto(e.target.checked)}
              className="w-3 h-3 accent-[var(--tab-accent)]" />
            Auto-refresh
          </label>
          {autoRefresh && (
            <select value={interval_} onChange={e => setInterval_(Number(e.target.value))}
              className="text-[11px] rounded px-1.5 py-0.5 outline-none"
              style={{ background: 'var(--sidebar-bg)', border: '1px solid var(--border)', color: 'var(--text)' }}>
              <option value={2000}>2s</option>
              <option value={5000}>5s</option>
              <option value={10000}>10s</option>
              <option value={30000}>30s</option>
              <option value={60000}>1 min</option>
            </select>
          )}
          <button onClick={load} disabled={loading} className="flex items-center gap-1.5 px-2 py-1 rounded text-[12px] transition-colors text-th-dim hover:text-th-text"
            style={{ border: '1px solid var(--border)' }}>
            {loading ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />} Refresh
          </button>
        </div>
      </div>

      {error && (
        <div className="mx-4 mt-2 px-3 py-2 rounded text-[12px] flex items-center gap-2"
          style={{ background: 'var(--error-bg)', color: 'var(--error-text)', flexShrink: 0 }}>
          <XCircle size={13} /> {error}
        </div>
      )}

      <div className="flex flex-1 min-h-0">
        {/* Table */}
        <div className="flex flex-col flex-1 min-w-0 overflow-hidden">
          {/* Header */}
          <div className="flex shrink-0 text-[11px] font-semibold text-th-dim select-none"
            style={{ borderBottom: '1px solid var(--border)', background: 'var(--sidebar-bg)' }}>
            {COLS.map(c => (
              <div key={c.key} className="px-3 py-2 shrink-0 truncate"
                style={{ width: c.w, flex: c.w ? 'none' : 1 }}>{c.label}</div>
            ))}
          </div>

          <div className="flex-1 overflow-y-auto">
            {visible.map((lock, i) => {
              const isSel = selected?.pid === lock.pid && selected?.locktype === lock.locktype && selected?.mode === lock.mode
              const blocked = lock.granted === false
              return (
                <div key={i} onClick={() => setSelected(isSel ? null : lock)}
                  className="flex items-center text-[12px] cursor-pointer transition-colors"
                  style={{
                    borderBottom: '1px solid var(--border)',
                    background: isSel ? 'var(--selection)' : blocked ? 'rgba(239,68,68,0.06)' : 'transparent',
                    color: isSel ? '#fff' : 'var(--text)',
                  }}
                  onMouseEnter={e => { if (!isSel) e.currentTarget.style.background = 'var(--hover)' }}
                  onMouseLeave={e => { if (!isSel) e.currentTarget.style.background = blocked ? 'rgba(239,68,68,0.06)' : 'transparent' }}
                >
                  {COLS.map(c => (
                    <div key={c.key} className="px-3 py-1.5 truncate shrink-0"
                      style={{
                        width: c.w, flex: c.w ? 'none' : 1,
                        color: isSel ? '#fff' : (cellColor(lock, c.key) ?? undefined),
                        fontFamily: c.key === 'query' ? "'Cascadia Code', Consolas, monospace" : undefined,
                        fontSize: c.key === 'query' ? 11 : undefined,
                        fontWeight: c.key === 'granted' ? 600 : undefined,
                      }}>
                      {cellVal(lock, c.key)}
                    </div>
                  ))}
                </div>
              )
            })}
          </div>
        </div>

        {/* Details panel */}
        {selected && (
          <>
            <ResizeHandle direction="horizontal"
              onMouseDown={e => { e.preventDefault(); const s=e.clientX, sw=detailW; const m=(ev:MouseEvent)=>setDetailW(Math.max(160,Math.min(500,sw-(ev.clientX-s)))); const u=()=>{window.removeEventListener('mousemove',m);window.removeEventListener('mouseup',u);document.body.style.cursor='';document.body.style.userSelect=''}; document.body.style.cursor='col-resize';document.body.style.userSelect='none';window.addEventListener('mousemove',m);window.addEventListener('mouseup',u) }}
            />
            <div className="shrink-0 overflow-y-auto flex flex-col"
              style={{ width: detailW, borderLeft: '1px solid var(--border)', background: 'var(--sidebar-bg)' }}>
              <div className="flex items-center justify-between px-3 py-2" style={{ borderBottom: '1px solid var(--border)' }}>
                <span className="text-[11px] font-semibold tracking-widest uppercase text-th-dim">Lock Details</span>
                <button onClick={() => setSelected(null)} className="text-th-dim hover:text-th-text transition-colors"><X size={12} /></button>
              </div>
              <Group label="Lock">
                <Row label="PID"      value={String(selected.pid)} />
                <Row label="Type"     value={selected.locktype} />
                <Row label="Relation" value={selected.relation} />
                <Row label="Mode"     value={selected.mode} color={MODE_COLOR[selected.mode ?? '']} />
                <Row label="Granted"  value={selected.granted ? 'Yes' : 'No — BLOCKED'}
                  color={selected.granted ? '#22c55e' : '#ef4444'} />
                {selected.blockingPids && selected.blockingPids !== '{}' && (
                  <Row label="Blocked by" value={selected.blockingPids} color="#ef4444" />
                )}
              </Group>
              <Group label="Session">
                <Row label="User"     value={selected.usename} />
                <Row label="Database" value={selected.datname} />
                <Row label="App"      value={selected.applicationName} />
                <Row label="State"    value={selected.state} />
                <Row label="Query Start" value={selected.queryStart} />
              </Group>
            </div>
          </>
        )}
      </div>

      {/* SQL preview */}
      {selected?.query && selected.query !== PRIV_ERR && (
        <>
          <ResizeHandle direction="vertical"
            onMouseDown={e => { e.preventDefault(); const s=e.clientY,sh=sqlH; const m=(ev:MouseEvent)=>setSqlH(Math.max(60,Math.min(300,sh-(ev.clientY-s)))); const u=()=>{window.removeEventListener('mousemove',m);window.removeEventListener('mouseup',u);document.body.style.cursor='';document.body.style.userSelect=''}; document.body.style.cursor='row-resize';document.body.style.userSelect='none';window.addEventListener('mousemove',m);window.addEventListener('mouseup',u) }}
          />
          <div style={{ height: sqlH, flexShrink: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column', borderTop: '1px solid var(--border)' }}>
            <div className="px-3 py-1 text-[10px] font-semibold tracking-widest uppercase text-th-dim"
              style={{ borderBottom: '1px solid var(--border)', flexShrink: 0 }}>SQL</div>
            <pre className="px-3 py-2 text-[12px] overflow-auto flex-1"
              style={{ fontFamily: "'Cascadia Code', Consolas, monospace", color: 'var(--text)' }}>
              {selected.query}
            </pre>
          </div>
        </>
      )}
    </div>
  )
}

function Group({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ borderBottom: '1px solid var(--border)' }}>
      <div className="px-3 py-1 text-[10px] font-semibold tracking-wider uppercase text-th-dim"
        style={{ background: 'var(--bg)' }}>{label}</div>
      {children}
    </div>
  )
}

function Row({ label, value, color }: { label: string; value?: string | null; color?: string }) {
  if (!value) return null
  return (
    <div className="flex flex-col px-3 py-1 gap-0.5" style={{ borderBottom: '1px solid var(--border)' }}>
      <span className="text-[10px] text-th-dim">{label}</span>
      <span className="text-[11px] break-all" style={{ color: color ?? 'var(--text)' }}>{value}</span>
    </div>
  )
}
