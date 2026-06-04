import { createContext, useContext, useState, useEffect } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { themes as builtinThemes, defaultTheme, applyTheme, type Theme } from '@/themes'

const BUILTIN_NAMES = new Set(builtinThemes.map(t => t.name))

interface ThemeContextValue {
  theme: Theme
  setTheme: (t: Theme) => void
  allThemes: Theme[]
  addTheme: (t: Theme) => void
  removeTheme: (name: string) => void
  isBuiltin: (name: string) => boolean
  ready: boolean
}

const ThemeContext = createContext<ThemeContextValue>(null!)

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [installedThemes, setInstalledThemes] = useState<Theme[]>([])
  const [theme, setThemeState] = useState<Theme>(defaultTheme)
  const [ready, setReady] = useState(false)

  useEffect(() => {
    async function init() {
      let savedThemes: Theme[] = []
      let activeName: string | null = null
      try { savedThemes = await invoke<Theme[]>('get_themes') } catch { /* ok */ }
      try { activeName = await invoke<string | null>('get_setting', { key: 'active_theme' }) } catch { /* ok */ }
      // Drop any installed themes that are now bundled as builtins (avoids dupes
      // for users who had them installed before they shipped by default).
      const installed = savedThemes.filter(t => !BUILTIN_NAMES.has(t.name))
      setInstalledThemes(installed)
      const all = [...builtinThemes, ...installed]
      const active = all.find(t => t.name === activeName) ?? defaultTheme
      applyTheme(active)
      setThemeState(active)
      setReady(true)
    }
    init()
  }, [])

  const setTheme = (t: Theme) => {
    applyTheme(t)
    setThemeState(t)
    invoke('set_setting', { key: 'active_theme', value: t.name }).catch(console.error)
  }

  const addTheme = (t: Theme) => {
    setInstalledThemes(prev =>
      prev.some(p => p.name === t.name)
        ? prev.map(p => p.name === t.name ? t : p)  // update on reinstall
        : [...prev, t]
    )
    invoke('save_theme', { theme: t }).catch(console.error)
    setTheme(t)
  }

  const removeTheme = (name: string) => {
    if (BUILTIN_NAMES.has(name)) return
    setInstalledThemes(prev => prev.filter(t => t.name !== name))
    invoke('delete_theme', { name }).catch(console.error)
    if (theme.name === name) setTheme(defaultTheme)
  }

  const isBuiltin = (name: string) => BUILTIN_NAMES.has(name)

  const allThemes = [...builtinThemes, ...installedThemes]

  return (
    <ThemeContext.Provider value={{ theme, setTheme, allThemes, addTheme, removeTheme, isBuiltin, ready }}>
      {children}
    </ThemeContext.Provider>
  )
}

export const useTheme = () => useContext(ThemeContext)
