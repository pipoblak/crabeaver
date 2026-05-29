import { GitBranch, Database, Loader2, CheckCircle, XCircle, AlertCircle } from 'lucide-react'
import { useValidation } from '@/context/ValidationContext'

export default function StatusBar() {
  const { state, errors, warnings } = useValidation()

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

function LintStatus({ state, errors, warnings }: {
  state: 'idle' | 'scanning' | 'done'
  errors: number
  warnings: number
}) {
  if (state === 'idle') return null

  if (state === 'scanning') {
    return (
      <div className="flex items-center gap-1 opacity-80">
        <Loader2 size={10} className="animate-spin" />
        <span>Linting…</span>
      </div>
    )
  }

  if (errors > 0) {
    return (
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
  }

  if (warnings > 0) {
    return (
      <div className="flex items-center gap-1 opacity-80">
        <AlertCircle size={10} />
        <span>{warnings} {warnings === 1 ? 'warning' : 'warnings'}</span>
      </div>
    )
  }

  return (
    <div className="flex items-center gap-1 opacity-70">
      <CheckCircle size={10} />
      <span>No issues</span>
    </div>
  )
}
