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

function splitStatements(lines: string[]): Statement[] {
  const stmts: Statement[] = []
  let current: string[] = []
  let currentStart = 0

  for (let i = 0; i < lines.length; i++) {
    if (i > 0 && isStatementStart(lines[i]) && current.length) {
      stmts.push({ start: currentStart, text: current.join('\n'), lineCount: current.length })
      current = []
      currentStart = i
    }
    current.push(lines[i])
  }
  if (current.length) {
    stmts.push({ start: currentStart, text: current.join('\n'), lineCount: current.length })
  }
  return stmts
}

function getDirtyLines(oldLines: string[], newLines: string[]): number[] {
  const dirty: number[] = []
  const max = Math.max(oldLines.length, newLines.length)
  for (let i = 0; i < max; i++) {
    if (oldLines[i] !== newLines[i]) dirty.push(i)
  }
  return dirty
}

function getViewportStatements(
  lines: string[],
  firstLine: number,  // 1-indexed (Monaco)
  lastLine: number,
): Statement[] {
  return splitStatements(lines).filter(
    s => s.start >= firstLine - 1 && s.start <= lastLine - 1
  )
}

function getDirtyStatements(
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
