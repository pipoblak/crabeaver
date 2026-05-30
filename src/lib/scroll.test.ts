import { describe, it, expect, beforeEach } from 'vitest'
import { loadScroll, saveScroll } from './scroll'

describe('scroll persistence', () => {
  beforeEach(() => localStorage.clear())

  it('round-trips a position by file path', () => {
    saveScroll('/queries/a.sql', { top: 1200, left: 8 })
    expect(loadScroll('/queries/a.sql')).toEqual({ top: 1200, left: 8 })
  })

  it('scopes by file path (different files do not collide)', () => {
    saveScroll('/queries/a.sql', { top: 10, left: 0 })
    saveScroll('/queries/b.sql', { top: 99, left: 0 })
    expect(loadScroll('/queries/a.sql')).toEqual({ top: 10, left: 0 })
    expect(loadScroll('/queries/b.sql')).toEqual({ top: 99, left: 0 })
  })

  it('returns null for an unknown file', () => {
    expect(loadScroll('/queries/missing.sql')).toBeNull()
  })

  it('returns null (no throw) on malformed JSON', () => {
    localStorage.setItem('cb:scroll:/queries/bad.sql', '{not json')
    expect(loadScroll('/queries/bad.sql')).toBeNull()
  })

  it('ignores wrong-shaped entries', () => {
    localStorage.setItem('cb:scroll:/queries/p.sql', JSON.stringify({ top: 'x' }))
    expect(loadScroll('/queries/p.sql')).toBeNull()
  })

  it('saveScroll never throws even if storage rejects (quota)', () => {
    const orig = Storage.prototype.setItem
    Storage.prototype.setItem = () => { throw new Error('QuotaExceededError') }
    expect(() => saveScroll('/queries/x.sql', { top: 1, left: 0 })).not.toThrow()
    Storage.prototype.setItem = orig
  })
})
