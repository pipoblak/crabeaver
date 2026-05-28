export interface Theme {
  name: string
  bg: string
  sidebarBg: string
  activityBg: string
  tabActive: string
  tabInactive: string
  tabAccent: string
  border: string
  text: string
  textDim: string
  textBright: string
  statusbar: string
  hover: string
}

export const themes: Theme[] = [
  {
    name: 'VS Code Dark+',
    bg: '#1e1e1e',
    sidebarBg: '#252526',
    activityBg: '#333333',
    tabActive: '#1e1e1e',
    tabInactive: '#2d2d2d',
    tabAccent: '#007acc',
    border: '#3c3c3c',
    text: '#cccccc',
    textDim: '#858585',
    textBright: '#ffffff',
    statusbar: '#007acc',
    hover: '#2a2d2e',
  },
  {
    name: 'Dracula',
    bg: '#282a36',
    sidebarBg: '#21222c',
    activityBg: '#191a21',
    tabActive: '#282a36',
    tabInactive: '#21222c',
    tabAccent: '#bd93f9',
    border: '#44475a',
    text: '#f8f8f2',
    textDim: '#6272a4',
    textBright: '#ffffff',
    statusbar: '#6272a4',
    hover: '#44475a',
  },
  {
    name: 'One Dark Pro',
    bg: '#282c34',
    sidebarBg: '#21252b',
    activityBg: '#1d2026',
    tabActive: '#282c34',
    tabInactive: '#21252b',
    tabAccent: '#528bff',
    border: '#181a1f',
    text: '#abb2bf',
    textDim: '#5c6370',
    textBright: '#ffffff',
    statusbar: '#4078f2',
    hover: '#2c313a',
  },
  {
    name: 'Nord',
    bg: '#2e3440',
    sidebarBg: '#272c36',
    activityBg: '#222730',
    tabActive: '#2e3440',
    tabInactive: '#272c36',
    tabAccent: '#88c0d0',
    border: '#3b4252',
    text: '#d8dee9',
    textDim: '#616e88',
    textBright: '#eceff4',
    statusbar: '#5e81ac',
    hover: '#3b4252',
  },
  {
    name: 'Monokai',
    bg: '#272822',
    sidebarBg: '#1e1f1c',
    activityBg: '#1a1b19',
    tabActive: '#272822',
    tabInactive: '#1e1f1c',
    tabAccent: '#a6e22e',
    border: '#3e3d32',
    text: '#f8f8f2',
    textDim: '#75715e',
    textBright: '#ffffff',
    statusbar: '#75715e',
    hover: '#3e3d32',
  },
  {
    name: 'GitHub Dark',
    bg: '#0d1117',
    sidebarBg: '#161b22',
    activityBg: '#010409',
    tabActive: '#0d1117',
    tabInactive: '#161b22',
    tabAccent: '#58a6ff',
    border: '#30363d',
    text: '#e6edf3',
    textDim: '#7d8590',
    textBright: '#ffffff',
    statusbar: '#1f6feb',
    hover: '#21262d',
  },
  {
    name: 'Catppuccin Mocha',
    bg: '#1e1e2e',
    sidebarBg: '#181825',
    activityBg: '#11111b',
    tabActive: '#1e1e2e',
    tabInactive: '#181825',
    tabAccent: '#cba6f7',
    border: '#313244',
    text: '#cdd6f4',
    textDim: '#6c7086',
    textBright: '#ffffff',
    statusbar: '#7287fd',
    hover: '#313244',
  },
]

export function applyTheme(theme: Theme) {
  const root = document.documentElement
  root.style.setProperty('--bg', theme.bg)
  root.style.setProperty('--sidebar-bg', theme.sidebarBg)
  root.style.setProperty('--activity-bg', theme.activityBg)
  root.style.setProperty('--tab-active', theme.tabActive)
  root.style.setProperty('--tab-inactive', theme.tabInactive)
  root.style.setProperty('--tab-accent', theme.tabAccent)
  root.style.setProperty('--border', theme.border)
  root.style.setProperty('--text', theme.text)
  root.style.setProperty('--text-dim', theme.textDim)
  root.style.setProperty('--text-bright', theme.textBright)
  root.style.setProperty('--statusbar', theme.statusbar)
  root.style.setProperty('--hover', theme.hover)
}
