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
      <div
        className="flex items-end overflow-x-auto shrink-0"
        style={{ background: 'var(--tab-inactive)', borderBottom: '1px solid var(--border)' }}
      >
        {tabs.map(tab => {
          const isActive = tab.id === activeId
          return (
            <div
              key={tab.id}
              onClick={() => setActiveId(tab.id)}
              className="group flex items-center h-9 px-4 text-[13px] cursor-pointer select-none shrink-0 transition-colors"
              style={{
                background: isActive ? 'var(--tab-active)' : 'transparent',
                color: isActive ? 'var(--text-bright)' : 'var(--text-dim)',
                borderRight: '1px solid var(--border)',
                borderTop: isActive ? '1px solid var(--tab-accent)' : '1px solid transparent',
                gap: '8px',
              }}
              onMouseEnter={e => { if (!isActive) e.currentTarget.style.color = 'var(--text)' }}
              onMouseLeave={e => { if (!isActive) e.currentTarget.style.color = 'var(--text-dim)' }}
            >
              <span className="shrink-0">{tab.title}</span>
              <span className="w-4 h-4 flex items-center justify-center shrink-0">
                {tabs.length > 1 && (
                  <button
                    className="flex items-center justify-center w-4 h-4 rounded opacity-0 group-hover:opacity-100 transition-opacity"
                    style={{ color: 'var(--text-dim)' }}
                    onMouseEnter={e => (e.currentTarget.style.color = 'var(--text)')}
                    onMouseLeave={e => (e.currentTarget.style.color = 'var(--text-dim)')}
                    onClick={e => { e.stopPropagation(); closeTab(tab.id) }}
                  >
                    <X size={12} />
                  </button>
                )}
              </span>
            </div>
          )
        })}
        <button
          onClick={openQueryTab}
          className="flex items-center justify-center w-9 h-9 shrink-0 text-lg transition-colors"
          style={{ color: 'var(--text-dim)' }}
          onMouseEnter={e => {
            e.currentTarget.style.color = 'var(--text)'
            e.currentTarget.style.background = 'var(--hover)'
          }}
          onMouseLeave={e => {
            e.currentTarget.style.color = 'var(--text-dim)'
            e.currentTarget.style.background = 'transparent'
          }}
        >
          +
        </button>
      </div>

      {/* Editor */}
      <div className="relative flex-1 min-h-0" style={{ background: 'var(--bg)' }}>
        {active && (
          <textarea
            key={active.id}
            className="absolute inset-0 w-full h-full resize-none outline-none"
            style={{
              background: 'var(--bg)',
              color: 'var(--text)',
              fontFamily: "'Cascadia Code', 'JetBrains Mono', Consolas, monospace",
              fontSize: '14px',
              lineHeight: '1.6',
              padding: '16px 20px',
              caretColor: '#aeafad',
            }}
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
