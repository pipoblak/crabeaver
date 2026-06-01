import { useEffect } from 'react'
import { X } from 'lucide-react'

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)
const mod = isMac ? '⌘' : 'Ctrl'

interface Shortcut {
  keys: string[]
  label: string
}

interface Group {
  title: string
  shortcuts: Shortcut[]
}

const GROUPS: Group[] = [
  {
    title: 'Tabs',
    shortcuts: [
      { keys: [mod, 'T'], label: 'New query tab' },
      { keys: [mod, 'W'], label: 'Close tab' },
    ],
  },
  {
    title: 'Query',
    shortcuts: [
      { keys: [mod, '↵'], label: 'Run query (current statement)' },
      { keys: [mod, '⇧', '↵'], label: 'Run query in new tab' },
    ],
  },
  {
    title: 'Results',
    shortcuts: [
      { keys: [mod, '['], label: 'Previous result' },
      { keys: [mod, ']'], label: 'Next result' },
      { keys: ['↵'], label: 'Commit inline edit' },
      { keys: ['Esc'], label: 'Cancel inline edit' },
    ],
  },
]

interface Props {
  onClose: () => void
}

export default function HotkeysHelp({ onClose }: Props) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/40"
      onMouseDown={onClose}
    >
      <div
        role="dialog"
        aria-label="Keyboard shortcuts"
        onMouseDown={e => e.stopPropagation()}
        className="w-[420px] max-h-[80vh] overflow-y-auto rounded-lg bg-th-bg border border-th-border shadow-xl"
      >
        <div className="flex items-center justify-between px-4 h-11 border-b border-b-th-border">
          <span className="text-[13px] font-medium text-th-bright">Keyboard Shortcuts</span>
          <button
            aria-label="Close"
            onClick={onClose}
            className="flex items-center justify-center w-6 h-6 rounded text-th-dim hover:text-th-text hover:bg-th-hover transition-colors"
          >
            <X size={14} />
          </button>
        </div>

        <div className="p-4 flex flex-col gap-4">
          {GROUPS.map(group => (
            <div key={group.title}>
              <div className="text-[11px] uppercase tracking-wide text-th-dim mb-1.5">{group.title}</div>
              <div className="flex flex-col gap-1">
                {group.shortcuts.map(s => (
                  <div key={s.label} className="flex items-center justify-between h-7">
                    <span className="text-[13px] text-th-text">{s.label}</span>
                    <span className="flex items-center gap-1">
                      {s.keys.map((k, i) => (
                        <kbd
                          key={i}
                          className="inline-flex items-center justify-center min-w-[20px] h-6 px-1.5 rounded border border-th-border bg-th-tab-inactive text-[11px] text-th-text"
                        >
                          {k}
                        </kbd>
                      ))}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
