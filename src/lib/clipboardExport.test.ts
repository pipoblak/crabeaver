import { describe, it, expect } from 'vitest'
import { toCSV, toText, toJSON, formatResult, exportFilename } from './clipboardExport'
import type { QueryResult } from './results'

const r: QueryResult = {
  columns: [{ name: 'id', typeName: 'int' }, { name: 'name', typeName: 'text' }, { name: 'meta', typeName: 'json' }],
  rows: [
    [1, 'Alice', { a: 1 }],
    [2, 'Bob, Jr. "the kid"', null],
    [3, 'line\nbreak', undefined],
  ],
  executionMs: 1,
}

describe('clipboardExport', () => {
  it('toCSV quotes commas, quotes, and newlines; null/undefined → empty', () => {
    const csv = toCSV(r)
    const lines = csv.split('\n')
    expect(lines[0]).toBe('id,name,meta')
    expect(lines[1]).toBe('1,Alice,"{""a"":1}"')
    // Comma + embedded quotes both force quoting; quotes are doubled.
    expect(csv).toContain('"Bob, Jr. ""the kid"""')
    // A newline inside a value keeps it quoted (so it spans physical lines).
    expect(csv).toContain('"line\nbreak"')
    // null and undefined render as empty fields.
    expect(csv).toContain(',\n3,') // row 2 trailing empty meta, then row 3 starts
  })

  it('toText is tab-separated and flattens newlines/tabs to spaces', () => {
    const t = toText(r)
    const lines = t.split('\n')
    expect(lines[0]).toBe('id\tname\tmeta')
    expect(lines[1]).toBe('1\tAlice\t{"a":1}')
    // The embedded newline is flattened, so this row stays on one physical line.
    expect(lines[3]).toBe('3\tline break\t')
  })

  it('toJSON preserves raw values; undefined → null', () => {
    const parsed = JSON.parse(toJSON(r))
    expect(parsed).toEqual([
      { id: 1, name: 'Alice', meta: { a: 1 } },
      { id: 2, name: 'Bob, Jr. "the kid"', meta: null },
      { id: 3, name: 'line\nbreak', meta: null },
    ])
  })

  it('header-only when there are no rows', () => {
    const empty: QueryResult = { columns: r.columns, rows: [], executionMs: 0 }
    expect(toCSV(empty)).toBe('id,name,meta')
    expect(toText(empty)).toBe('id\tname\tmeta')
    expect(JSON.parse(toJSON(empty))).toEqual([])
  })

  it('formatResult dispatches by format', () => {
    expect(formatResult(r, 'csv')).toBe(toCSV(r))
    expect(formatResult(r, 'json')).toBe(toJSON(r))
    expect(formatResult(r, 'text')).toBe(toText(r))
  })

  it('exportFilename sanitizes the title and stamps a timestamp + extension', () => {
    const at = new Date('2026-06-01T13:08:07Z')
    expect(exportFilename('user verified wallets', 'csv', at)).toBe('user_verified_wallets_20260601130807.csv')
    expect(exportFilename('public.orders', 'json', at)).toBe('public.orders_20260601130807.json')
    expect(exportFilename('weird/\\:*name', 'text', at)).toBe('weird_name_20260601130807.txt')
    expect(exportFilename('', 'csv', at)).toBe('result_20260601130807.csv')
  })
})
