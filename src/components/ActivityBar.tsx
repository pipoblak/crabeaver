import { Database, Search, GitBranch, Settings } from 'lucide-react'
import type { AppView } from '@/App'

const navItems = [
  { icon: Database,  label: 'Connections', view: 'editor' as AppView },
  { icon: Search,    label: 'Search',      view: 'editor' as AppView },
  { icon: GitBranch, label: 'History',     view: 'editor' as AppView },
]

interface Props {
  view: AppView
  setView: (v: AppView) => void
}

export default function ActivityBar({ view, setView }: Props) {
  return (
    <div
      className="flex flex-col items-center w-12 shrink-0"
      style={{ background: 'var(--activity-bg)', borderRight: '1px solid var(--border)' }}
    >
      <div className="flex flex-col items-center flex-1 pt-1">
        {navItems.map(item => {
          const Icon = item.icon
          const isActive = view === 'editor'
          return (
            <button
              key={item.label}
              title={item.label}
              onClick={() => setView('editor')}
              className="relative flex items-center justify-center w-12 h-11 transition-colors"
              style={{
                color: isActive ? 'var(--text-bright)' : 'var(--text-dim)',
                borderLeft: isActive ? '2px solid var(--text-bright)' : '2px solid transparent',
              }}
              onMouseEnter={e => { if (!isActive) e.currentTarget.style.color = 'var(--text)' }}
              onMouseLeave={e => { if (!isActive) e.currentTarget.style.color = 'var(--text-dim)' }}
            >
              <Icon size={20} strokeWidth={1.5} />
            </button>
          )
        })}
      </div>

      <div className="pb-1">
        <button
          title="Settings"
          onClick={() => setView(view === 'settings' ? 'editor' : 'settings')}
          className="relative flex items-center justify-center w-12 h-11 transition-colors"
          style={{
            color: view === 'settings' ? 'var(--text-bright)' : 'var(--text-dim)',
            borderLeft: view === 'settings' ? '2px solid var(--text-bright)' : '2px solid transparent',
          }}
          onMouseEnter={e => { if (view !== 'settings') e.currentTarget.style.color = 'var(--text)' }}
          onMouseLeave={e => { if (view !== 'settings') e.currentTarget.style.color = 'var(--text-dim)' }}
        >
          <Settings size={20} strokeWidth={1.5} />
        </button>
      </div>
    </div>
  )
}
