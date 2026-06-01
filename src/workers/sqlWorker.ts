import { expose } from 'comlink'

const STMT_KEYWORDS = /^(SELECT|INSERT|UPDATE|DELETE|CREATE|DROP|ALTER|TRUNCATE|WITH|MERGE|CALL|EXPLAIN)\b/i

function isStatementStart(line: string): boolean {
  return STMT_KEYWORDS.test(line.trimStart())
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

  const flush = () => {
    while (current.length > 0 && current[current.length - 1].trim() === '') current.pop()
    if (current.length > 0)
      stmts.push({ start: currentStart, text: current.join('\n'), lineCount: current.length })
    current = []
  }

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim()
    // A blank line ends the current statement; the blank itself belongs to none.
    if (trimmed === '') { flush(); prevEndedWithSemi = false; continue }
    // A new statement-start keyword or a prior `;` also begins a new statement.
    if (current.length > 0 && (isStatementStart(lines[i]) || prevEndedWithSemi)) flush()
    if (current.length === 0) currentStart = i
    current.push(lines[i])
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
