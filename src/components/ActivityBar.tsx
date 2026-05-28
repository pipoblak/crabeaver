import { Database, Search, GitBranch, Settings } from 'lucide-react'
import { useState } from 'react'
import type { AppView } from '@/App'

const navItems = [
  { icon: Database,   label: 'Connections' },
  { icon: Search,     label: 'Search' },
  { icon: GitBranch,  label: 'History' },
]

interface Props {
  view: AppView
  setView: (v: AppView) => void
}

export default function ActivityBar({ view, setView }: Props) {
  const [activeNav, setActiveNav] = useState(0)

  const handleNavClick = (i: number) => {
    setActiveNav(i)
    setView('editor')
  }

  return (
    <div className="flex flex-col items-center w-12 shrink-0 bg-th-activity border-r border-r-th-border">
      <div className="flex flex-col items-center flex-1 pt-1">
        {navItems.map((item, i) => {
          const Icon = item.icon
          const isActive = view === 'editor' && activeNav === i
          return (
            <button
              key={item.label}
              title={item.label}
              onClick={() => handleNavClick(i)}
              className={`relative flex items-center justify-center w-12 h-11 transition-colors border-l-2
                ${isActive
                  ? 'text-th-bright border-l-th-bright'
                  : 'text-th-dim border-l-transparent hover:text-th-text'}`}
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
          className={`relative flex items-center justify-center w-12 h-11 transition-colors border-l-2
            ${view === 'settings'
              ? 'text-th-bright border-l-th-bright'
              : 'text-th-dim border-l-transparent hover:text-th-text'}`}
        >
          <Settings size={20} strokeWidth={1.5} />
        </button>
      </div>
    </div>
  )
}
