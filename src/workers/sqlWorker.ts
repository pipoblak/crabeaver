import { expose } from 'comlink'

/** Net `(` − `)` of a line, ignoring parens in single-quoted strings and `--`
 *  comments. Lets us know we're inside a subquery so a subquery's `SELECT` on its
 *  own line doesn't falsely start a new statement. */
function netParens(line: string): number {
  let d = 0, inStr = false
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (inStr) {
      if (c === "'") { if (line[i + 1] === "'") i++; else inStr = false }
      continue
    }
    if (c === "'") { inStr = true; continue }
    if (c === '-' && line[i + 1] === '-') break // rest of line is a comment
    if (c === '(') d++
    else if (c === ')') d--
  }
  return d
}

export interface Statement {
  start: number   // 0-indexed line in the full file
  text: string
  lineCount: number
}

export function splitStatements(lines: string[]): Statement[] {
  const stmts: Statement[] = []
  let current: string[] = []
  let currentStart = 0
  let prevEndedWithSemi = false
  let depth = 0 // open-paren depth — boundaries only apply at depth 0 (top level)

  const flush = () => {
    while (current.length > 0 && current[current.length - 1].trim() === '') current.pop()
    if (current.length > 0)
      stmts.push({ start: currentStart, text: current.join('\n'), lineCount: current.length })
    current = []
    depth = 0
  }

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim()
    // A blank line ends the current statement — but not inside a subquery.
    if (trimmed === '' && depth === 0) { flush(); prevEndedWithSemi = false; continue }
    // Only a top-level `;` begins a new statement. We deliberately do NOT split on
    // a line starting with a keyword (SELECT/WITH/…): that wrongly cut `WITH … )
    // SELECT …` (the tail SELECT) and subquery SELECTs into incomplete fragments.
    if (current.length > 0 && depth === 0 && prevEndedWithSemi) flush()
    if (current.length === 0) currentStart = i
    current.push(lines[i])
    depth = Math.max(0, depth + netParens(lines[i]))
    prevEndedWithSemi = trimmed.endsWith(';')
  }
  flush()
  return stmts
}

export function getDirtyLines(oldLines: string[], newLines: string[]): number[] {
  const dirty: number[] = []
  const max = Math.max(oldLines.length, newLines.length)
  for (let i = 0; i < max; i++) {
    if (oldLines[i] !== newLines[i]) dirty.push(i)
  }
  return dirty
}

export function getViewportStatements(
  lines: string[],
  firstLine: number,  // 1-indexed (Monaco)
  lastLine: number,
): Statement[] {
  // Include any statement that OVERLAPS the viewport, not only those whose start
  // line is visible. A multi-line statement begun above the viewport top still
  // needs validating when its body is what's on screen (scroll into a long stmt).
  const first = firstLine - 1  // → 0-indexed
  const last  = lastLine - 1
  return splitStatements(lines).filter(
    s => s.start <= last && s.start + s.lineCount - 1 >= first
  )
}

export function getDirtyStatements(
  oldLines: string[],
  newLines: string[],
  stmts: Statement[],
): number[] {
  const dirty = new Set(getDirtyLines(oldLines, newLines))
  const dirtyStarts: number[] = []
  for (const s of stmts) {
    for (let i = s.start; i < s.start + s.lineCount; i++) {
      if (dirty.has(i)) { dirtyStarts.push(s.start); break }
    }
  }
  return dirtyStarts
}

const api = {
  splitStatements,
  getDirtyLines,
  getDirtyStatements,
  getViewportStatements,
}

expose(api)

export type SqlWorkerApi = typeof api
