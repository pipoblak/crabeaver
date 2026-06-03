import { createContext, useContext, useState, useCallback, useEffect } from 'react'
import { AlertTriangle } from 'lucide-react'

export interface ConfirmOptions {
  title?: string
  message: string
  confirmLabel?: string
  cancelLabel?: string
  /** Style the confirm button as destructive (red). */
  danger?: boolean
}

type ConfirmFn = (opts: ConfirmOptions) => Promise<boolean>

const ConfirmContext = createContext<ConfirmFn>(() => Promise.resolve(false))

/** `const confirm = useConfirm(); if (await confirm({ message })) { ... }` */
export const useConfirm = () => useContext(ConfirmContext)

export function ConfirmProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<{ opts: ConfirmOptions; resolve: (v: boolean) => void } | null>(null)

  const confirm = useCallback<ConfirmFn>(opts => new Promise<boolean>(resolve => setState({ opts, resolve })), [])

  const settle = useCallback((value: boolean) => {
    setState(s => { s?.resolve(value); return null })
  }, [])

  useEffect(() => {
    if (!state) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); settle(false) }
      else if (e.key === 'Enter') { e.preventDefault(); settle(true) }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [state, settle])

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      {state && (
        <div
          className="fixed inset-0 z-[100] flex items-center justify-center"
          style={{ background: 'rgba(0,0,0,0.5)' }}
          onMouseDown={() => settle(false)}
        >
          <div
            className="rounded-lg shadow-2xl w-[360px] max-w-[90vw]"
            style={{ background: 'var(--sidebar-bg)', border: '1px solid var(--border)' }}
            onMouseDown={e => e.stopPropagation()}
          >
            <div className="flex items-start gap-3 px-5 pt-5">
              {state.opts.danger && (
                <AlertTriangle size={18} className="shrink-0 mt-0.5" style={{ color: 'var(--error-text, #f87171)' }} />
              )}
              <div className="min-w-0">
                {state.opts.title && (
                  <h2 className="text-[14px] font-semibold mb-1" style={{ color: 'var(--text-bright)' }}>{state.opts.title}</h2>
                )}
                <p className="text-[13px]" style={{ color: 'var(--text)' }}>{state.opts.message}</p>
              </div>
            </div>
            <div className="flex justify-end gap-2 px-5 py-4">
              <button
                onClick={() => settle(false)}
                className="px-3 py-1.5 rounded text-[13px] transition-colors"
                style={{ color: 'var(--text)', border: '1px solid var(--border)' }}
              >
                {state.opts.cancelLabel ?? 'Cancel'}
              </button>
              <button
                autoFocus
                onClick={() => settle(true)}
                className="px-3 py-1.5 rounded text-[13px] font-medium transition-opacity hover:opacity-90"
                style={{
                  color: '#fff',
                  background: state.opts.danger ? 'var(--error-text, #ef4444)' : 'var(--tab-accent)',
                }}
              >
                {state.opts.confirmLabel ?? 'Confirm'}
              </button>
            </div>
          </div>
        </div>
      )}
    </ConfirmContext.Provider>
  )
}
