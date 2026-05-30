/**
 * Dev-only debug bridge.
 *
 * Patches console.{log,warn,error,debug} and wraps the Tauri invoke()
 * function so every call is forwarded to the Rust terminal via
 * log_from_frontend. Both sides appear in one stream.
 *
 * Imported once at the top of main.tsx, guarded by import.meta.env.DEV.
 */

import { invoke as tauriInvoke } from '@tauri-apps/api/core'

// ── Forward a message to Rust tracing ────────────────────────────────────

function fwd(level: string, ...args: unknown[]) {
  const msg = args.map(a =>
    typeof a === 'object' ? JSON.stringify(a, null, 2) : String(a)
  ).join(' ')
  // Fire-and-forget — never await, never throw
  tauriInvoke('log_from_frontend', { level, message: msg }).catch(() => {})
}

// ── Patch console ─────────────────────────────────────────────────────────

const _log   = console.log.bind(console)
const _warn  = console.warn.bind(console)
const _error = console.error.bind(console)
const _debug = console.debug.bind(console)

console.log   = (...a) => { _log  (...a); fwd('info',  ...a) }
console.warn  = (...a) => { _warn (...a); fwd('warn',  ...a) }
console.error = (...a) => { _error(...a); fwd('error', ...a) }
console.debug = (...a) => { _debug(...a); fwd('debug', ...a) }

// ── Catch unhandled promise rejections ────────────────────────────────────

window.addEventListener('unhandledrejection', e => {
  fwd('error', '[unhandled rejection]', e.reason)
})

window.addEventListener('error', e => {
  fwd('error', '[uncaught error]', e.message, e.filename, `line ${e.lineno}`)
})

// ── Wrap invoke to log IPC calls ──────────────────────────────────────────

type InvokeFn = typeof tauriInvoke

export const invoke: InvokeFn = async (cmd, args?, opts?) => {
  fwd('debug', `→ invoke(${cmd})`, args ?? '')
  try {
    const result = await tauriInvoke(cmd as string, args as Record<string, unknown>, opts)
    fwd('debug', `← invoke(${cmd}) ok`)
    return result as never
  } catch (e) {
    fwd('error', `← invoke(${cmd}) ERR`, e)
    throw e
  }
}
