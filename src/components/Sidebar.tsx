import { Plus } from 'lucide-react'

export default function Sidebar() {
  return (
    <aside className="flex flex-col w-56 shrink-0 overflow-hidden bg-th-sidebar border-r border-r-th-border">
      {/* Section header */}
      <div className="flex items-center justify-between pl-4 pr-3 border-t border-t-transparent border-b border-b-th-border" style={{ height: '37px' }}>
        <span className="text-[11px] font-semibold tracking-[0.1em] uppercase text-th-dim">
          Connections
        </span>
        <button
          title="New connection"
          className="flex items-center justify-center w-5 h-5 rounded transition-colors text-th-dim hover:text-th-text"
        >
          <Plus size={13} />
        </button>
      </div>

      {/* Connection list */}
      <div className="flex flex-col flex-1 overflow-y-auto">
        <EmptyState />
      </div>
    </aside>
  )
}

function EmptyState() {
  return (
    <div className="flex flex-col items-center justify-center flex-1 gap-2 px-4 py-8">
      <p className="text-[11px] text-center text-th-dim">
        No connections yet.
        <br />
        Click + to add one.
      </p>
    </div>
  )
}
