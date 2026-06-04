import { Database, Search, Server, Settings } from 'lucide-react'
import { useEffect } from 'react'
import type { AppView } from '@/App'

export type SidebarPanel = 'connections' | 'search' | 'mcp'

const navItems: { icon: typeof Database; label: string; panel: SidebarPanel }[] = [
  { icon: Database, label: 'Connections', panel: 'connections' },
  { icon: Search,   label: 'Search',      panel: 'search' },
  { icon: Server,   label: 'MCP Server',  panel: 'mcp' },
]

interface Props {
  view: AppView
  setView: (v: AppView) => void
  panel: SidebarPanel
  setPanel: (p: SidebarPanel) => void
}

export default function ActivityBar({ view, setView, panel, setPanel }: Props) {
  const openPanel = (p: SidebarPanel) => {
    setPanel(p)
    setView('editor')
  }

  // ⌘/Ctrl + Shift + F → jump to the Search panel.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === 'f' || e.key === 'F')) {
        e.preventDefault()
        openPanel('search')
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div className="flex flex-col items-center w-12 shrink-0 bg-th-activity border-r border-r-th-border">
      <div className="flex flex-col items-center flex-1 pt-1">
        {navItems.map(item => {
          const Icon = item.icon
          const isActive = view === 'editor' && panel === item.panel
          return (
            <button
              key={item.label}
              title={item.label}
              onClick={() => openPanel(item.panel)}
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
