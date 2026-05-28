import { useEffect, useState } from 'react'
import { X } from 'lucide-react'
import { useTabs } from '@/context/TabsContext'
import SqlEditor from '@/components/SqlEditor'

export default function EditorTabs() {
  const { tabs, activeId, setActiveId, openQueryTab, closeTab, updateContent, renameTab } = useTabs()
  const [editingId, setEditingId] = useState<number | null>(null)
  const [editTitle, setEditTitle] = useState('')

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

  const startRename = (id: number, currentTitle: string) => {
    setEditingId(id)
    setEditTitle(currentTitle)
  }

  const commitRename = async () => {
    if (editingId !== null) {
      const fallback = tabs.find(t => t.id === editingId)?.title ?? ''
      await renameTab(editingId, editTitle.trim() || fallback)
    }
    setEditingId(null)
  }

  const active = tabs.find(t => t.id === activeId)

  return (
    <div className="flex flex-col flex-1 min-h-0">
      <div className="flex items-center overflow-x-auto shrink-0 bg-th-tab-inactive border-b border-b-th-border">
        {tabs.map(tab => {
          const isActive = tab.id === activeId
          const isEditing = editingId === tab.id
          return (
            <button
              key={tab.id}
              onClick={() => setActiveId(tab.id)}
              onDoubleClick={() => startRename(tab.id, tab.title)}
              className={`group flex items-center h-9 px-4 gap-2 text-[13px] cursor-pointer select-none shrink-0 transition-colors rounded-none border-r border-r-th-border border-t
                ${isActive
                  ? 'bg-th-tab-active text-th-bright border-t-th-accent'
                  : 'bg-transparent text-th-dim border-t-transparent hover:text-th-text hover:bg-th-hover'}`}
            >
              {tab.isDirty && (
                <span className="text-th-dim text-[10px] leading-none">●</span>
              )}
              {isEditing ? (
                <input
                  autoFocus
                  value={editTitle}
                  onChange={e => setEditTitle(e.target.value)}
                  onBlur={commitRename}
                  onKeyDown={e => {
                    if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.blur() }
                    if (e.key === 'Escape') setEditingId(null)
                  }}
                  onClick={e => e.stopPropagation()}
                  className="bg-transparent outline outline-1 outline-th-accent text-th-bright px-1 w-24 text-[13px]"
                />
              ) : (
                <span className="shrink-0">{tab.title}</span>
              )}
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

      <div className="relative flex-1 min-h-0 bg-th-bg">
        {active && (
          <SqlEditor
            key={active.id}
            value={active.content}
            onChange={v => updateContent(active.id, v)}
          />
        )}
      </div>
    </div>
  )
}
