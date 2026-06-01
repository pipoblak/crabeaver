import { useState, useRef } from 'react'
import { useTasks } from '@/context/TasksContext'
import ActivityPanelBody from '@/components/ActivityPanelBody'
import ResizeHandle from '@/components/ResizeHandle'

const HEIGHT_KEY = 'cb:activity_dock_h'
const MIN_H = 80
const DEFAULT_H = 120

function loadHeight(): number {
  const n = Number(localStorage.getItem(HEIGHT_KEY))
  return Number.isFinite(n) && n >= MIN_H ? n : DEFAULT_H
}

// Docked Activity panel: a resizable-height tab in the layout flow, rendered after
// the main content (below the result pane) and above the status bar. Only shown
// when the user has docked the panel and it is open.
export default function ActivityDock() {
  const { docked, dockOpen } = useTasks()
  const [height, setHeight] = useState(loadHeight)
  const startY = useRef(0)
  const startH = useRef(0)

  // Drag the top edge to resize. Dragging up grows the panel (inverted delta),
  // matching the result pane handle. Height is persisted across sessions.
  const onDragStart = (e: React.MouseEvent) => {
    e.preventDefault()
    startY.current = e.clientY
    startH.current = height
    const move = (ev: MouseEvent) => {
      const delta = startY.current - ev.clientY
      const max = window.innerHeight - 120
      setHeight(Math.min(max, Math.max(MIN_H, startH.current + delta)))
    }
    const up = () => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      // Persist the latest height.
      setHeight(h => { try { localStorage.setItem(HEIGHT_KEY, String(h)) } catch { /* quota */ } return h })
    }
    document.body.style.cursor = 'row-resize'
    document.body.style.userSelect = 'none'
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }

  if (!docked || !dockOpen) return null
  return (
    <>
      <ResizeHandle direction="vertical" onMouseDown={onDragStart} />
      <div className="shrink-0 overflow-auto"
        style={{ height, borderTop: '1px solid var(--border)', background: 'var(--sidebar-bg)' }}>
        <ActivityPanelBody />
      </div>
    </>
  )
}
