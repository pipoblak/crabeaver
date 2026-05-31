import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))
import { invoke } from '@tauri-apps/api/core'
import { useTableData } from './useTableData'

const rows = (n: number) => Array.from({ length: n }, (_, i) => [i, `r${i}`])
const result = (n: number) => ({
  columns: [{ name: 'id', typeName: 'int' }, { name: 'name', typeName: 'text' }],
  rows: rows(n), executionMs: 1,
})

beforeEach(() => { vi.mocked(invoke).mockReset() })

describe('useTableData', () => {
  it('load() fetches rows and sets offset/hasMore', async () => {
    vi.mocked(invoke).mockResolvedValueOnce(result(200))
    const { result: h } = renderHook(() => useTableData('c1', 'public', 'users', 'postgres', 200))
    await act(async () => { await h.current.load() })
    expect(h.current.state.data?.rows.length).toBe(200)
    expect(h.current.state.offset).toBe(200)
    expect(h.current.state.hasMore).toBe(true)
    const sql = vi.mocked(invoke).mock.calls[0][1] as { sql: string }
    expect(sql.sql).toContain('SELECT * FROM "public"."users"')
  })

  it('loadMore() appends rows and advances offset', async () => {
    vi.mocked(invoke).mockResolvedValueOnce(result(200)).mockResolvedValueOnce(result(50))
    const { result: h } = renderHook(() => useTableData('c1', 'public', 'users', 'postgres', 200))
    await act(async () => { await h.current.load() })
    await act(async () => { await h.current.loadMore() })
    expect(h.current.state.data?.rows.length).toBe(250)
    expect(h.current.state.offset).toBe(250)
    expect(h.current.state.hasMore).toBe(false)
  })

  it('fkClick() pushes history and switches table; back() restores', async () => {
    vi.mocked(invoke).mockResolvedValue(result(1))
    const { result: h } = renderHook(() => useTableData('c1', 'public', 'users', 'postgres', 200))
    await act(async () => { await h.current.load() })
    await act(async () => { await h.current.fkClick('public.orders', 'user_id', '7') })
    expect(h.current.state.table).toBe('orders')
    expect(h.current.state.history.length).toBe(1)
    const fkSql = vi.mocked(invoke).mock.calls.at(-1)![1] as { sql: string }
    expect(fkSql.sql).toContain('"public"."orders"')
    expect(fkSql.sql).toContain(`"user_id"::text = '7'`)
    act(() => { h.current.back() })
    expect(h.current.state.table).toBe('users')
    expect(h.current.state.history.length).toBe(0)
  })

  it('load() surfaces an error string on failure', async () => {
    vi.mocked(invoke).mockRejectedValueOnce('pool timed out')
    const { result: h } = renderHook(() => useTableData('c1', 'public', 'users', 'postgres', 200))
    await act(async () => { await h.current.load() })
    expect(h.current.state.error).toContain('pool timed out')
  })
})
