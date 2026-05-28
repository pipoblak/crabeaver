import { useState, useRef, useEffect } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { Search, Download, Check, X, Loader2 } from 'lucide-react'
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
  name: string
  bg: string
  sidebar_bg: string
  activity_bg: string
  tab_active: string
  tab_inactive: string
  tab_accent: string
  border: string
  text: string
  text_dim: string
  text_bright: string
  statusbar: string
  hover: string
}

function parsedToTheme(p: ParsedTheme): Theme {
  return {
    name: p.name,
    bg: p.bg,
    sidebarBg: p.sidebar_bg,
    activityBg: p.activity_bg,
    tabActive: p.tab_active,
    tabInactive: p.tab_inactive,
    tabAccent: p.tab_accent,
    border: p.border,
    text: p.text,
    textDim: p.text_dim,
    textBright: p.text_bright,
    statusbar: p.statusbar,
    hover: p.hover,
  }
}

interface Props { onClose: () => void }

// Shared section label style
const sectionLabel = {
  className: 'px-4 pt-3 pb-1.5 text-[11px] font-semibold tracking-widest uppercase',
  style: { color: 'var(--text-dim)' },
}

export default function Settings({ onClose }: Props) {
  const { theme, setTheme, allThemes, addTheme } = useTheme()
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<MarketplaceExtension[]>([])
  const [searching, setSearching] = useState(false)
  const [installing, setInstalling] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const overlayRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose])

  const search = async () => {
    if (!query.trim()) return
    setSearching(true)
    setError(null)
    setResults([])
    try {
      const res = await invoke<MarketplaceExtension[]>('search_marketplace', { query })
      setResults(res)
    } catch (e) {
      setError(String(e))
    } finally {
      setSearching(false)
    }
  }

  const install = async (ext: MarketplaceExtension) => {
    const key = `${ext.publisher}.${ext.name}`
    setInstalling(key)
    setError(null)
    try {
      const themes = await invoke<ParsedTheme[]>('install_theme', {
        publisher: ext.publisher,
        name: ext.name,
        version: ext.version,
      })
      themes.forEach(t => addTheme(parsedToTheme(t)))
    } catch (e) {
      setError(String(e))
    } finally {
      setInstalling(null)
    }
  }

  return (
    <div
      ref={overlayRef}
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: 'rgba(0,0,0,0.55)' }}
      onClick={e => { if (e.target === overlayRef.current) onClose() }}
    >
      <div
        className="flex flex-col w-[680px] max-h-[75vh] rounded-lg shadow-2xl overflow-hidden"
        style={{ background: 'var(--sidebar-bg)', border: '1px solid var(--border)' }}
      >
        {/* Header */}
        <div
          className="flex items-center justify-between px-4 py-3 shrink-0"
          style={{ borderBottom: '1px solid var(--border)' }}
        >
          <span className="text-[13px] font-semibold" style={{ color: 'var(--text-bright)' }}>
            Settings — Themes
          </span>
          <button
            onClick={onClose}
            className="flex items-center justify-center w-6 h-6 rounded transition-colors"
            style={{ color: 'var(--text-dim)' }}
            onMouseEnter={e => (e.currentTarget.style.color = 'var(--text)')}
            onMouseLeave={e => (e.currentTarget.style.color = 'var(--text-dim)')}
          >
            <X size={14} />
          </button>
        </div>

        <div className="flex flex-1 min-h-0">
          {/* Left: installed themes */}
          <div
            className="flex flex-col w-52 shrink-0 overflow-y-auto"
            style={{ borderRight: '1px solid var(--border)' }}
          >
            <p {...sectionLabel}>Installed</p>
            {allThemes.map(t => (
              <button
                key={t.name}
                onClick={() => setTheme(t)}
                className="flex items-center justify-between px-4 py-1.5 text-[13px] text-left transition-colors"
                style={{
                  color: t.name === theme.name ? 'var(--text-bright)' : 'var(--text)',
                  background: t.name === theme.name ? 'var(--hover)' : 'transparent',
                }}
                onMouseEnter={e => {
                  if (t.name !== theme.name)
                    e.currentTarget.style.background = 'var(--hover)'
                }}
                onMouseLeave={e => {
                  if (t.name !== theme.name)
                    e.currentTarget.style.background = 'transparent'
                }}
              >
                <span>{t.name}</span>
                {t.name === theme.name && (
                  <Check size={12} style={{ color: 'var(--tab-accent)' }} />
                )}
              </button>
            ))}
          </div>

          {/* Right: marketplace */}
          <div className="flex flex-col flex-1 min-w-0 overflow-hidden">
            <p {...sectionLabel}>VS Code Marketplace</p>

            {/* Search */}
            <div className="flex gap-2 px-4 pb-3">
              <div className="relative flex-1">
                <Search
                  size={13}
                  className="absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none"
                  style={{ color: 'var(--text-dim)' }}
                />
                <input
                  className="w-full h-8 pl-8 pr-3 text-[13px] rounded outline-none"
                  style={{
                    background: 'var(--bg)',
                    border: '1px solid var(--border)',
                    color: 'var(--text)',
                  }}
                  placeholder="Search themes..."
                  value={query}
                  onChange={e => setQuery(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') search() }}
                />
              </div>
              <button
                onClick={search}
                disabled={searching}
                className="h-8 px-3 text-[13px] rounded transition-opacity"
                style={{
                  background: 'var(--tab-accent)',
                  color: '#fff',
                  opacity: searching ? 0.6 : 1,
                  minWidth: '64px',
                }}
              >
                {searching
                  ? <Loader2 size={13} className="animate-spin mx-auto" />
                  : 'Search'}
              </button>
            </div>

            {/* Error */}
            {error && (
              <div className="mx-4 mb-3 px-3 py-2 rounded text-[12px]"
                style={{ background: 'var(--error-bg)', color: 'var(--error-text)' }}>
                {error}
              </div>
            )}

            {/* Results */}
            <div className="flex flex-col gap-2 px-4 pb-4 overflow-y-auto flex-1">
              {results.length === 0 && !searching && (
                <p className="text-[12px]" style={{ color: 'var(--text-dim)' }}>
                  {query ? 'No results.' : 'Search for any VS Code theme — Dracula, Tokyo Night, Catppuccin…'}
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
                    className="flex items-start justify-between gap-3 px-3 py-2.5 rounded"
                    style={{ background: 'var(--bg)', border: '1px solid var(--border)' }}
                  >
                    <div className="flex flex-col gap-0.5 min-w-0">
                      <span className="text-[13px] font-medium truncate" style={{ color: 'var(--text-bright)' }}>
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
                      disabled={isInstalling}
                      className="shrink-0 flex items-center gap-1.5 px-2.5 py-1 text-[12px] rounded transition-opacity"
                      style={{
                        background: isInstalled ? 'var(--hover)' : 'var(--tab-accent)',
                        color: isInstalled ? 'var(--text)' : '#fff',
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
      </div>
    </div>
  )
}
