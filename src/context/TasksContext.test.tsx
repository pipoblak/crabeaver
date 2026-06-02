import { describe, it, expect, vi, afterEach } from 'vitest'
import { renderHook, render, act } from '@testing-library/react'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => undefined) }))

import { invoke } from '@tauri-apps/api/core'
import { TasksProvider, useTasks, useTaskActions, type Task } from './TasksContext'

const invokeMock = invoke as unknown as ReturnType<typeof vi.fn>

function wrapper({ children }: { children: React.ReactNode }) {
  return <TasksProvider>{children}</TasksProvider>
}

// Combined view for the behavioural tests (tasks live in one context, actions in another).
const useBoth = () => ({ ...useTasks(), ...useTaskActions() })

const base: Omit<Task, 'startedAt'> = { id: 'query:r1', kind: 'query', label: 'Result 1', cancellable: true, connectionId: 'c1' }

afterEach(() => invokeMock.mockClear())

describe('TasksContext', () => {
  it('startTask adds a task with a startedAt stamp', () => {
    const { result } = renderHook(useBoth, { wrapper })
    act(() => result.current.startTask(base))
    expect(result.current.tasks).toHaveLength(1)
    expect(result.current.tasks[0].id).toBe('query:r1')
    expect(typeof result.current.tasks[0].startedAt).toBe('number')
  })

  it('startTask with an existing id overwrites instead of duplicating', () => {
    const { result } = renderHook(useBoth, { wrapper })
    act(() => result.current.startTask(base))
    act(() => result.current.startTask({ ...base, label: 'Result 1 (rerun)' }))
    expect(result.current.tasks).toHaveLength(1)
    expect(result.current.tasks[0].label).toBe('Result 1 (rerun)')
  })

  it('endTask removes by id and is a no-op for unknown ids', () => {
    const { result } = renderHook(useBoth, { wrapper })
    act(() => result.current.startTask(base))
    act(() => result.current.endTask('nope'))
    expect(result.current.tasks).toHaveLength(1)
    act(() => result.current.endTask('query:r1'))
    expect(result.current.tasks).toHaveLength(0)
  })

  it('cancelTask invokes cancel_query with the task connectionId and leaves the task', () => {
    const { result } = renderHook(useBoth, { wrapper })
    act(() => result.current.startTask(base))
    act(() => result.current.cancelTask('query:r1'))
    expect(invokeMock).toHaveBeenCalledWith('cancel_query', { connectionId: 'c1' })
    expect(result.current.tasks).toHaveLength(1) // owner's endTask removes it later
  })

  it('cancelTask is a no-op for a task without a connectionId', () => {
    const { result } = renderHook(useBoth, { wrapper })
    act(() => result.current.startTask({ id: 'schema:c1:', kind: 'schema', label: 'Schema', background: true }))
    act(() => result.current.cancelTask('schema:c1:'))
    // Mount reads the dock setting, so assert specifically that no cancel fired.
    expect(invokeMock).not.toHaveBeenCalledWith('cancel_query', expect.anything())
  })

  // The whole point of splitting the context: action-only consumers (query
  // runners, schema fetch, heartbeat) must NOT re-render when the task list churns.
  it('does not re-render action-only consumers when the task list changes', () => {
    let actionRenders = 0
    let stateRenders = 0
    let start: (t: Omit<Task, 'startedAt'>) => void = () => {}

    function ActionsOnly() {
      actionRenders++
      start = useTaskActions().startTask
      return null
    }
    function StateConsumer() {
      stateRenders++
      void useTasks().tasks.length
      return null
    }

    render(<TasksProvider><ActionsOnly /><StateConsumer /></TasksProvider>)

    const actionsBefore = actionRenders
    const stateBefore = stateRenders
    act(() => start(base))

    expect(actionRenders).toBe(actionsBefore)            // action-only consumer did NOT re-render
    expect(stateRenders).toBeGreaterThan(stateBefore)    // state consumer DID re-render
  })
})
