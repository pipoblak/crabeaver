// Import from 'vitest/config' (not 'vite') so the `test` block below type-checks
// under `tsc -b`. It re-exports vite's defineConfig extended with Vitest options.
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'path'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { '@': path.resolve(__dirname, './src') },
  },
  clearScreen: false,
  server: {
    // App-specific dev port (Tauri's conventional default) — avoids colliding
    // with Vite's ubiquitous 5173 used by other projects. strictPort fails fast
    // instead of silently moving, so it can never mismatch tauri.conf's devUrl.
    port: 1420,
    strictPort: true,
    watch: { ignored: ['**/src-tauri/**'] },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
  },
})
