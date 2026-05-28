import { useState, useEffect, useRef } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { Search, Download, Check, Loader2 } from 'lucide-react'
import { useTheme } from '@/context/ThemeContext'
import type { Theme } from '@/themes'

interface MarketplaceExtension {
  publisher: string
  name: string
  display_name: string
  description: string
  version: string
}

interface ParsedTheme {
  name: string; bg: string; sidebar_bg: string; activity_bg: string
  tab_active: string; tab_inactive: string; tab_accent: string
  border: string; text: string; text_dim: string; text_bright: string
  statusbar: string; hover: string
}

function parsedToTheme(p: ParsedTheme): Theme {
  return {
    name: p.name, bg: p.bg, sidebarBg: p.sidebar_bg, activityBg: p.activity_bg,
    tabActive: p.tab_active, tabInactive: p.tab_inactive, tabAccent: p.tab_accent,
    border: p.border, text: p.text, textDim: p.text_dim, textBright: p.text_bright,
    statusbar: p.statusbar, hover: p.hover,
  }
}

export default function SettingsTab() {
  const { theme, setTheme, allThemes, addTheme } = useTheme()
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
      themes.forEach(t => addTheme(parsedToTheme(t)))
    } catch (e) { setError(String(e)) }
    finally { setInstalling(null) }
  }

  const installedNames = new Set(allThemes.map(t => t.name.toLowerCase()))

  return (
    <div className="flex h-full overflow-hidden bg-th-bg">

      {/* ── Left: theme list ── */}
      <div className="flex flex-col w-56 shrink-0 overflow-y-auto border-r border-r-th-border">
        <div className="px-4 pt-4 pb-2">
          <SectionHeader label="Color Theme" />
        </div>

        {allThemes.map(t => {
          const isActive = t.name === theme.name
          return (
            <button
              key={t.name}
              onClick={() => setTheme(t)}
              className={`flex items-center gap-2.5 w-full text-left text-[13px] transition-colors py-[7px] pl-4 pr-3 border-l-2
                ${isActive
                  ? 'border-l-th-accent bg-th-hover text-th-bright'
                  : 'border-l-transparent bg-transparent text-th-text hover:bg-th-hover hover:text-th-bright'}`}
            >
              {/* dynamic per-theme color — must stay inline */}
              <span className="shrink-0 w-[10px] h-[10px] rounded-sm" style={{ background: t.tabAccent }} />
              <span className="truncate">{t.name}</span>
            </button>
          )
        })}
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

      {/* Install button */}
      <button
        onClick={onInstall}
        disabled={isInstalling || isInstalled}
        className={`shrink-0 flex items-center gap-1.5 rounded h-[26px] px-[10px] text-[12px] transition-colors
          ${isInstalled || isInstalling ? 'cursor-default' : 'cursor-pointer'}
          ${isInstalled
            ? 'text-th-dim bg-transparent border-0'
            : `text-th-accent bg-transparent border border-th-accent ${!isInstalling ? 'hover:bg-th-accent hover:text-th-bright' : ''}`
          }`}
      >
        {isInstalling
          ? <><Loader2 size={11} className="animate-spin" /> Installing</>
          : isInstalled
          ? <><Check size={11} /> Installed</>
          : <><Download size={11} /> Install</>}
      </button>
    </div>
  )
}
