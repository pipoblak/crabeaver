import { describe, it, expect } from 'vitest'
import { resolveIdentifier, type ResolverCache } from './resolveIdentifier'

const cache: ResolverCache = {
  schemas: ['public', 'sales'],
  tables: [
    { schema: 'public', name: 'users' },
    { schema: 'sales', name: 'orders' },
    { schema: 'public', name: 'orders' }, // same table name in two schemas
  ],
}

describe('resolveIdentifier', () => {
  it('resolves a qualified schema.table to that table', () => {
    expect(resolveIdentifier('orders', 'SELECT * FROM sales.', cache))
      .toEqual({ kind: 'table', schema: 'sales', table: 'orders' })
  })

  it('resolves a bare schema name to a schema target', () => {
    expect(resolveIdentifier('public', 'SELECT * FROM ', cache))
      .toEqual({ kind: 'schema', schema: 'public' })
  })

  it('resolves a uniquely-named bare table', () => {
    expect(resolveIdentifier('users', 'SELECT * FROM ', cache))
      .toEqual({ kind: 'table', schema: 'public', table: 'users' })
  })

  it('falls back to the first match for an ambiguous bare table', () => {
    // 'orders' exists in both schemas; resolver picks the first in cache order
    // (sales precedes public here) — deterministic, no picker.
    expect(resolveIdentifier('orders', 'SELECT * FROM ', cache))
      .toEqual({ kind: 'table', schema: 'sales', table: 'orders' })
  })

  it('strips surrounding double quotes', () => {
    expect(resolveIdentifier('"users"', 'SELECT * FROM ', cache))
      .toEqual({ kind: 'table', schema: 'public', table: 'users' })
  })

  it('returns null for an unknown identifier', () => {
    expect(resolveIdentifier('nope', 'SELECT * FROM ', cache)).toBeNull()
  })
})
