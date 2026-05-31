import { describe, it, expect } from 'vitest'
import { timeAgo } from './timeAgo'

describe('timeAgo', () => {
  const now = 1_000_000_000_000

  it('says "just now" under 5s', () => {
    expect(timeAgo(now - 2_000, now)).toBe('just now')
    expect(timeAgo(now, now)).toBe('just now')
  })

  it('reports seconds', () => {
    expect(timeAgo(now - 30_000, now)).toBe('30s ago')
  })

  it('reports minutes', () => {
    expect(timeAgo(now - 5 * 60_000, now)).toBe('5m ago')
  })

  it('reports hours', () => {
    expect(timeAgo(now - 3 * 3_600_000, now)).toBe('3h ago')
  })

  it('falls back to a date past a day', () => {
    const out = timeAgo(now - 2 * 86_400_000, now)
    expect(out).toBe(new Date(now - 2 * 86_400_000).toLocaleDateString())
  })
})
