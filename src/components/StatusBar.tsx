import { GitBranch, Database } from 'lucide-react'

export default function StatusBar() {
  return (
    <div className="flex items-center justify-between h-6 shrink-0 select-none text-[11px] bg-th-statusbar text-th-bright px-5">
      <div className="flex items-center gap-3">
        <div className="flex items-center gap-1">
          <GitBranch size={11} />
          <span>main</span>
        </div>
      </div>
      <div className="flex items-center gap-3">
        <div className="flex items-center gap-1">
          <Database size={11} />
          <span>No connection</span>
        </div>
        <span>SQL</span>
        <span>UTF-8</span>
      </div>
    </div>
  )
}
