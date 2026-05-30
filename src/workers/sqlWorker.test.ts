import { describe, it, expect } from 'vitest'
import { splitStatements, getDirtyStatements } from './sqlWorker'

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
