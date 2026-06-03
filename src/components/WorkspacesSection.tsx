import { useState } from 'react'
import { ChevronRight, ChevronDown, Folder, FolderOpen, FileText, Plus, Trash2, Check, X } from 'lucide-react'
import { useWorkspaces, type Workspace } from '@/hooks/useWorkspaces'
import { useTabs } from '@/context/TabsContext'
import ResizeHandle from '@/components/ResizeHandle'
import { beginResizeDrag } from '@/lib/resizeDrag'

// Inline text input for create / rename, committed on Enter, cancelled on Escape/blur.
function InlineInput({ initial, placeholder, onCommit, onCancel }: {
  initial?: string; placeholder?: string; onCommit: (v: string) => void; onCancel: () => void
}) {
  const [v, setV] = useState(initial ?? '')
  return (
    <input
      autoFocus value={v} placeholder={placeholder}
      onChange={e => setV(e.target.value)}
      onClick={e => e.stopPropagation()}
      onKeyDown={e => {
        e.stopPropagation()
        if (e.key === 'Enter') { const t = v.trim(); t ? onCommit(t) : onCancel() }
        else if (e.key === 'Escape') onCancel()
      }}
      onBlur={() => { const t = v.trim(); t ? onCommit(t) : onCancel() }}
      className="flex-1 bg-transparent outline outline-1 outline-th-accent px-1 text-[12px] min-w-0"
      style={{ color: 'var(--text)' }}
    />
  )
}

export default function WorkspacesSection() {
  const { workspaces, createWorkspace, renameWorkspace, deleteWorkspace, createQuery, deleteQuery, renameQuery } = useWorkspaces()
  const { openQueryByPath, closeQueryByPath, closeWorkspaceTabs, tabs, activeId } = useTabs()

  const [height, setHeight] = useState(260)   // resizable panel height (px)
  const [expanded, setExpanded] = useState<Set<string>>(new Set(['Default']))
  const [creatingWs, setCreatingWs] = useState(false)
  const [creatingIn, setCreatingIn] = useState<string | null>(null)      // workspace name
  const [renaming, setRenaming] = useState<string | null>(null)          // `ws:<name>` or `q:<path>`
  const [confirming, setConfirming] = useState<string | null>(null)      // `ws:<name>` or `q:<path>` pending delete
  const [hover, setHover] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const toggle = (name: string) => setExpanded(prev => {
    const s = new Set(prev); s.has(name) ? s.delete(name) : s.add(name); return s
  })
  const flash = (e: unknown) => { setError(String(e).replace(/^.*Error: /, '')); setTimeout(() => setError(null), 3000) }
  const run = (p: Promise<unknown>) => p.catch(flash)

  const activePath = tabs.find(t => t.id === activeId)?.filePath

  const addQuery = async (ws: string, name: string) => {
    setCreatingIn(null)
    try { const path = await createQuery(ws, name); await openQueryByPath(path) } catch (e) { flash(e) }
  }
  // Two-step delete with an inline ✓/✕ confirm (native window.confirm is a no-op
  // in the Tauri webview).
  const confirmDelete = () => {
    const key = confirming
    setConfirming(null)
    if (!key) return
    if (key.startsWith('q:')) {
      const path = key.slice(2)
      closeQueryByPath(path); run(deleteQuery(path))
    } else if (key.startsWith('ws:')) {
      const name = key.slice(3)
      closeWorkspaceTabs(name); run(deleteWorkspace(name))
    }
  }
  const ConfirmButtons = () => (
    <span className="flex items-center gap-1 shrink-0" onClick={e => e.stopPropagation()}>
      <button title="Confirm delete" className="hover:opacity-75" style={{ color: 'var(--error-text, #f87171)' }}
        onClick={e => { e.stopPropagation(); confirmDelete() }}><Check size={11} /></button>
      <button title="Cancel" className="text-th-dim hover:text-th-text"
        onClick={e => { e.stopPropagation(); setConfirming(null) }}><X size={11} /></button>
    </span>
  )
  const doRenameQuery = (oldPath: string, newName: string) => {
    setRenaming(null)
    const dir = oldPath.slice(0, oldPath.lastIndexOf('/'))
    run(renameQuery(oldPath, `${dir}/${newName}.sql`))
  }

  return (
    <div className="shrink-0 flex flex-col" style={{ height, borderTop: '1px solid var(--border)' }}>
      {/* Drag handle — resize the panel by dragging the top edge */}
      <ResizeHandle direction="vertical"
        onMouseDown={e => { const sh = height; beginResizeDrag(e, 'y', d => setHeight(Math.max(80, Math.min(window.innerHeight * 0.75, sh - d)))) }} />

      {/* Header */}
      <div className="flex items-center justify-between pl-4 pr-2 shrink-0" style={{ height: 30, borderBottom: '1px solid var(--border)' }}>
        <span className="text-[11px] font-semibold tracking-[0.1em] uppercase text-th-dim">Workspaces</span>
        <button onClick={() => setCreatingWs(true)} title="New workspace"
          className="flex items-center justify-center w-6 h-6 rounded transition-colors text-th-dim hover:text-th-text">
          <Plus size={13} />
        </button>
      </div>

      {error && <div className="px-4 py-1 text-[10px]" style={{ color: 'var(--error-text, #f87171)' }}>{error}</div>}

      <div className="flex flex-col flex-1 min-h-0 overflow-y-auto">
        {creatingWs && (
          <div className="flex items-center gap-1.5" style={{ padding: '3px 8px 3px 20px' }}>
            <Folder size={11} className="shrink-0 text-th-dim" />
            <InlineInput placeholder="workspace name"
              onCommit={name => { setCreatingWs(false); run(createWorkspace(name)).then(() => setExpanded(s => new Set(s).add(name))) }}
              onCancel={() => setCreatingWs(false)} />
          </div>
        )}

        {workspaces.length === 0 && !creatingWs && (
          <p className="text-[11px] text-th-dim px-4 py-2">No workspaces. Click + to add one.</p>
        )}

        {workspaces.map((ws: Workspace) => {
          const open = expanded.has(ws.name)
          return (
            <div key={ws.name}>
              {/* Workspace row */}
              <div
                className="flex items-center gap-1.5 cursor-pointer transition-colors"
                style={{ padding: '3px 8px 3px 8px', background: hover === `ws:${ws.name}` ? 'var(--hover)' : 'transparent' }}
                onClick={() => toggle(ws.name)}
                onMouseEnter={() => setHover(`ws:${ws.name}`)}
                onMouseLeave={() => setHover(null)}
              >
                <span className="shrink-0 text-th-dim w-3 flex justify-center">
                  {open ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
                </span>
                <span className="shrink-0 text-th-dim">{open ? <FolderOpen size={11} /> : <Folder size={11} />}</span>
                {renaming === `ws:${ws.name}` ? (
                  <InlineInput initial={ws.name}
                    onCommit={n => { setRenaming(null); run(renameWorkspace(ws.name, n)) }}
                    onCancel={() => setRenaming(null)} />
                ) : (
                  <span className="text-[12px] text-th-text truncate flex-1"
                    onDoubleClick={e => { e.stopPropagation(); setRenaming(`ws:${ws.name}`) }}>{ws.name}</span>
                )}
                {confirming === `ws:${ws.name}` ? (
                  <ConfirmButtons />
                ) : hover === `ws:${ws.name}` && renaming !== `ws:${ws.name}` && (
                  <span className="flex items-center gap-1 shrink-0">
                    <button title="New query" className="text-th-dim hover:text-th-accent"
                      onClick={e => { e.stopPropagation(); setExpanded(s => new Set(s).add(ws.name)); setCreatingIn(ws.name) }}>
                      <Plus size={11} />
                    </button>
                    <button title="Delete workspace" className="text-th-dim hover:text-th-accent"
                      onClick={e => { e.stopPropagation(); setConfirming(`ws:${ws.name}`) }}>
                      <Trash2 size={10} />
                    </button>
                  </span>
                )}
              </div>

              {/* Queries */}
              {open && (
                <>
                  {creatingIn === ws.name && (
                    <div className="flex items-center gap-1.5" style={{ padding: '3px 8px 3px 32px' }}>
                      <FileText size={10} className="shrink-0 text-th-dim" />
                      <InlineInput placeholder="query name"
                        onCommit={name => addQuery(ws.name, name)}
                        onCancel={() => setCreatingIn(null)} />
                    </div>
                  )}
                  {ws.queries.map(q => {
                    const isActive = q.path === activePath
                    return (
                      <div key={q.path}
                        className="flex items-center gap-1.5 cursor-pointer transition-colors"
                        style={{ padding: '3px 8px 3px 32px', background: isActive ? 'var(--hover)' : hover === `q:${q.path}` ? 'var(--hover)' : 'transparent' }}
                        onClick={() => run(openQueryByPath(q.path))}
                        onMouseEnter={() => setHover(`q:${q.path}`)}
                        onMouseLeave={() => setHover(null)}
                      >
                        <FileText size={10} className="shrink-0 text-th-dim" />
                        {renaming === `q:${q.path}` ? (
                          <InlineInput initial={q.name}
                            onCommit={n => doRenameQuery(q.path, n)}
                            onCancel={() => setRenaming(null)} />
                        ) : (
                          <span className="text-[12px] truncate flex-1"
                            style={{ color: isActive ? 'var(--text-bright)' : 'var(--text)' }}
                            onDoubleClick={e => { e.stopPropagation(); setRenaming(`q:${q.path}`) }}>{q.name}</span>
                        )}
                        {confirming === `q:${q.path}` ? (
                          <ConfirmButtons />
                        ) : hover === `q:${q.path}` && renaming !== `q:${q.path}` && (
                          <button title="Delete query" className="text-th-dim hover:text-th-accent shrink-0"
                            onClick={e => { e.stopPropagation(); setConfirming(`q:${q.path}`) }}>
                            <Trash2 size={10} />
                          </button>
                        )}
                      </div>
                    )
                  })}
                  {ws.queries.length === 0 && creatingIn !== ws.name && (
                    <p className="text-[10px] text-th-dim" style={{ padding: '2px 8px 2px 32px' }}>empty</p>
                  )}
                </>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
