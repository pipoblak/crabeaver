import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { cacheGet, cacheSet, cacheDelete, cacheClear } from './cache'

describe('cache store', () => {
  beforeEach(() => { localStorage.clear(); vi.useRealTimers() })
  afterEach(() => { cacheClear('schema-details'); cacheClear('sessions'); vi.useRealTimers() })

  it('round-trips data and stamps fetchedAt', () => {
    const before = Date.now()
    const entry = cacheSet('schema-details', 'c1:public', { tables: ['a'] })
    expect(entry.data).toEqual({ tables: ['a'] })
    expect(entry.fetchedAt).toBeGreaterThanOrEqual(before)
    expect(cacheGet('schema-details', 'c1:public')?.data).toEqual({ tables: ['a'] })
  })

  it('returns null on miss', () => {
    expect(cacheGet('schema-details', 'nope')).toBeNull()
  })

  it('persists to localStorage for persistent namespaces', () => {
    cacheSet('schema-details', 'c1:public', { n: 1 })
    expect(localStorage.getItem('cb:cache:schema-details:c1:public')).toBeTruthy()
  })

  it('does NOT persist volatile namespaces (sessions)', () => {
    cacheSet('sessions', 'c1', [{ pid: 1 }])
    expect(localStorage.getItem('cb:cache:sessions:c1')).toBeNull()
    // still available in-memory
    expect(cacheGet('sessions', 'c1')?.data).toEqual([{ pid: 1 }])
  })

  it('warms in-memory from localStorage on read', () => {
    cacheSet('schema-details', 'c1:public', { n: 2 })
    // simulate fresh session: localStorage survives, memory does not. Write the
    // LS entry directly and confirm a get rehydrates it.
    localStorage.setItem('cb:cache:schema-details:fresh', JSON.stringify({ data: { n: 9 }, fetchedAt: Date.now() }))
    expect(cacheGet('schema-details', 'fresh')?.data).toEqual({ n: 9 })
    // second get hits memory (still correct)
    expect(cacheGet('schema-details', 'fresh')?.data).toEqual({ n: 9 })
  })

  it('drops entries past the hard TTL on read', () => {
    // schema-details hard TTL = 30 min. Write an entry 31 min in the past.
    const stale = { data: { n: 3 }, fetchedAt: Date.now() - 31 * 60_000 }
    localStorage.setItem('cb:cache:schema-details:old', JSON.stringify(stale))
    expect(cacheGet('schema-details', 'old')).toBeNull()
    expect(localStorage.getItem('cb:cache:schema-details:old')).toBeNull()
  })

  it('deletes a single entry from both layers', () => {
    cacheSet('schema-details', 'c1:public', { n: 1 })
    cacheDelete('schema-details', 'c1:public')
    expect(cacheGet('schema-details', 'c1:public')).toBeNull()
    expect(localStorage.getItem('cb:cache:schema-details:c1:public')).toBeNull()
  })

  it('clears a whole namespace without touching others', () => {
    cacheSet('schema-details', 'a', 1)
    cacheSet('schema-details', 'b', 2)
    cacheSet('schemas', 'x', 3)
    cacheClear('schema-details')
    expect(cacheGet('schema-details', 'a')).toBeNull()
    expect(cacheGet('schema-details', 'b')).toBeNull()
    expect(cacheGet('schemas', 'x')?.data).toBe(3)
    cacheClear('schemas')
  })

  it('uses default config for unknown namespace (persist, 30min)', () => {
    cacheSet('mystery', 'k', { v: 1 })
    expect(cacheGet('mystery', 'k')?.data).toEqual({ v: 1 })
    expect(localStorage.getItem('cb:cache:mystery:k')).toBeTruthy()
    cacheClear('mystery')
  })

  it('swallows malformed localStorage JSON', () => {
    localStorage.setItem('cb:cache:schema-details:bad', '{not json')
    expect(cacheGet('schema-details', 'bad')).toBeNull()
  })
})
