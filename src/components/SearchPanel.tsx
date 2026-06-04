import { useState, useEffect, useRef } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { Search as SearchIcon, Loader2, FileText, X, ChevronDown, ChevronRight } from 'lucide-react'
import { useTabs } from '@/context/TabsContext'

interface SearchMatch { line: number; text: string }
interface FileSearchResult { workspace: string; name: string; path: string; matches: SearchMatch[]; truncated: boolean }

interface Props { width?: number }

// Render a line with every case-insensitive occurrence of `q` highlighted.
function Highlighted({ text, q }: { text: string; q: string }) {
  if (!q) return <>{text}</>
  const out: React.ReactNode[] = []
  const lower = text.toLowerCase()
  const ql = q.toLowerCase()
  let i = 0, key = 0
  while (i < text.length) {
    const hit = lower.indexOf(ql, i)
    if (hit === -1) { out.push(text.slice(i)); break }
    if (hit > i) out.push(text.slice(i, hit))
    out.push(
      <mark key={key++} style={{ background: 'var(--tab-accent)', color: '#fff', borderRadius: 2, padding: '0 1px' }}>
        {text.slice(hit, hit + q.length)}
      </mark>,
    )
    i = hit + q.length
  }
  return <>{out}</>
}

export default function SearchPanel({ width = 224 }: Props) {
  const { openQueryByPath } = useTabs()
  const [query, setQuery]       = useState('')
  const [results, setResults]   = useState<FileSearchResult[]>([])
  const [loading, setLoading]   = useState(false)
  const [searched, setSearched] = useState(false)
  const [collapsedWs, setCollapsedWs]       = useState<Set<string>>(new Set())
  const [collapsedFiles, setCollapsedFiles] = useState<Set<string>>(new Set())
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => { inputRef.current?.focus() }, [])

  // Debounced content search across all workspaces.
  useEffect(() => {
    const q = query.trim()
    if (!q) { setResults([]); setSearched(false); setLoading(false); return }
    setLoading(true)
    const id = setTimeout(async () => {
      try {
        const res = await invoke<FileSearchResult[]>('search_queries', { query: q })
        setResults(res)
        setCollapsedWs(new Set())
        setCollapsedFiles(new Set())
      } catch { setResults([]) }
      finally { setLoading(false); setSearched(true) }
    }, 250)
    return () => clearTimeout(id)
  }, [query])

  const toggle = (set: Set<string>, setter: (s: Set<string>) => void, key: string) => {
    const next = new Set(set)
    next.has(key) ? next.delete(key) : next.add(key)
    setter(next)
  }

  // Group results by workspace, preserving the backend's sorted order.
  const groups: { workspace: string; files: FileSearchResult[] }[] = []
  for (const r of results) {
    let g = groups.find(x => x.workspace === r.workspace)
    if (!g) { g = { workspace: r.workspace, files: [] }; groups.push(g) }
    g.files.push(r)
  }
  const totalMatches = results.reduce((n, r) => n + r.matches.length, 0)
  const q = query.trim()

  return (
    <aside className="flex flex-col shrink-0 overflow-hidden bg-th-sidebar" style={{ width, borderRight: '1px solid var(--border)' }}>
      <div className="px-3 py-2 shrink-0" style={{ borderBottom: '1px solid var(--border)' }}>
        <div className="text-[11px] font-semibold tracking-[0.1em] uppercase text-th-dim mb-2">Search</div>
        <div className="flex items-center gap-1.5 pl-2 pr-1 rounded" style={{ background: 'var(--bg)', border: '1px solid var(--border)' }}>
          <SearchIcon size={12} className="text-th-dim shrink-0" />
          <input
            ref={inputRef}
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="Search in all workspaces…"
            spellCheck={false}
            className="flex-1 bg-transparent outline-none text-[12px] py-1.5"
            style={{ color: 'var(--text)' }}
          />
          {loading
            ? <Loader2 size={12} className="animate-spin text-th-dim shrink-0 mx-1" />
            : query && (
              <button onClick={() => setQuery('')} title="Clear"
                className="flex items-center justify-center shrink-0 w-5 h-5 rounded text-th-dim hover:text-th-text hover:bg-th-hover transition-colors">
                <X size={12} />
              </button>
            )}
        </div>
        {q && searched && (
          <div className="text-[10px] text-th-dim mt-1.5">
            {totalMatches} match{totalMatches !== 1 ? 'es' : ''} in {results.length} file{results.length !== 1 ? 's' : ''}
          </div>
        )}
      </div>

      <div className="flex-1 overflow-auto">
        {q && searched && results.length === 0 && !loading && (
          <div className="px-3 py-3 text-[12px] text-th-dim">No results</div>
        )}
        {groups.map(g => {
          const wsCollapsed = collapsedWs.has(g.workspace)
          return (
            <div key={g.workspace}>
              {/* Workspace header — collapsible */}
              <button
                onClick={() => toggle(collapsedWs, setCollapsedWs, g.workspace)}
                className="flex items-center gap-1 w-full text-left px-2 py-1.5 sticky top-0 hover:bg-th-hover"
                style={{ background: 'var(--sidebar-bg)', borderBottom: '1px solid var(--border)' }}>
                {wsCollapsed ? <ChevronRight size={12} className="text-th-dim shrink-0" /> : <ChevronDown size={12} className="text-th-dim shrink-0" />}
                <span className="text-[11px] font-semibold text-th-bright truncate">{g.workspace}</span>
                <span className="text-[10px] text-th-dim shrink-0 ml-auto">{g.files.length}</span>
              </button>

              {!wsCollapsed && g.files.map(f => {
                const fileCollapsed = collapsedFiles.has(f.path)
                return (
                  <div key={f.path}>
                    {/* File header — collapsible; chevron toggles, label opens */}
                    <div className="flex items-center w-full hover:bg-th-hover" style={{ paddingLeft: 16 }}>
                      <button onClick={() => toggle(collapsedFiles, setCollapsedFiles, f.path)}
                        className="flex items-center shrink-0 px-1 py-1 text-th-dim hover:text-th-text">
                        {fileCollapsed ? <ChevronRight size={11} /> : <ChevronDown size={11} />}
                      </button>
                      <button onClick={() => openQueryByPath(f.path)} title={f.path}
                        className="flex items-center gap-1.5 flex-1 min-w-0 text-left py-1 pr-2" style={{ color: 'var(--text)' }}>
                        <FileText size={12} className="text-th-dim shrink-0" />
                        <span className="text-[12px] truncate flex-1">{f.name}</span>
                        <span className="text-[10px] text-th-dim shrink-0">{f.matches.length}{f.truncated ? '+' : ''}</span>
                      </button>
                    </div>

                    {!fileCollapsed && (
                      <>
                        {f.matches.map((m, i) => (
                          <button
                            key={`${m.line}-${i}`}
                            onClick={() => openQueryByPath(f.path, m.line)}
                            title={`Go to line ${m.line}`}
                            className="group flex items-baseline gap-2 w-full text-left pr-3 py-0.5 cursor-pointer hover:bg-th-hover"
                            style={{ paddingLeft: 40 }}>
                            <span className="text-[10px] font-mono text-th-dim group-hover:text-th-text shrink-0 tabular-nums" style={{ minWidth: 22, textAlign: 'right' }}>{m.line}</span>
                            <span className="text-[11px] font-mono truncate text-th-dim group-hover:text-th-text">
                              <Highlighted text={m.text} q={q} />
                            </span>
                          </button>
                        ))}
                        {f.truncated && (
                          <div className="text-[10px] text-th-dim py-0.5" style={{ paddingLeft: 40 }}>
                            more results — refine your search
                          </div>
                        )}
                      </>
                    )}
                  </div>
                )
              })}
            </div>
          )
        })}
      </div>
    </aside>
  )
}
