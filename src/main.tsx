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
import { TasksProvider } from '@/context/TasksContext'
import { ConfirmProvider } from '@/context/ConfirmContext'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ThemeProvider>
      <ValidationProvider>
        <TasksProvider>
          <ConnectionProvider>
            <ConfirmProvider>
              <App />
            </ConfirmProvider>
          </ConnectionProvider>
        </TasksProvider>
      </ValidationProvider>
    </ThemeProvider>
  </StrictMode>,
)
