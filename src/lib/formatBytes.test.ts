import { describe, it, expect } from 'vitest'
import { formatBytes } from './formatBytes'

describe('formatBytes', () => {
  it('handles zero / negative / non-finite', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(-5)).toBe('0 B')
    expect(formatBytes(NaN)).toBe('0 B')
  })

  it('shows bytes and KB without decimals', () => {
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(2048)).toBe('2 KB')
  })

  it('shows MB and up with one decimal', () => {
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB')
    expect(formatBytes(Math.round(1.5 * 1024 * 1024 * 1024))).toBe('1.5 GB')
    expect(formatBytes(3 * 1024 ** 4)).toBe('3.0 TB')
  })

  it('rolls up to the largest fitting unit', () => {
    expect(formatBytes(1024 ** 5)).toBe('1.0 PB')
  })
})
