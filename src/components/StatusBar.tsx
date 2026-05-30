import { useState, useEffect, useRef } from 'react'
import { GitBranch, Database, Loader2, CheckCircle, XCircle, AlertCircle, ChevronDown } from 'lucide-react'
import { useValidation } from '@/context/ValidationContext'
import { useTabs } from '@/context/TabsContext'
import { useConnections } from '@/context/ConnectionContext'

export default function StatusBar() {
  const { state, errors, warnings } = useValidation()
  const { tabs, activeId, setTabConnection } = useTabs()
  const { connections, connected, connect, revalidating } = useConnections()
  const active = tabs.find(t => t.id === activeId)
  const isQueryTab = !active?.type || active?.type === 'query'

  const [showPicker, setShowPicker] = useState(false)
  const pickerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!showPicker) return
    const handler = (e: MouseEvent) => {
      if (!pickerRef.current?.contains(e.target as Node)) setShowPicker(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [showPicker])

  const selectConnection = async (c: { id: string; name: string } | null) => {
    if (!active) return
    setShowPicker(false)
    if (c && !connected.has(c.id)) {
      await connect(c.id).catch(() => {})
    }
    setTabConnection(active.id, c?.id, c?.name)
  }

  const connName = active?.connectionName ?? null

  return (
    <div className="flex items-center justify-between h-6 shrink-0 select-none text-[11px] bg-th-statusbar text-th-bright px-5">
      <div className="flex items-center gap-3">
        <div className="flex items-center gap-1">
          <GitBranch size={11} />
          <span>main</span>
        </div>
        <LintStatus state={state} errors={errors} warnings={warnings} />
      </div>

      <div className="flex items-center gap-3">
        {/* Revalidating indicator */}
        {revalidating && (
          <div className="flex items-center gap-1 opacity-70">
            <Loader2 size={10} className="animate-spin" />
            <span>Revalidating…</span>
          </div>
        )}

        {/* Connection picker — only on query tabs */}
        {isQueryTab && (
          <div className="relative" ref={pickerRef}>
            <button
              onClick={() => setShowPicker(v => !v)}
              className="flex items-center gap-1.5 transition-opacity hover:opacity-75"
              style={{ color: connName ? '#fff' : 'rgba(255,255,255,0.55)' }}
            >
              {/* Status dot */}
              {connName && (
                <span className="w-1.5 h-1.5 rounded-full shrink-0"
                  style={{ background: connected.has(active?.connectionId ?? '') ? '#22c55e' : '#f59e0b' }} />
              )}
              <Database size={11} />
              <span>{connName ?? 'No connection'}</span>
              <ChevronDown size={9} />
            </button>

            {showPicker && (
              <div
                className="absolute bottom-full mb-1 right-0 rounded shadow-xl z-50 min-w-[180px]"
                style={{ background: 'var(--sidebar-bg)', border: '1px solid var(--border)' }}
              >
                <div className="px-3 py-1.5 text-[10px] font-semibold tracking-widest uppercase"
                  style={{ color: 'var(--text-dim)', borderBottom: '1px solid var(--border)' }}>
                  Connection
                </div>
                <button
                  onClick={() => selectConnection(null)}
                  className="flex items-center gap-2 w-full px-3 py-1.5 text-[12px] text-left transition-colors hover:bg-th-hover"
                  style={{ color: !connName ? 'var(--text-bright)' : 'var(--text-dim)' }}
                >
                  <span className="w-2 h-2 rounded-full shrink-0" style={{ background: 'var(--text-dim)' }} />
                  No connection
                </button>
                {connections.map(c => {
                  const isConn  = connected.has(c.id)
                  const isActive = c.id === active?.connectionId
                  return (
                    <button
                      key={c.id}
                      onClick={() => selectConnection(c)}
                      className="flex items-center gap-2 w-full px-3 py-1.5 text-[12px] text-left transition-colors hover:bg-th-hover"
                      style={{ color: isActive ? 'var(--text-bright)' : 'var(--text)' }}
                    >
                      <span className="w-2 h-2 rounded-full shrink-0"
                        style={{ background: isConn ? '#22c55e' : 'var(--text-dim)' }} />
                      <span className="truncate flex-1">{c.name}</span>
                      {!isConn && <span className="text-[10px]" style={{ color: 'var(--text-dim)' }}>offline</span>}
                    </button>
                  )
                })}
              </div>
            )}
          </div>
        )}

        <span>SQL</span>
        <span>UTF-8</span>
      </div>
    </div>
  )
}

function LintStatus({ state, errors, warnings }: {
  state: 'idle' | 'scanning' | 'done'
  errors: number
  warnings: number
}) {
  if (state === 'idle') return null
  if (state === 'scanning') return (
    <div className="flex items-center gap-1 opacity-80">
      <Loader2 size={10} className="animate-spin" />
      <span>Linting…</span>
    </div>
  )
  if (errors > 0) return (
    <div className="flex items-center gap-2">
      <div className="flex items-center gap-1">
        <XCircle size={10} />
        <span>{errors} {errors === 1 ? 'error' : 'errors'}</span>
      </div>
      {warnings > 0 && (
        <div className="flex items-center gap-1 opacity-80">
          <AlertCircle size={10} />
          <span>{warnings}</span>
        </div>
      )}
    </div>
  )
  if (warnings > 0) return (
    <div className="flex items-center gap-1 opacity-80">
      <AlertCircle size={10} />
      <span>{warnings} {warnings === 1 ? 'warning' : 'warnings'}</span>
    </div>
  )
  return (
    <div className="flex items-center gap-1 opacity-70">
      <CheckCircle size={10} />
      <span>No issues</span>
    </div>
  )
}
