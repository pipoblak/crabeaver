import { createContext, useContext, useState, useEffect } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { themes as builtinThemes, applyTheme, type Theme } from '@/themes'

interface ThemeContextValue {
  theme: Theme
  setTheme: (t: Theme) => void
  allThemes: Theme[]
  addTheme: (t: Theme) => void
  ready: boolean
}

const ThemeContext = createContext<ThemeContextValue>(null!)

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [installedThemes, setInstalledThemes] = useState<Theme[]>([])
  const [theme, setThemeState] = useState<Theme>(builtinThemes[0])
  const [ready, setReady] = useState(false)

  useEffect(() => {
    async function init() {
      try {
        const [savedThemes, activeName] = await Promise.all([
          invoke<Theme[]>('get_themes'),
          invoke<string | null>('get_setting', { key: 'active_theme' }),
        ])
        setInstalledThemes(savedThemes)

        const all = [...builtinThemes, ...savedThemes]
        const active = all.find(t => t.name === activeName) ?? builtinThemes[0]
        applyTheme(active)
        setThemeState(active)
      } catch {
        applyTheme(builtinThemes[0])
      } finally {
        setReady(true)
      }
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
      prev.some(p => p.name === t.name) ? prev : [...prev, t]
    )
    invoke('save_theme', { theme: t }).catch(console.error)
    setTheme(t)
  }

  const allThemes = [...builtinThemes, ...installedThemes]

  return (
    <ThemeContext.Provider value={{ theme, setTheme, allThemes, addTheme, ready }}>
      {children}
    </ThemeContext.Provider>
  )
}

export const useTheme = () => useContext(ThemeContext)
