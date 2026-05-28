import { useState } from 'react'
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

  const search = async () => {
    if (!query.trim()) return
    setSearching(true); setError(null); setResults([])
    try {
      setResults(await invoke<MarketplaceExtension[]>('search_marketplace', { query }))
    } catch (e) { setError(String(e)) }
    finally { setSearching(false) }
  }

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

  return (
    <div className="flex h-full overflow-hidden" style={{ background: 'var(--bg)' }}>
      {/* Left column: theme list */}
      <div
        className="flex flex-col w-64 shrink-0 overflow-y-auto"
        style={{ borderRight: '1px solid var(--border)' }}
      >
        <p className="px-4 pt-4 pb-1.5 text-[11px] font-semibold tracking-widest uppercase"
          style={{ color: 'var(--text-dim)' }}>
          Color Theme
        </p>
        {allThemes.map(t => (
          <button
            key={t.name}
            onClick={() => setTheme(t)}
            className="flex items-center justify-between px-4 py-1.5 text-[13px] text-left transition-colors"
            style={{
              color: t.name === theme.name ? 'var(--text-bright)' : 'var(--text)',
              background: t.name === theme.name ? 'var(--hover)' : 'transparent',
            }}
            onMouseEnter={e => { if (t.name !== theme.name) e.currentTarget.style.background = 'var(--hover)' }}
            onMouseLeave={e => { if (t.name !== theme.name) e.currentTarget.style.background = 'transparent' }}
          >
            <div className="flex items-center gap-2.5">
              {/* Color swatch */}
              <span className="w-3 h-3 rounded-sm shrink-0" style={{ background: t.tabAccent }} />
              <span>{t.name}</span>
            </div>
            {t.name === theme.name && <Check size={12} style={{ color: 'var(--tab-accent)' }} />}
          </button>
        ))}
      </div>

      {/* Right column: marketplace */}
      <div className="flex flex-col flex-1 min-w-0 overflow-hidden">
        <div className="px-6 pt-4 pb-3 shrink-0" style={{ borderBottom: '1px solid var(--border)' }}>
          <p className="text-[11px] font-semibold tracking-widest uppercase mb-3"
            style={{ color: 'var(--text-dim)' }}>
            VS Code Marketplace
          </p>
          <div className="flex gap-2">
            <div className="relative flex-1">
              <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none"
                style={{ color: 'var(--text-dim)' }} />
              <input
                className="w-full h-8 pl-8 pr-3 text-[13px] rounded outline-none"
                style={{ background: 'var(--sidebar-bg)', border: '1px solid var(--border)', color: 'var(--text)' }}
                placeholder="Search themes — Dracula, Tokyo Night, Catppuccin…"
                value={query}
                onChange={e => setQuery(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') search() }}
              />
            </div>
            <button
              onClick={search}
              disabled={searching}
              className="h-8 px-4 text-[13px] rounded transition-opacity"
              style={{ background: 'var(--tab-accent)', color: '#fff', opacity: searching ? 0.6 : 1 }}
            >
              {searching ? <Loader2 size={13} className="animate-spin mx-auto" /> : 'Search'}
            </button>
          </div>
          {error && (
            <div className="mt-2 px-3 py-2 rounded text-[12px]"
              style={{ background: 'var(--error-bg)', color: 'var(--error-text)' }}>
              {error}
            </div>
          )}
        </div>

        {/* Results */}
        <div className="flex flex-col gap-2 p-4 overflow-y-auto flex-1">
          {results.length === 0 && !searching && (
            <p className="text-[12px]" style={{ color: 'var(--text-dim)' }}>
              Search for any VS Code theme to install it.
            </p>
          )}
          {results.map(ext => {
            const key = `${ext.publisher}.${ext.name}`
            const isInstalling = installing === key
            const isInstalled = allThemes.some(t =>
              t.name.toLowerCase().includes(ext.display_name.toLowerCase()) ||
              ext.display_name.toLowerCase().includes(t.name.toLowerCase())
            )
            return (
              <div
                key={key}
                className="flex items-start justify-between gap-4 px-4 py-3 rounded"
                style={{ background: 'var(--sidebar-bg)', border: '1px solid var(--border)' }}
              >
                <div className="flex flex-col gap-0.5 min-w-0">
                  <span className="text-[13px] font-medium" style={{ color: 'var(--text-bright)' }}>
                    {ext.display_name}
                  </span>
                  <span className="text-[11px]" style={{ color: 'var(--text-dim)' }}>
                    {ext.publisher} · v{ext.version}
                  </span>
                  {ext.description && (
                    <span className="text-[12px] mt-0.5 line-clamp-1" style={{ color: 'var(--text-dim)' }}>
                      {ext.description}
                    </span>
                  )}
                </div>
                <button
                  onClick={() => install(ext)}
                  disabled={isInstalling || isInstalled}
                  className="shrink-0 flex items-center gap-1.5 px-3 py-1 text-[12px] rounded transition-opacity"
                  style={{
                    background: isInstalled ? 'var(--hover)' : 'var(--tab-accent)',
                    color: isInstalled ? 'var(--text-dim)' : '#fff',
                    border: isInstalled ? '1px solid var(--border)' : 'none',
                    opacity: isInstalling ? 0.6 : 1,
                  }}
                >
                  {isInstalling
                    ? <><Loader2 size={11} className="animate-spin" /> Installing</>
                    : isInstalled
                    ? <><Check size={11} /> Installed</>
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
