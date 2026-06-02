import { useState, useEffect } from 'react'
import { Activity, X, Database, ChevronsDown, RefreshCw, PanelBottom, Minimize2 } from 'lucide-react'
import { useTasks, useTaskActions, type Task, type TaskKind } from '@/context/TasksContext'

const KIND_ICON: Record<TaskKind, typeof Database> = {
  'query':      Database,
  'load-more':  ChevronsDown,
  'schema':     RefreshCw,
  'connection': Activity,
}

// The Activity panel contents — header (with the popup/dock toggle) plus the
// foreground and background task lists. Shared by the floating popover
// (ActivityMonitor) and the docked bottom tab (ActivityDock).
export default function ActivityPanelBody() {
  const { tasks, docked, setDocked } = useTasks()
  const { cancelTask } = useTaskActions()
  const [, setTick] = useState(0)

  const foreground = tasks.filter(t => !t.background)
  const background = tasks.filter(t => t.background)
  const busy = tasks.length > 0

  // Live elapsed timer — only ticks while something is running.
  useEffect(() => {
    if (!busy) return
    const id = setInterval(() => setTick(n => n + 1), 250)
    return () => clearInterval(id)
  }, [busy])

  const elapsed = (t: Task) => `${((Date.now() - t.startedAt) / 1000).toFixed(1)}s`

  return (
    <>
      <div className="flex items-center px-3 py-1.5 sticky top-0 z-10"
        style={{ borderBottom: '1px solid var(--border)', background: 'var(--sidebar-bg)' }}>
        <span className="text-[10px] font-semibold tracking-widest uppercase flex-1"
          style={{ color: 'var(--text-dim)' }}>Activity</span>
        {docked ? (
          <button title="Show as popup" onClick={() => setDocked(false)}
            className="shrink-0 hover:opacity-75" style={{ color: 'var(--text-dim)' }}>
            <Minimize2 size={12} />
          </button>
        ) : (
          <button title="Dock below results" onClick={() => setDocked(true)}
            className="shrink-0 hover:opacity-75" style={{ color: 'var(--text-dim)' }}>
            <PanelBottom size={12} />
          </button>
        )}
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
    </>
  )
}
