import { GitBranch, Database } from 'lucide-react'

export default function StatusBar() {
  return (
    <div
      className="flex items-center justify-between text-xs shrink-0 select-none"
      style={{ background: 'var(--statusbar)', color: '#fff', height: '24px', padding: '0 20px' }}
    >
      <div className="flex items-center gap-3">
        <div className="flex items-center gap-1">
          <GitBranch size={12} />
          <span>main</span>
        </div>
      </div>
      <div className="flex items-center gap-3">
        <div className="flex items-center gap-1">
          <Database size={12} />
          <span>No connection</span>
        </div>
        <span>SQL</span>
        <span>UTF-8</span>
      </div>
    </div>
  )
}
