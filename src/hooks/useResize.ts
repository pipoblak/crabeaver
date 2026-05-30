import { useRef, useCallback } from 'react'

type Direction = 'horizontal' | 'vertical'

export function useResize(
  initial: number,
  onResize: (size: number) => void,
  direction: Direction = 'horizontal',
  min = 60,
  max = Infinity,
) {
  const startPos  = useRef(0)
  const startSize = useRef(initial)

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    startPos.current  = direction === 'horizontal' ? e.clientX : e.clientY
    startSize.current = initial

    const move = (ev: MouseEvent) => {
      const delta = (direction === 'horizontal' ? ev.clientX : ev.clientY) - startPos.current
      const next  = Math.min(max, Math.max(min, startSize.current + delta))
      onResize(next)
    }

    const up = () => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }

    document.body.style.cursor     = direction === 'horizontal' ? 'col-resize' : 'row-resize'
    document.body.style.userSelect = 'none'
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }, [initial, onResize, direction, min, max])

  return onMouseDown
}
