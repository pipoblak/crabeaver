import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'

// Mock the Tauri bridge before importing the context (vi.mock is hoisted).
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))

import { invoke } from '@tauri-apps/api/core'
import { TabsProvider, useTabs } from './TabsContext'

const invokeMock = invoke as unknown as ReturnType<typeof vi.fn>

const DIR = '/queries'
const A = `${DIR}/Work/A.sql`
const B = `${DIR}/Work/B.sql`

// Backing store for the mocked settings/files.
let settings: Record<string, string | null>
let files: Record<string, string>

beforeEach(() => {
  settings = {
    open_query_tabs: JSON.stringify([A, B]),
    active_query_path: B,
    tab_query_connections: '{}',
    open_special_tabs: null,
  }
  files = { [A]: 'select 1', [B]: 'select 2' }

  invokeMock.mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
    switch (cmd) {
      case 'get_setting':    return settings[args!.key as string] ?? null
      case 'set_setting':    settings[args!.key as string] = args!.value as string; return undefined
      case 'read_query_file': {
        const p = args!.path as string
        if (!(p in files)) throw new Error('not found')
        return files[p]
      }
      case 'list_workspaces': return [{ name: 'Work', queries: [{ name: 'A', path: A }, { name: 'B', path: B }] }]
      case 'create_query':   return `${DIR}/${args!.workspace}/${args!.name}.sql`
      default:               return undefined
    }
  })
})

function wrapper({ children }: { children: React.ReactNode }) {
  return <TabsProvider>{children}</TabsProvider>
}

describe('TabsContext session restore', () => {
  it('restores exactly the tabs listed in open_query_tabs, active from active_query_path', async () => {
    const { result } = renderHook(() => useTabs(), { wrapper })
    await waitFor(() => expect(result.current.restored).toBe(true))

    expect(result.current.tabs.map(t => t.title)).toEqual(['A', 'B'])
    expect(result.current.tabs.map(t => t.workspace)).toEqual(['Work', 'Work'])
    const active = result.current.tabs.find(t => t.id === result.current.activeId)
    expect(active?.filePath).toBe(B)
  })

  it('openQueryByPath focuses an already-open tab instead of duplicating it', async () => {
    const { result } = renderHook(() => useTabs(), { wrapper })
    await waitFor(() => expect(result.current.restored).toBe(true))

    const before = result.current.tabs.length
    await act(async () => { await result.current.openQueryByPath(A) })

    expect(result.current.tabs.length).toBe(before) // no new tab
    const active = result.current.tabs.find(t => t.id === result.current.activeId)
    expect(active?.filePath).toBe(A)
  })

  it('openQueryByPath opens a new tab for a not-yet-open query', async () => {
    const C = `${DIR}/Work/C.sql`
    files[C] = 'select 3'
    const { result } = renderHook(() => useTabs(), { wrapper })
    await waitFor(() => expect(result.current.restored).toBe(true))

    const before = result.current.tabs.length
    await act(async () => { await result.current.openQueryByPath(C) })

    expect(result.current.tabs.length).toBe(before + 1)
    const active = result.current.tabs.find(t => t.id === result.current.activeId)
    expect(active?.filePath).toBe(C)
    expect(active?.title).toBe('C')
  })
})
