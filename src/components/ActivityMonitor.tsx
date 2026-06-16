import { useState, useRef, useEffect } from 'react'
import { Activity, Loader2 } from 'lucide-react'
import { useTasks } from '@/context/TasksContext'
import ActivityPanelBody from '@/components/ActivityPanelBody'

export default function ActivityMonitor() {
  const { tasks, docked, dockOpen, setDockOpen } = useTasks()
  const [open, setOpen] = useState(false) // popover state (popup mode only)
  const ref = useRef<HTMLDivElement>(null)

  const foreground = tasks.filter(t => !t.background)
  // Spin only for real work (queries/load-more). Background schema/connection
  // checks keep the static Activity icon — otherwise the app looks like it's
  // running a query on open while it's just revalidating connections.
  const busy = foreground.length > 0

  // Close the popover on outside click. Not needed when docked — the dock lives in
  // the layout flow (below the result pane), not as a floating popover here.
  useEffect(() => {
    if (!open || docked) return
    const handler = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open, docked])

  // Latest-started foreground task (startTask appends, so the last is newest).
  const latest = foreground[foreground.length - 1]
  const latestText = latest ? (latest.detail ?? latest.label) : ''

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => docked ? setDockOpen(!dockOpen) : setOpen(v => !v)}
        title="Activity"
        className="flex items-center gap-1 transition-opacity hover:opacity-75 max-w-[320px]"
        style={{ color: foreground.length ? '#fff' : 'rgba(255,255,255,0.55)' }}
      >
        {busy
          ? <Loader2 size={11} className="animate-spin shrink-0" />
          : <Activity size={11} className="shrink-0" />}
        {latest && (
          <>
            <span className="truncate font-mono">{latestText}</span>
            {foreground.length > 1 && <span className="shrink-0 opacity-70">+{foreground.length - 1}</span>}
          </>
        )}
      </button>

      {/* Popup mode — floating popover above the status bar button. When docked,
          the panel renders in the layout flow via <ActivityDock /> instead. */}
      {open && !docked && (
        <div
          className="absolute bottom-full mb-1 right-0 rounded shadow-xl z-50 min-w-[260px] max-w-[360px]"
          style={{ background: 'var(--sidebar-bg)', border: '1px solid var(--border)' }}
        >
          <ActivityPanelBody />
        </div>
      )}
    </div>
  )
}
