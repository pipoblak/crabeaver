import { describe, it, expect } from 'vitest'
import { splitSqlStatements } from './splitSql'

describe('splitSqlStatements', () => {
  it('splits two statements', () => {
    expect(splitSqlStatements('select 1; select 2')).toEqual(['select 1', 'select 2'])
  })

  it('drops the empty tail from a trailing semicolon', () => {
    expect(splitSqlStatements('select 1;')).toEqual(['select 1'])
  })

  it('ignores a semicolon inside a single-quoted string', () => {
    expect(splitSqlStatements("select 'a;b'")).toEqual(["select 'a;b'"])
  })

  it('ignores a semicolon inside a double-quoted identifier', () => {
    expect(splitSqlStatements('select "a;b"')).toEqual(['select "a;b"'])
  })

  it('handles a doubled-quote escape inside a string', () => {
    expect(splitSqlStatements("select 'a''; b'; select 2")).toEqual(["select 'a''; b'", 'select 2'])
  })

  it('ignores a semicolon inside a line comment', () => {
    expect(splitSqlStatements('select 1 -- ;\n ; select 2')).toEqual(['select 1 -- ;', 'select 2'])
  })

  it('ignores a semicolon inside a block comment', () => {
    expect(splitSqlStatements('select 1 /* ; */ ; select 2')).toEqual(['select 1 /* ; */', 'select 2'])
  })

  it('drops whitespace-only segments', () => {
    expect(splitSqlStatements('; ; select 1;')).toEqual(['select 1'])
  })

  it('returns a single statement unchanged when there is no semicolon', () => {
    expect(splitSqlStatements('select * from t')).toEqual(['select * from t'])
  })

  it('returns an empty array for empty / whitespace input', () => {
    expect(splitSqlStatements('   \n  ')).toEqual([])
    expect(splitSqlStatements('')).toEqual([])
  })
})
