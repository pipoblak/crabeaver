import { useEffect } from 'react'
import { X } from 'lucide-react'
import { useTabs } from '@/context/TabsContext'

export default function EditorTabs() {
  const { tabs, activeId, setActiveId, openQueryTab, closeTab, updateContent } = useTabs()

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey) {
        if (e.key === 't') { e.preventDefault(); openQueryTab() }
        if (e.key === 'w') { e.preventDefault(); closeTab(activeId) }
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [openQueryTab, closeTab, activeId])

  const active = tabs.find(t => t.id === activeId)

  return (
    <div className="flex flex-col flex-1 min-h-0">
      {/* Tab bar */}
      <div className="flex items-center overflow-x-auto shrink-0 bg-th-tab-inactive border-b border-b-th-border">
        {tabs.map(tab => {
          const isActive = tab.id === activeId
          return (
            <button
              key={tab.id}
              onClick={() => setActiveId(tab.id)}
              className={`group flex items-center h-9 px-4 gap-2 text-[13px] cursor-pointer select-none shrink-0 transition-colors rounded-none border-r border-r-th-border border-t
                ${isActive
                  ? 'bg-th-tab-active text-th-bright border-t-th-accent'
                  : 'bg-transparent text-th-dim border-t-transparent hover:text-th-text hover:bg-th-hover'}`}
            >
              <span className="shrink-0">{tab.title}</span>
              <span className="w-4 h-4 flex items-center justify-center shrink-0">
                {tabs.length > 1 && (
                  <span
                    role="button"
                    aria-label={`Close ${tab.title}`}
                    className="flex items-center justify-center w-4 h-4 rounded opacity-0 group-hover:opacity-100 transition-opacity text-th-dim hover:text-th-text"
                    onClick={e => { e.stopPropagation(); closeTab(tab.id) }}
                  >
                    <X size={12} />
                  </span>
                )}
              </span>
            </button>
          )
        })}
        <button
          onClick={openQueryTab}
          className="flex items-center justify-center w-9 h-9 shrink-0 text-lg transition-colors rounded-none text-th-dim hover:text-th-text hover:bg-th-hover"
        >
          +
        </button>
      </div>

      {/* Editor */}
      <div className="relative flex-1 min-h-0 bg-th-bg">
        {active && (
          <textarea
            key={active.id}
            className="absolute inset-0 w-full h-full resize-none outline-none bg-th-bg text-th-text font-editor text-[14px] leading-[1.6] px-5 py-4 caret-[#aeafad]"
            value={active.content}
            onChange={e => updateContent(active.id, e.target.value)}
            placeholder="-- Write your SQL query here..."
            spellCheck={false}
          />
        )}
      </div>
    </div>
  )
}
