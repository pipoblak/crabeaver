import { bundledThemes } from '@/themes.bundled'

export interface TokenRule {
  token: string
  foreground?: string
  fontStyle?: string
}

export interface ThemeSource {
  publisher: string
  name: string
  version: string
  displayName: string
}

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
  tokenRules?: TokenRule[]
  source?: ThemeSource
}

// Token rules extracted from each theme's actual VS Code tokenColors
function rules(list: [string, string, string?][]): TokenRule[] {
  return list.map(([token, foreground, fontStyle]) => ({
    token, foreground, fontStyle,
  }))
}

export const themes: Theme[] = [
  {
    name: 'VS Code Dark+',
    bg: '#1e1e1e', sidebarBg: '#252526', activityBg: '#333333',
    tabActive: '#1e1e1e', tabInactive: '#2d2d2d', tabAccent: '#007acc',
    border: '#3c3c3c', text: '#cccccc', textDim: '#858585', textBright: '#ffffff',
    statusbar: '#007acc', hover: '#2a2d2e',
    tokenRules: rules([
      ['keyword', '569cd6', 'bold'],
      ['keyword.sql', '569cd6', 'bold'],
      ['keyword.operator', 'd4d4d4'],
      ['string', 'ce9178'], ['string.sql', 'ce9178'],
      ['comment', '6a9955', 'italic'], ['comment.quote', '6a9955', 'italic'],
      ['number', 'b5cea8'], ['number.float', 'b5cea8'],
      ['operator', 'd4d4d4'],
      ['predefined', '4ec9b0'],
      ['type', '4ec9b0'],
    ]),
  },
  {
    name: 'Dracula',
    bg: '#282a36', sidebarBg: '#21222c', activityBg: '#191a21',
    tabActive: '#282a36', tabInactive: '#21222c', tabAccent: '#bd93f9',
    border: '#44475a', text: '#f8f8f2', textDim: '#6272a4', textBright: '#ffffff',
    statusbar: '#6272a4', hover: '#44475a',
    tokenRules: rules([
      ['keyword', 'ff79c6', 'bold'],
      ['keyword.sql', 'ff79c6', 'bold'],
      ['keyword.operator', 'ff79c6'],
      ['string', 'f1fa8c'], ['string.sql', 'f1fa8c'],
      ['comment', '6272a4', 'italic'], ['comment.quote', '6272a4', 'italic'],
      ['number', 'bd93f9'], ['number.float', 'bd93f9'],
      ['operator', 'ff79c6'],
      ['predefined', '8be9fd'],
      ['type', '8be9fd'],
    ]),
  },
  {
    name: 'One Dark Pro',
    bg: '#282c34', sidebarBg: '#21252b', activityBg: '#1d2026',
    tabActive: '#282c34', tabInactive: '#21252b', tabAccent: '#528bff',
    border: '#181a1f', text: '#abb2bf', textDim: '#5c6370', textBright: '#ffffff',
    statusbar: '#4078f2', hover: '#2c313a',
    tokenRules: rules([
      ['keyword', 'c678dd', 'bold'],
      ['keyword.sql', 'c678dd', 'bold'],
      ['keyword.operator', '56b6c2'],
      ['string', '98c379'], ['string.sql', '98c379'],
      ['comment', '5c6370', 'italic'], ['comment.quote', '5c6370', 'italic'],
      ['number', 'd19a66'], ['number.float', 'd19a66'],
      ['operator', '56b6c2'],
      ['predefined', 'e5c07b'],
      ['type', 'e5c07b'],
    ]),
  },
  {
    name: 'Nord',
    bg: '#2e3440', sidebarBg: '#272c36', activityBg: '#222730',
    tabActive: '#2e3440', tabInactive: '#272c36', tabAccent: '#88c0d0',
    border: '#3b4252', text: '#d8dee9', textDim: '#616e88', textBright: '#eceff4',
    statusbar: '#5e81ac', hover: '#3b4252',
    tokenRules: rules([
      ['keyword', '81a1c1', 'bold'],
      ['keyword.sql', '81a1c1', 'bold'],
      ['keyword.operator', '81a1c1'],
      ['string', 'a3be8c'], ['string.sql', 'a3be8c'],
      ['comment', '616e88', 'italic'], ['comment.quote', '616e88', 'italic'],
      ['number', 'b48ead'], ['number.float', 'b48ead'],
      ['operator', '81a1c1'],
      ['predefined', '8fbcbb'],
      ['type', '8fbcbb'],
    ]),
  },
  {
    name: 'Monokai',
    bg: '#272822', sidebarBg: '#1e1f1c', activityBg: '#1a1b19',
    tabActive: '#272822', tabInactive: '#1e1f1c', tabAccent: '#a6e22e',
    border: '#3e3d32', text: '#f8f8f2', textDim: '#75715e', textBright: '#ffffff',
    statusbar: '#75715e', hover: '#3e3d32',
    tokenRules: rules([
      ['keyword', 'f92672', 'bold'],
      ['keyword.sql', 'f92672', 'bold'],
      ['keyword.operator', 'f92672'],
      ['string', 'e6db74'], ['string.sql', 'e6db74'],
      ['comment', '75715e', 'italic'], ['comment.quote', '75715e', 'italic'],
      ['number', 'ae81ff'], ['number.float', 'ae81ff'],
      ['operator', 'f92672'],
      ['predefined', '66d9e8'],
      ['type', '66d9e8'],
    ]),
  },
  {
    name: 'GitHub Dark',
    bg: '#0d1117', sidebarBg: '#161b22', activityBg: '#010409',
    tabActive: '#0d1117', tabInactive: '#161b22', tabAccent: '#58a6ff',
    border: '#30363d', text: '#e6edf3', textDim: '#7d8590', textBright: '#ffffff',
    statusbar: '#1f6feb', hover: '#21262d',
    tokenRules: rules([
      ['keyword', 'ff7b72', 'bold'],
      ['keyword.sql', 'ff7b72', 'bold'],
      ['keyword.operator', 'ff7b72'],
      ['string', 'a5d6ff'], ['string.sql', 'a5d6ff'],
      ['comment', '8b949e', 'italic'], ['comment.quote', '8b949e', 'italic'],
      ['number', '79c0ff'], ['number.float', '79c0ff'],
      ['operator', 'ff7b72'],
      ['predefined', 'ffa657'],
      ['type', 'ffa657'],
    ]),
  },
  {
    name: 'Catppuccin Mocha',
    bg: '#1e1e2e', sidebarBg: '#181825', activityBg: '#11111b',
    tabActive: '#1e1e2e', tabInactive: '#181825', tabAccent: '#cba6f7',
    border: '#313244', text: '#cdd6f4', textDim: '#6c7086', textBright: '#ffffff',
    statusbar: '#7287fd', hover: '#313244',
    tokenRules: rules([
      ['keyword', 'cba6f7', 'bold'],
      ['keyword.sql', 'cba6f7', 'bold'],
      ['keyword.operator', '89dceb'],
      ['string', 'a6e3a1'], ['string.sql', 'a6e3a1'],
      ['comment', '6c7086', 'italic'], ['comment.quote', '6c7086', 'italic'],
      ['number', 'fab387'], ['number.float', 'fab387'],
      ['operator', '89dceb'],
      ['predefined', 'f38ba8'],
      ['type', 'f38ba8'],
    ]),
  },
  // Themes shipped with the app (originally user-installed). Treated as builtins.
  ...bundledThemes,
]

// Theme applied on first launch / when no theme is saved.
export const defaultTheme: Theme = themes.find(t => t.name === 'Warped Warp Dark') ?? themes[0]

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
