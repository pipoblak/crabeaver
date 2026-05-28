import { useState, useEffect, useRef } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { Search, Download, Check, Loader2, Trash2, RefreshCw } from 'lucide-react'
import { useTheme } from '@/context/ThemeContext'
import { useTabs } from '@/context/TabsContext'
import type { Theme } from '@/themes'

interface MarketplaceExtension {
  publisher: string
  name: string
  display_name: string
  description: string
  version: string
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
    statusbar: p.statusbar, hover: p.hover,
    tokenRules: p.token_rules,
    source: {
      publisher: ext.publisher,
      name: ext.name,
      version: ext.version,
      displayName: ext.display_name,
    },
  }
}

export default function SettingsTab() {
  const { theme, setTheme, allThemes, addTheme, removeTheme, isBuiltin } = useTheme()
  const { reloadTabs } = useTabs()
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<MarketplaceExtension[]>([])
  const [searching, setSearching] = useState(false)
  const [installing, setInstalling] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const searchRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [queriesDir, setQueriesDir] = useState('')
  const [dirInput, setDirInput] = useState('')
  const [dirSaving, setDirSaving] = useState(false)
  const [dirError, setDirError] = useState<string | null>(null)

  useEffect(() => {
    invoke<string>('get_queries_dir')
      .then(dir => { setQueriesDir(dir); setDirInput(dir) })
      .catch(() => {})
  }, [])

  const saveDir = async () => {
    const trimmed = dirInput.trim()
    if (!trimmed || trimmed === queriesDir) return
    setDirSaving(true)
    setDirError(null)
    try {
      await invoke('set_queries_dir', { path: trimmed })
      setQueriesDir(trimmed)
      await reloadTabs()
    } catch (e) {
      setDirError(String(e))
    } finally {
      setDirSaving(false)
    }
  }

  useEffect(() => {
    if (searchRef.current) clearTimeout(searchRef.current)
    const trimmed = query.trim()
    if (!trimmed) { setResults([]); setError(null); return }
    searchRef.current = setTimeout(async () => {
      setSearching(true); setError(null)
      try {
        setResults(await invoke<MarketplaceExtension[]>('search_marketplace', { query: trimmed }))
      } catch (e) { setError(String(e)) }
      finally { setSearching(false) }
    }, 400)
    return () => { if (searchRef.current) clearTimeout(searchRef.current) }
  }, [query])

  const install = async (ext: MarketplaceExtension) => {
    const key = `${ext.publisher}.${ext.name}`
    setInstalling(key); setError(null)
    try {
      const themes = await invoke<ParsedTheme[]>('install_theme', {
        publisher: ext.publisher, name: ext.name, version: ext.version,
      })
      themes.forEach(t => addTheme(parsedToTheme(t, ext)))
    } catch (e) { setError(String(e)) }
    finally { setInstalling(null) }
  }

  const reinstallGroup = async (source: NonNullable<Theme['source']>) => {
    const fakeExt: MarketplaceExtension = {
      publisher: source.publisher, name: source.name,
      version: source.version, display_name: source.displayName, description: '',
    }
    await install(fakeExt)
  }

  const installedNames = new Set(allThemes.map(t => t.name.toLowerCase()))

  return (
    <div className="flex h-full overflow-hidden bg-th-bg">

      {/* ── Left: theme list ── */}
      <div className="flex flex-col w-56 shrink-0 overflow-y-auto border-r border-r-th-border">
        <div className="px-4 pt-4 pb-2">
          <SectionHeader label="Color Theme" />
        </div>

        {groupThemes(allThemes).map(({ key, themes: group, source: groupSource }) => {
          const groupBuiltin = group.every(t => isBuiltin(t.name))
          const installingGroup = group.some(t => installing === `${groupSource?.publisher}.${groupSource?.name}`)
          return (
          <div key={key}>
            {group.length > 1 && (
              <div className="group/hdr flex items-center justify-between px-4 pt-3 pb-1 select-none">
                <span className="text-[10px] font-semibold tracking-widest uppercase text-th-dim">
                  {key}
                </span>
                {!groupBuiltin && (
                  <div className="flex items-center gap-1.5 opacity-0 group-hover/hdr:opacity-100 transition-opacity">
                    {groupSource && (
                      <button
                        title="Reinstall group"
                        onClick={() => reinstallGroup(groupSource)}
                        className="text-th-dim hover:text-th-accent transition-colors"
                        disabled={installingGroup}
                      >
                        {installingGroup
                          ? <Loader2 size={11} className="animate-spin" />
                          : <RefreshCw size={11} />}
                      </button>
                    )}
                    <button
                      title="Remove group"
                      onClick={() => group.forEach(t => removeTheme(t.name))}
                      className="text-th-dim hover:text-th-err transition-colors"
                    >
                      <Trash2 size={11} />
                    </button>
                  </div>
                )}
              </div>
            )}
            {group.map(t => {
              const isActive = t.name === theme.name
              const builtin = isBuiltin(t.name)
              const label = group.length > 1
                ? t.name.slice(key.length).trim() || t.name
                : t.name
              return (
                <div
                  key={t.name}
                  className={`group flex items-center gap-2 w-full text-[13px] transition-colors border-l-2
                    ${isActive
                      ? 'border-l-th-accent bg-th-hover text-th-bright'
                      : 'border-l-transparent bg-transparent text-th-text hover:bg-th-hover hover:text-th-bright'}`}
                  style={{ padding: '5px 8px 5px', paddingLeft: group.length > 1 ? '24px' : '16px' }}
                >
                  <button
                    onClick={() => setTheme(t)}
                    className="flex items-center gap-2.5 flex-1 min-w-0 text-left"
                  >
                    <span className="shrink-0 w-[10px] h-[10px] rounded-sm" style={{ background: t.tabAccent }} />
                    <span className="truncate">{label}</span>
                  </button>
                  {!builtin && (
                    <button
                      title="Remove theme"
                      onClick={() => removeTheme(t.name)}
                      className="shrink-0 opacity-0 group-hover:opacity-100 transition-opacity text-th-dim hover:text-th-err"
                    >
                      <Trash2 size={12} />
                    </button>
                  )}
                </div>
              )
            })}
          </div>
        )})}

        <div className="px-4 pt-4 pb-4 border-t border-t-th-border mt-2">
          <SectionHeader label="Queries Directory" />
          <div className="mt-2 flex flex-col gap-1.5">
            <input
              className="w-full h-7 px-2 text-[12px] rounded bg-th-bg border border-th-border text-th-text outline-none focus:border-th-accent font-mono"
              value={dirInput}
              onChange={e => setDirInput(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') saveDir() }}
              spellCheck={false}
            />
            <button
              onClick={saveDir}
              disabled={dirSaving || dirInput.trim() === queriesDir}
              className="self-start h-[26px] px-3 text-[12px] rounded border border-th-accent text-th-accent hover:bg-th-accent hover:text-th-bright transition-colors disabled:opacity-40 disabled:cursor-default"
            >
              {dirSaving ? 'Saving…' : 'Set'}
            </button>
            {dirError && (
              <p className="text-[11px] text-th-err">{dirError}</p>
            )}
          </div>
        </div>
      </div>

      {/* ── Right: marketplace ── */}
      <div className="flex flex-col flex-1 min-w-0 overflow-hidden">

        {/* Search header */}
        <div className="shrink-0 border-b border-b-th-border">
          <div className="p-4">
            <SectionHeader label="VS Code Marketplace" />
            <div className="relative mt-3">
              <span className="absolute left-[10px] top-1/2 -translate-y-1/2 pointer-events-none flex items-center text-th-dim">
                {searching
                  ? <Loader2 size={13} className="animate-spin" />
                  : <Search size={13} />}
              </span>
              <input
                className="w-full h-8 pl-8 pr-3 text-[13px] rounded bg-th-sidebar border border-th-border text-th-text outline-none focus:border-th-accent"
                placeholder="Dracula, Tokyo Night, Catppuccin…"
                value={query}
                onChange={e => setQuery(e.target.value)}
              />
            </div>
            {error && (
              <div className="mt-2 px-3 py-1.5 rounded text-[12px] bg-th-err-bg text-th-err">
                {error}
              </div>
            )}
          </div>
        </div>

        {/* Results list */}
        <div className="flex-1 overflow-y-auto">
          {results.length === 0 && !searching && (
            <div className="p-4">
              <p className="text-[12px] text-th-dim">
                {query ? `No theme results for "${query}".` : 'Search any VS Code theme — Dracula, Tokyo Night, One Dark Pro…'}
              </p>
            </div>
          )}

          {results.map(ext => {
            const key = `${ext.publisher}.${ext.name}`
            const isInstalling = installing === key
            const isInstalled = installedNames.has(ext.display_name.toLowerCase())

            return (
              <ResultRow
                key={key}
                ext={ext}
                isInstalling={isInstalling}
                isInstalled={isInstalled}
                onInstall={() => install(ext)}
              />
            )
          })}
        </div>
      </div>
    </div>
  )
}

/* ── Helpers ── */

interface ThemeGroup {
  key: string
  themes: Theme[]
  source?: Theme['source'] // shared source if all themes in group have the same
}

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
    const sharedSource = src && themes.every(t => t.source?.name === src.name && t.source?.publisher === src.publisher)
      ? src : undefined
    return { key, themes, source: sharedSource }
  })
}

/* ── Sub-components ── */

function SectionHeader({ label }: { label: string }) {
  return (
    <p className="text-[11px] font-semibold tracking-widest uppercase text-th-dim">
      {label}
    </p>
  )
}

interface ResultRowProps {
  ext: MarketplaceExtension
  isInstalling: boolean
  isInstalled: boolean
  onInstall: () => void
}

function ResultRow({ ext, isInstalling, isInstalled, onInstall }: ResultRowProps) {
  return (
    <div className="group flex items-start transition-colors border-b border-b-th-border px-4 py-3 gap-3 hover:bg-th-hover">
      {/* Text block */}
      <div className="flex flex-col gap-0.5 flex-1 min-w-0">
        <span className="text-[13px] font-medium truncate text-th-bright">
          {ext.display_name}
        </span>
        <span className="text-[11px] text-th-dim">
          {ext.publisher} · v{ext.version}
        </span>
        {ext.description && (
          <span className="text-[12px] truncate text-th-dim">
            {ext.description}
          </span>
        )}
      </div>

      {/* Install / Reinstall button */}
      <button
        onClick={onInstall}
        disabled={isInstalling}
        className={`shrink-0 flex items-center gap-1.5 rounded h-[26px] px-[10px] text-[12px] transition-colors
          ${isInstalling ? 'cursor-default opacity-60' : 'cursor-pointer'}
          text-th-accent bg-transparent border border-th-accent hover:bg-th-accent hover:text-th-bright`}
      >
        {isInstalling
          ? <><Loader2 size={11} className="animate-spin" /> Installing</>
          : isInstalled
          ? <><RefreshCw size={11} /> Reinstall</>
          : <><Download size={11} /> Install</>}
      </button>
    </div>
  )
}
