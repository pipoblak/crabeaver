import { createContext, useContext, useState, useCallback } from 'react'

type ValidationState = 'idle' | 'scanning' | 'done'

interface ValidationContextValue {
  state: ValidationState
  errors: number
  warnings: number
  setState: (s: ValidationState) => void
  setResults: (errors: number, warnings: number) => void
}

const ValidationContext = createContext<ValidationContextValue>({
  state: 'idle', errors: 0, warnings: 0,
  setState: () => {}, setResults: () => {},
})

export function ValidationProvider({ children }: { children: React.ReactNode }) {
  const [state, setState_] = useState<ValidationState>('idle')
  const [errors, setErrors] = useState(0)
  const [warnings, setWarnings] = useState(0)

  // Stable refs — don't recreate on every render
  const setState  = useCallback((s: ValidationState) => setState_(s), [])
  const setResults = useCallback((e: number, w: number) => {
    setErrors(e)
    setWarnings(w)
  }, [])

  return (
    <ValidationContext.Provider value={{ state, errors, warnings, setState, setResults }}>
      {children}
    </ValidationContext.Provider>
  )
}

export const useValidation = () => useContext(ValidationContext)
