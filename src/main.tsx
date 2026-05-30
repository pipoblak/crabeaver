import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'

// Dev-only: forward console + Tauri IPC to Rust terminal
if (import.meta.env.DEV) {
  import('./debug')
}
import App from './App.tsx'
import { ThemeProvider } from '@/context/ThemeContext'
import { ValidationProvider } from '@/context/ValidationContext'
import { ConnectionProvider } from '@/context/ConnectionContext'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ThemeProvider>
      <ValidationProvider>
        <ConnectionProvider>
          <App />
        </ConnectionProvider>
      </ValidationProvider>
    </ThemeProvider>
  </StrictMode>,
)
