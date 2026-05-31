import { describe, it, expect } from 'vitest'
import {
  quoteIdent, qualifiedRef, escapeLiteral, buildFilterPredicate,
  applyLimit, buildTableQuery,
} from './queryBuilder'

describe('quoteIdent', () => {
  it('double-quotes and escapes embedded quotes (injection inert)', () => {
    expect(quoteIdent('users')).toBe('"users"')
    expect(quoteIdent('a"; DROP TABLE t; --')).toBe('"a""; DROP TABLE t; --"')
  })
})

describe('qualifiedRef', () => {
  it('quotes both schema and table', () => {
    expect(qualifiedRef('public', 'users')).toBe('"public"."users"')
  })
})

describe('escapeLiteral', () => {
  it('doubles single quotes', () => {
    expect(escapeLiteral("O'Brien")).toBe("O''Brien")
  })
})

describe('buildFilterPredicate', () => {
  it('postgres uses ::text and ILIKE for contains', () => {
    expect(buildFilterPredicate({ col: 'name', value: 'al', op: '~' }, 'postgres'))
      .toBe(`"name"::text ILIKE '%al%'`)
    expect(buildFilterPredicate({ col: 'age', value: '30', op: '>' }, 'postgres'))
      .toBe(`"age"::text > '30'`)
  })
  it('sqlite uses CAST(... AS TEXT) and LIKE', () => {
    expect(buildFilterPredicate({ col: 'name', value: 'al', op: '~' }, 'sqlite'))
      .toBe(`CAST("name" AS TEXT) LIKE '%al%'`)
  })
})

describe('applyLimit', () => {
  it('appends LIMIT to a SELECT without one', () => {
    expect(applyLimit('SELECT * FROM t', 200)).toBe('SELECT * FROM t\nLIMIT 200')
  })
  it('leaves an existing top-level LIMIT alone', () => {
    expect(applyLimit('SELECT * FROM t LIMIT 5', 200)).toBe('SELECT * FROM t LIMIT 5')
  })
  it('does not touch non-SELECT statements', () => {
    expect(applyLimit('UPDATE t SET x=1', 200)).toBe('UPDATE t SET x=1')
  })
})

describe('buildTableQuery', () => {
  it('builds a plain select with limit', () => {
    expect(buildTableQuery({ schema: 'public', table: 'users', limit: 200 }))
      .toBe('SELECT * FROM "public"."users"\nLIMIT 200')
  })
  it('adds WHERE, ORDER BY, LIMIT and OFFSET', () => {
    expect(buildTableQuery({
      schema: 'public', table: 'users',
      filters: [{ col: 'name', value: 'al', op: '~' }],
      sort: { col: 'id', dir: 'desc' }, limit: 200, offset: 200, dialect: 'postgres',
    })).toBe(
      'SELECT * FROM "public"."users"' +
      `\nWHERE "name"::text ILIKE '%al%'` +
      '\nORDER BY "id" DESC' +
      '\nLIMIT 200 OFFSET 200',
    )
  })
  it('ignores blank filters', () => {
    expect(buildTableQuery({
      schema: 'public', table: 'users',
      filters: [{ col: 'name', value: '   ', op: '~' }], limit: 200,
    })).toBe('SELECT * FROM "public"."users"\nLIMIT 200')
  })
})
