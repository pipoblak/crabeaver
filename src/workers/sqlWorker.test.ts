import { describe, it, expect } from 'vitest'
import { splitStatements, getDirtyStatements, getViewportStatements } from './sqlWorker'

// Disaster tests for the editor's statement splitter: it runs on every keystroke
// over whatever the user types, so it must never throw or hang on hostile input.
describe('sqlWorker splitter — pathological input', () => {
  it('handles empty / whitespace-only input', () => {
    expect(splitStatements([])).toEqual([])
    expect(splitStatements([''])).toEqual([])
    expect(splitStatements(['', '   ', ''])).toEqual([])
  })

  it('does not crash on comment-only or unterminated input', () => {
    expect(() => splitStatements(['-- just a comment'])).not.toThrow()
    expect(splitStatements(['SELECT 1', 'FROM t']).length).toBeGreaterThanOrEqual(1)
  })

  it('does not hang on a megabyte single line', () => {
    const huge = 'SELECT ' + '1,'.repeat(500_000) + '1'
    const start = performance.now()
    const r = splitStatements([huge])
    expect(r.length).toBe(1)
    expect(performance.now() - start).toBeLessThan(2000)
  })

  it('splits thousands of statements correctly', () => {
    const lines = Array.from({ length: 5000 }, (_, i) => `SELECT ${i};`)
    expect(splitStatements(lines).length).toBe(5000)
  })

  it('never throws when keywords appear inside string literals', () => {
    // The keyword-based splitter may over/under-split here, but must not throw.
    expect(() => splitStatements([`SELECT 'CREATE TABLE x' AS y`, 'FROM t'])).not.toThrow()
  })

  it('getDirtyStatements survives a document that shrank', () => {
    const oldL = ['SELECT 1;', 'SELECT 2;', 'SELECT 3;']
    const newL = ['SELECT 1;']
    const stmts = splitStatements(oldL)
    expect(() => getDirtyStatements(oldL, newL, stmts)).not.toThrow()
  })
})

describe('getViewportStatements — viewport coverage', () => {
  // A 10-line statement (lines 1-10, 0-indexed start 0). Viewport shows lines
  // 4-8 — the user scrolled into the BODY of the statement, its start is above.
  const lines = [
    'SELECT a,',          // 1  (stmt start)
    '       b,',          // 2
    '       c,',          // 3
    '       d,',          // 4  ← viewport top
    '       e,',          // 5
    '       f,',          // 6
    '       g,',          // 7
    '       h',           // 8  ← viewport bottom
    'FROM big_table',     // 9
    'WHERE x = 1;',       // 10
  ]

  it('includes a multi-line statement whose body fills the viewport', () => {
    // Viewport = lines 4..8 (Monaco 1-indexed). The only statement starts at
    // line 1, so its start is ABOVE the viewport. It must still be validated.
    const stmts = getViewportStatements(lines, 4, 8)
    expect(stmts.length).toBe(1)
    expect(stmts[0].start).toBe(0)
  })
})
