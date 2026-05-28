import { Plus } from 'lucide-react'

export default function Sidebar() {
  return (
    <aside
      className="flex flex-col w-56 shrink-0 overflow-hidden"
      style={{ background: 'var(--sidebar-bg)', borderRight: '1px solid var(--border)' }}
    >
      {/* Section header */}
      <div
        className="flex items-center justify-between px-4 pt-3 pb-1.5"
        style={{ borderBottom: '1px solid var(--border)' }}
      >
        <span
          className="text-[11px] font-semibold tracking-widest uppercase"
          style={{ color: 'var(--text-dim)' }}
        >
          Connections
        </span>
        <button
          title="New connection"
          className="flex items-center justify-center w-5 h-5 rounded transition-colors"
          style={{ color: 'var(--text-dim)' }}
          onMouseEnter={e => (e.currentTarget.style.color = 'var(--text)')}
          onMouseLeave={e => (e.currentTarget.style.color = 'var(--text-dim)')}
        >
          <Plus size={13} />
        </button>
      </div>

      {/* Connection list */}
      <div className="flex flex-col flex-1 overflow-y-auto py-1">
        <EmptyState />
      </div>
    </aside>
  )
}

function EmptyState() {
  return (
    <div className="flex flex-col items-center justify-center flex-1 gap-2 px-4 py-8">
      <p className="text-[11px] text-center" style={{ color: 'var(--text-dim)' }}>
        No connections yet.
        <br />
        Click + to add one.
      </p>
    </div>
  )
}
