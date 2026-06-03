import { Database, Search, Settings } from 'lucide-react'
import { useState, useEffect } from 'react'
import type { AppView } from '@/App'

const navItems = [
  { icon: Database,   label: 'Connections' },
  { icon: Search,     label: 'Search' },
]

const SEARCH_NAV = navItems.findIndex(n => n.label === 'Search')

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

  // ⌘/Ctrl + Shift + F → jump to the Search nav.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === 'f' || e.key === 'F')) {
        e.preventDefault()
        setActiveNav(SEARCH_NAV)
        setView('editor')
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [setView])

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
