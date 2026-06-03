/**
 * Start a pointer resize drag. Coalesces mousemove → one update per frame (rAF)
 * so dragging a split handle never floods React with state updates.
 *
 * `onDelta` receives the signed pixel delta from the drag start (current − start)
 * along the chosen axis. Compute the new size from the value captured at mousedown.
 */
export function beginResizeDrag(
  e: { clientX: number; clientY: number; preventDefault(): void },
  axis: 'x' | 'y',
  onDelta: (deltaPx: number) => void,
) {
  e.preventDefault()
  const startPos = axis === 'x' ? e.clientX : e.clientY
  document.body.style.cursor = axis === 'x' ? 'col-resize' : 'row-resize'
  document.body.style.userSelect = 'none'

  let raf = 0
  const move = (ev: MouseEvent) => {
    if (raf) return
    const pos = axis === 'x' ? ev.clientX : ev.clientY
    raf = requestAnimationFrame(() => { raf = 0; onDelta(pos - startPos) })
  }
  const up = () => {
    if (raf) cancelAnimationFrame(raf)
    window.removeEventListener('mousemove', move)
    window.removeEventListener('mouseup', up)
    document.body.style.cursor = ''
    document.body.style.userSelect = ''
  }
  window.addEventListener('mousemove', move)
  window.addEventListener('mouseup', up)
}
