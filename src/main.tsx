import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { ThemeProvider } from '@/context/ThemeContext'
import { ValidationProvider } from '@/context/ValidationContext'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ThemeProvider>
      <ValidationProvider>
        <App />
      </ValidationProvider>
    </ThemeProvider>
  </StrictMode>,
)
