import { useState, useEffect, useRef } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { Search, Download, Check, Loader2, Trash2, RefreshCw } from 'lucide-react'
import { useTheme } from '@/context/ThemeContext'
import type { Theme } from '@/themes'

interface MarketplaceExtension {
  publisher: string; name: string; display_name: string
  description: string; version: string
}
interface TokenRule { token: string; foreground?: string; font_style?: string }
interface ParsedTheme {
  name: string; bg: string; sidebar_bg: string; activity_bg: string
  tab_active: string; tab_inactive: string; tab_accent: string
  border: string; text: string; text_dim: string; text_bright: string
  statusbar: string; hover: string; token_rules: TokenRule[]
}

function parsedToTheme(p: ParsedTheme, ext: MarketplaceExtension): Theme {
  return {
    name: p.name, bg: p.bg, sidebarBg: p.sidebar_bg, activityBg: p.activity_bg,
    tabActive: p.tab_active, tabInactive: p.tab_inactive, tabAccent: p.tab_accent,
    border: p.border, text: p.text, textDim: p.text_dim, textBright: p.text_bright,
    statusbar: p.statusbar, hover: p.hover, tokenRules: p.token_rules,
    source: { publisher: ext.publisher, name: ext.name, version: ext.version, displayName: ext.display_name },
  }
}

interface ThemeGroup { key: string; themes: Theme[]; source?: Theme['source'] }

function groupThemes(themes: Theme[]): ThemeGroup[] {
  const map = new Map<string, Theme[]>()
  for (const t of themes) {
    const key = t.name.split(/[\s\-–—]/)[0]
    const arr = map.get(key) ?? []
    arr.push(t)
    map.set(key, arr)
  }
  return Array.from(map.entries()).map(([key, themes]) => {
    const src = themes[0]?.source
    const sharedSource = src && themes.every(t => t.source?.name === src.name && t.source?.publisher === src.publisher) ? src : undefined
    return { key, themes, source: sharedSource }
  })
}

export default function ThemesSection() {
  const { theme, setTheme, allThemes, addTheme, removeTheme, isBuiltin } = useTheme()
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<MarketplaceExtension[]>([])
  const [searching, setSearching] = useState(false)
  const [installing, setInstalling] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const searchRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (searchRef.current) clearTimeout(searchRef.current)
    const trimmed = query.trim()
    if (!trimmed) { setResults([]); setError(null); return }
    searchRef.current = setTimeout(async () => {
      setSearching(true); setError(null)
      try { setResults(await invoke<MarketplaceExtension[]>('search_marketplace', { query: trimmed })) }
      catch (e) { setError(String(e)) }
      finally { setSearching(false) }
    }, 400)
    return () => { if (searchRef.current) clearTimeout(searchRef.current) }
  }, [query])

  const install = async (ext: MarketplaceExtension) => {
    const key = `${ext.publisher}.${ext.name}`
    setInstalling(key); setError(null)
    try {
      const themes = await invoke<ParsedTheme[]>('install_theme', { publisher: ext.publisher, name: ext.name, version: ext.version })
      themes.forEach(t => addTheme(parsedToTheme(t, ext)))
    } catch (e) { setError(String(e)) }
    finally { setInstalling(null) }
  }

  const reinstallGroup = async (source: NonNullable<Theme['source']>) => {
    await install({ publisher: source.publisher, name: source.name, version: source.version, display_name: source.displayName, description: '' })
  }

  const installedNames = new Set(allThemes.map(t => t.name.toLowerCase()))

  return (
    <div className="flex h-full overflow-hidden">

      {/* Theme list */}
      <div className="flex flex-col w-52 shrink-0 overflow-y-auto" style={{ borderRight: '1px solid var(--border)' }}>
        <div style={{ padding: '16px 16px 8px' }}>
          <p className="text-[11px] font-semibold tracking-widest uppercase text-th-dim">Installed</p>
        </div>

        {groupThemes(allThemes).map(({ key, themes: group, source: groupSource }) => {
          const groupBuiltin = group.every(t => isBuiltin(t.name))
          const installingGroup = group.some(t => installing === `${groupSource?.publisher}.${groupSource?.name}`)
          return (
            <div key={key}>
              {group.length > 1 && (
                <div className="group/hdr flex items-center justify-between select-none" style={{ padding: '8px 16px 4px' }}>
                  <span className="text-[10px] font-semibold tracking-widest uppercase text-th-dim">{key}</span>
                  {!groupBuiltin && (
                    <div className="flex items-center gap-1.5 opacity-0 group-hover/hdr:opacity-100 transition-opacity">
                      {groupSource && (
                        <button title="Reinstall" onClick={() => reinstallGroup(groupSource)} disabled={installingGroup} className="text-th-dim hover:text-th-accent transition-colors">
                          {installingGroup ? <Loader2 size={10} className="animate-spin" /> : <RefreshCw size={10} />}
                        </button>
                      )}
                      <button title="Remove group" onClick={() => group.forEach(t => removeTheme(t.name))} className="text-th-dim hover:text-th-err transition-colors">
                        <Trash2 size={10} />
                      </button>
                    </div>
                  )}
                </div>
              )}
              {group.map(t => {
                const isActive = t.name === theme.name
                const builtin  = isBuiltin(t.name)
                const label    = group.length > 1 ? (t.name.slice(key.length).trim() || t.name) : t.name
                return (
                  <div
                    key={t.name}
                    onClick={() => setTheme(t)}
                    className={`group flex items-center gap-2 w-full text-[13px] transition-colors border-l-2 cursor-pointer
                      ${isActive ? 'border-l-th-accent bg-th-hover text-th-bright' : 'border-l-transparent text-th-text hover:bg-th-hover hover:text-th-bright'}`}
                    style={{ padding: '5px 8px 5px', paddingLeft: group.length > 1 ? 24 : 16 }}
                  >
                    <span className="shrink-0 w-[10px] h-[10px] rounded-sm" style={{ background: t.tabAccent }} />
                    <span className="truncate flex-1">{label}</span>
                    {!builtin && (
                      <button title="Remove"
                        onClick={e => { e.stopPropagation(); removeTheme(t.name) }}
                        className="shrink-0 opacity-0 group-hover:opacity-100 transition-opacity text-th-dim hover:text-th-err">
                        <Trash2 size={11} />
                      </button>
                    )}
                  </div>
                )
              })}
            </div>
          )
        })}
      </div>

      {/* Marketplace */}
      <div className="flex flex-col flex-1 min-w-0 overflow-hidden">
        <div style={{ padding: '16px', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
          <p className="text-[11px] font-semibold tracking-widest uppercase text-th-dim mb-3">VS Code Marketplace</p>
          <div className="relative">
            <span className="absolute top-1/2 -translate-y-1/2 pointer-events-none flex items-center text-th-dim" style={{ left: 10 }}>
              {searching ? <Loader2 size={13} className="animate-spin" /> : <Search size={13} />}
            </span>
            <input
              style={{ width: '100%', height: 32, paddingLeft: 32, paddingRight: 12, fontSize: 13, borderRadius: 4, background: 'var(--sidebar-bg)', border: '1px solid var(--border)', color: 'var(--text)', outline: 'none' }}
              placeholder="Dracula, Tokyo Night, Catppuccin…"
              value={query}
              onChange={e => setQuery(e.target.value)}
              onFocus={e => (e.currentTarget.style.borderColor = 'var(--tab-accent)')}
              onBlur={e => (e.currentTarget.style.borderColor = 'var(--border)')}
            />
          </div>
          {error && <div className="mt-2 px-3 py-1.5 rounded text-[12px] bg-th-err-bg text-th-err">{error}</div>}
        </div>

        <div className="flex-1 overflow-y-auto">
          {results.length === 0 && !searching && (
            <div style={{ padding: 16 }}>
              <p className="text-[12px] text-th-dim">{query ? `No results for "${query}".` : 'Search any VS Code theme to install it.'}</p>
            </div>
          )}
          {results.map(ext => {
            const key = `${ext.publisher}.${ext.name}`
            const isInstalling = installing === key
            const isInstalled  = installedNames.has(ext.display_name.toLowerCase())
            return (
              <div key={key} className="group flex items-start transition-colors border-b border-b-th-border hover:bg-th-hover" style={{ padding: '12px 16px', gap: 12 }}>
                <div className="flex flex-col gap-0.5 flex-1 min-w-0">
                  <span className="text-[13px] font-medium text-th-bright truncate">{ext.display_name}</span>
                  <span className="text-[11px] text-th-dim">{ext.publisher} · v{ext.version}</span>
                  {ext.description && <span className="text-[12px] text-th-dim truncate">{ext.description}</span>}
                </div>
                <button
                  onClick={() => install(ext)}
                  disabled={isInstalling}
                  className="shrink-0 flex items-center gap-1.5 rounded text-[12px] transition-colors text-th-accent border border-th-accent hover:bg-th-accent hover:text-th-bright"
                  style={{ height: 26, padding: '0 10px', cursor: isInstalling ? 'default' : 'pointer', opacity: isInstalling ? 0.6 : 1 }}
                >
                  {isInstalling ? <><Loader2 size={11} className="animate-spin" /> Installing</>
                    : isInstalled ? <><RefreshCw size={11} /> Reinstall</>
                    : <><Download size={11} /> Install</>}
                </button>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
