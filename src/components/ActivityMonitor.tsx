import { useState, useRef, useEffect } from 'react'
import { Activity, Loader2, X, Database, ChevronsDown, RefreshCw } from 'lucide-react'
import { useTasks, type Task, type TaskKind } from '@/context/TasksContext'

const KIND_ICON: Record<TaskKind, typeof Database> = {
  'query':      Database,
  'load-more':  ChevronsDown,
  'schema':     RefreshCw,
  'connection': Activity,
}

export default function ActivityMonitor() {
  const { tasks, cancelTask } = useTasks()
  const [open, setOpen] = useState(false)
  const [, setTick] = useState(0)
  const ref = useRef<HTMLDivElement>(null)

  const foreground = tasks.filter(t => !t.background)
  const background = tasks.filter(t => t.background)
  const busy = tasks.length > 0

  // Live elapsed timer — only ticks while something is running.
  useEffect(() => {
    if (!busy) return
    const id = setInterval(() => setTick(n => n + 1), 250)
    return () => clearInterval(id)
  }, [busy])

  // Close the popover on outside click.
  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  const elapsed = (t: Task) => `${((Date.now() - t.startedAt) / 1000).toFixed(1)}s`

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen(v => !v)}
        title="Activity"
        className="flex items-center gap-1 transition-opacity hover:opacity-75"
        style={{ color: foreground.length ? '#fff' : 'rgba(255,255,255,0.55)' }}
      >
        {busy
          ? <Loader2 size={11} className="animate-spin" />
          : <Activity size={11} />}
        {foreground.length > 0 && <span>{foreground.length}</span>}
      </button>

      {open && (
        <div
          className="absolute bottom-full mb-1 right-0 rounded shadow-xl z-50 min-w-[260px] max-w-[360px]"
          style={{ background: 'var(--sidebar-bg)', border: '1px solid var(--border)' }}
        >
          <div className="px-3 py-1.5 text-[10px] font-semibold tracking-widest uppercase"
            style={{ color: 'var(--text-dim)', borderBottom: '1px solid var(--border)' }}>
            Activity
          </div>

          {tasks.length === 0 && (
            <div className="px-3 py-2 text-[12px]" style={{ color: 'var(--text-dim)' }}>
              No active tasks
            </div>
          )}

          {foreground.map(t => {
            const Icon = KIND_ICON[t.kind]
            return (
              <div key={t.id} className="flex items-start gap-2 px-3 py-1.5"
                style={{ borderBottom: '1px solid var(--border)' }}>
                <Icon size={12} className="shrink-0 mt-0.5" style={{ color: 'var(--tab-accent)' }} />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-[12px] truncate" style={{ color: 'var(--text-bright)' }}>{t.label}</span>
                    <span className="text-[10px] font-mono shrink-0" style={{ color: 'var(--text-dim)' }}>{elapsed(t)}</span>
                  </div>
                  {t.detail && (
                    <div className="text-[10px] font-mono truncate" style={{ color: 'var(--text-dim)' }}>{t.detail}</div>
                  )}
                </div>
                {t.cancellable && (
                  <button title="Cancel" onClick={() => cancelTask(t.id)}
                    className="shrink-0 mt-0.5 hover:opacity-75" style={{ color: 'var(--error-text, #f87171)' }}>
                    <X size={12} />
                  </button>
                )}
              </div>
            )
          })}

          {background.length > 0 && (
            <div className="px-3 py-1.5" style={{ opacity: 0.6 }}>
              {background.map(t => {
                const Icon = KIND_ICON[t.kind]
                return (
                  <div key={t.id} className="flex items-center gap-2 py-0.5">
                    <Icon size={11} className="shrink-0" style={{ color: 'var(--text-dim)' }} />
                    <span className="text-[11px] truncate flex-1" style={{ color: 'var(--text-dim)' }}>{t.label}</span>
                    <span className="text-[10px] font-mono shrink-0" style={{ color: 'var(--text-dim)' }}>{elapsed(t)}</span>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
