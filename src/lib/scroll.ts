// Per-query editor scroll persistence in localStorage, keyed by the query's file
// path (stable across reopen/restart). Reading is defensive: a missing, malformed,
// or wrong-shaped entry yields null rather than throwing.

export interface ScrollPos {
  top:  number
  left: number
}

const keyFor = (filePath: string) => `cb:scroll:${filePath}`

export function loadScroll(filePath: string): ScrollPos | null {
  try {
    const raw = localStorage.getItem(keyFor(filePath))
    if (!raw) return null
    const v = JSON.parse(raw)
    if (v && typeof v.top === 'number' && typeof v.left === 'number') {
      return { top: v.top, left: v.left }
    }
    return null
  } catch {
    return null
  }
}

export function saveScroll(filePath: string, pos: ScrollPos): void {
  try {
    localStorage.setItem(keyFor(filePath), JSON.stringify(pos))
  } catch {
    /* quota / disabled storage — non-fatal */
  }
}
