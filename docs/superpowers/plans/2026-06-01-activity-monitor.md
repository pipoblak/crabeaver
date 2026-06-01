# Activity Monitor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a global activity monitor to the footer that shows running/pending DB tasks (queries, pagination, schema fetches, connection heartbeat/revalidation) and lets the user cancel a running query.

**Architecture:** A new `TasksContext` holds an in-memory registry of active tasks. It sits outside `ConnectionProvider` so the connection heartbeat can register into it. Each async DB operation calls `startTask`/`endTask` around its work. A footer component `ActivityMonitor` (rendered in `StatusBar`) reads the registry, shows a spinner + count, and opens a popover listing tasks with a cancel button for queries.

**Tech Stack:** React + TypeScript, React Context, Vitest + @testing-library/react, lucide-react icons, Tauri `invoke`.

**Spec:** `docs/superpowers/specs/2026-06-01-activity-monitor-design.md`

---

## File Structure

New:
- `src/context/TasksContext.tsx` — the registry: `Task` type, provider, `useTasks` hook, `startTask`/`endTask`/`cancelTask`.
- `src/context/TasksContext.test.tsx` — unit tests for the registry.
- `src/components/ActivityMonitor.tsx` — footer indicator + popover.

Modified:
- `src/main.tsx` — wrap app in `TasksProvider` (outside `ConnectionProvider`).
- `src/components/StatusBar.tsx` — render `ActivityMonitor`; drop the standalone "Revalidating…" block.
- `src/components/EditorTabs.tsx` — register `query` + `load-more` tasks.
- `src/components/SqlEditor.tsx` — register `schema` tasks at the `fetchSchema` call sites.
- `src/context/ConnectionContext.tsx` — register `connection` tasks for heartbeat + revalidation.

---

## Task 1: TasksContext registry

**Files:**
- Create: `src/context/TasksContext.tsx`
- Test: `src/context/TasksContext.test.tsx`

- [ ] **Step 1: Write the context module**

Create `src/context/TasksContext.tsx`:

```tsx
import { createContext, useContext, useState, useCallback, useRef } from 'react'
import { invoke } from '@tauri-apps/api/core'

export type TaskKind = 'query' | 'load-more' | 'schema' | 'connection'

export interface Task {
  id: string             // caller-stable, e.g. `query:${resultTabId}`
  kind: TaskKind
  label: string          // tab title / "Schema · mydb" / "Heartbeat"
  detail?: string        // SQL preview for queries
  connectionId?: string  // present when the task can be cancelled
  cancellable?: boolean  // true only for `query`
  background?: boolean    // schema / connection → subdued, not counted in the badge
  startedAt: number      // Date.now() at registration, for the live elapsed timer
}

interface TasksContextValue {
  tasks: Task[]
  startTask: (task: Omit<Task, 'startedAt'>) => void
  endTask: (id: string) => void
  cancelTask: (id: string) => void
}

// No-op default (matches ConnectionContext): useTasks() outside a provider is a
// harmless no-op, so consumers/tests that don't wrap with TasksProvider still work.
const TasksContext = createContext<TasksContextValue>({
  tasks: [],
  startTask: () => {},
  endTask: () => {},
  cancelTask: () => {},
})

export function TasksProvider({ children }: { children: React.ReactNode }) {
  const [tasks, setTasks] = useState<Task[]>([])
  // Mirror of `tasks` so cancelTask (stable, no deps) can read the latest list.
  const tasksRef = useRef<Task[]>([])
  tasksRef.current = tasks

  const startTask = useCallback((task: Omit<Task, 'startedAt'>) => {
    const entry: Task = { ...task, startedAt: Date.now() }
    // Overwrite any existing task with the same id (a re-run reuses its id).
    setTasks(prev => [...prev.filter(t => t.id !== entry.id), entry])
  }, [])

  const endTask = useCallback((id: string) => {
    setTasks(prev => prev.filter(t => t.id !== id))
  }, [])

  const cancelTask = useCallback((id: string) => {
    const task = tasksRef.current.find(t => t.id === id)
    if (!task?.connectionId) return
    // Best-effort: the query's own error path removes the task via endTask.
    invoke('cancel_query', { connectionId: task.connectionId }).catch(() => {})
  }, [])

  return (
    <TasksContext.Provider value={{ tasks, startTask, endTask, cancelTask }}>
      {children}
    </TasksContext.Provider>
  )
}

export const useTasks = () => useContext(TasksContext)
```

- [ ] **Step 2: Write the failing tests**

Create `src/context/TasksContext.test.tsx`:

```tsx
import { describe, it, expect, vi, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => undefined) }))

import { invoke } from '@tauri-apps/api/core'
import { TasksProvider, useTasks, type Task } from './TasksContext'

const invokeMock = invoke as unknown as ReturnType<typeof vi.fn>

function wrapper({ children }: { children: React.ReactNode }) {
  return <TasksProvider>{children}</TasksProvider>
}

const base: Omit<Task, 'startedAt'> = { id: 'query:r1', kind: 'query', label: 'Result 1', cancellable: true, connectionId: 'c1' }

afterEach(() => invokeMock.mockClear())

describe('TasksContext', () => {
  it('startTask adds a task with a startedAt stamp', () => {
    const { result } = renderHook(() => useTasks(), { wrapper })
    act(() => result.current.startTask(base))
    expect(result.current.tasks).toHaveLength(1)
    expect(result.current.tasks[0].id).toBe('query:r1')
    expect(typeof result.current.tasks[0].startedAt).toBe('number')
  })

  it('startTask with an existing id overwrites instead of duplicating', () => {
    const { result } = renderHook(() => useTasks(), { wrapper })
    act(() => result.current.startTask(base))
    act(() => result.current.startTask({ ...base, label: 'Result 1 (rerun)' }))
    expect(result.current.tasks).toHaveLength(1)
    expect(result.current.tasks[0].label).toBe('Result 1 (rerun)')
  })

  it('endTask removes by id and is a no-op for unknown ids', () => {
    const { result } = renderHook(() => useTasks(), { wrapper })
    act(() => result.current.startTask(base))
    act(() => result.current.endTask('nope'))
    expect(result.current.tasks).toHaveLength(1)
    act(() => result.current.endTask('query:r1'))
    expect(result.current.tasks).toHaveLength(0)
  })

  it('cancelTask invokes cancel_query with the task connectionId and leaves the task', () => {
    const { result } = renderHook(() => useTasks(), { wrapper })
    act(() => result.current.startTask(base))
    act(() => result.current.cancelTask('query:r1'))
    expect(invokeMock).toHaveBeenCalledWith('cancel_query', { connectionId: 'c1' })
    expect(result.current.tasks).toHaveLength(1) // owner's endTask removes it later
  })

  it('cancelTask is a no-op for a task without a connectionId', () => {
    const { result } = renderHook(() => useTasks(), { wrapper })
    act(() => result.current.startTask({ id: 'schema:c1:', kind: 'schema', label: 'Schema', background: true }))
    act(() => result.current.cancelTask('schema:c1:'))
    expect(invokeMock).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 3: Run the tests**

Run: `npx vitest run src/context/TasksContext.test.tsx`
Expected: PASS (5 tests).

- [ ] **Step 4: Typecheck**

Run: `npx tsc -b`
Expected: no output (clean).

- [ ] **Step 5: Commit**

```bash
git add src/context/TasksContext.tsx src/context/TasksContext.test.tsx
git commit -m "feat: TasksContext registry for the activity monitor"
```

---

## Task 2: Wire TasksProvider into the app

**Files:**
- Modify: `src/main.tsx`

- [ ] **Step 1: Add the provider**

In `src/main.tsx`, add the import after the `ConnectionProvider` import (line 12):

```tsx
import { TasksProvider } from '@/context/TasksContext'
```

Replace the provider tree (lines 16-22) so `TasksProvider` wraps `ConnectionProvider`:

```tsx
    <ThemeProvider>
      <ValidationProvider>
        <TasksProvider>
          <ConnectionProvider>
            <App />
          </ConnectionProvider>
        </TasksProvider>
      </ValidationProvider>
    </ThemeProvider>
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc -b`
Expected: no output (clean).

- [ ] **Step 3: Commit**

```bash
git add src/main.tsx
git commit -m "feat: mount TasksProvider above ConnectionProvider"
```

---

## Task 3: ActivityMonitor footer component

**Files:**
- Create: `src/components/ActivityMonitor.tsx`

- [ ] **Step 1: Write the component**

Create `src/components/ActivityMonitor.tsx`:

```tsx
import { useState, useRef, useEffect } from 'react'
import { Activity, Loader2, X, Database, ChevronsDown, RefreshCw } from 'lucide-react'
import { useTasks, type Task, type TaskKind } from '@/context/TasksContext'

const KIND_ICON: Record<TaskKind, typeof Database> = {
  'query':      Database,
  'load-more':  ChevronsDown,
  'schema':     RefreshCw,
  'connection': Activity,
}

export default function ActivityMonitor() {
  const { tasks, cancelTask } = useTasks()
  const [open, setOpen] = useState(false)
  const [, setTick] = useState(0)
  const ref = useRef<HTMLDivElement>(null)

  const foreground = tasks.filter(t => !t.background)
  const background = tasks.filter(t => t.background)
  const busy = tasks.length > 0

  // Live elapsed timer — only ticks while something is running.
  useEffect(() => {
    if (!busy) return
    const id = setInterval(() => setTick(n => n + 1), 250)
    return () => clearInterval(id)
  }, [busy])

  // Close the popover on outside click.
  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  const elapsed = (t: Task) => `${((Date.now() - t.startedAt) / 1000).toFixed(1)}s`

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen(v => !v)}
        title="Activity"
        className="flex items-center gap-1 transition-opacity hover:opacity-75"
        style={{ color: foreground.length ? '#fff' : 'rgba(255,255,255,0.55)' }}
      >
        {busy
          ? <Loader2 size={11} className="animate-spin" />
          : <Activity size={11} />}
        {foreground.length > 0 && <span>{foreground.length}</span>}
      </button>

      {open && (
        <div
          className="absolute bottom-full mb-1 right-0 rounded shadow-xl z-50 min-w-[260px] max-w-[360px]"
          style={{ background: 'var(--sidebar-bg)', border: '1px solid var(--border)' }}
        >
          <div className="px-3 py-1.5 text-[10px] font-semibold tracking-widest uppercase"
            style={{ color: 'var(--text-dim)', borderBottom: '1px solid var(--border)' }}>
            Activity
          </div>

          {tasks.length === 0 && (
            <div className="px-3 py-2 text-[12px]" style={{ color: 'var(--text-dim)' }}>
              No active tasks
            </div>
          )}

          {foreground.map(t => {
            const Icon = KIND_ICON[t.kind]
            return (
              <div key={t.id} className="flex items-start gap-2 px-3 py-1.5"
                style={{ borderBottom: '1px solid var(--border)' }}>
                <Icon size={12} className="shrink-0 mt-0.5" style={{ color: 'var(--tab-accent)' }} />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-[12px] truncate" style={{ color: 'var(--text-bright)' }}>{t.label}</span>
                    <span className="text-[10px] font-mono shrink-0" style={{ color: 'var(--text-dim)' }}>{elapsed(t)}</span>
                  </div>
                  {t.detail && (
                    <div className="text-[10px] font-mono truncate" style={{ color: 'var(--text-dim)' }}>{t.detail}</div>
                  )}
                </div>
                {t.cancellable && (
                  <button title="Cancel" onClick={() => cancelTask(t.id)}
                    className="shrink-0 mt-0.5 hover:opacity-75" style={{ color: 'var(--error-text, #f87171)' }}>
                    <X size={12} />
                  </button>
                )}
              </div>
            )
          })}

          {background.length > 0 && (
            <div className="px-3 py-1.5" style={{ opacity: 0.6 }}>
              {background.map(t => {
                const Icon = KIND_ICON[t.kind]
                return (
                  <div key={t.id} className="flex items-center gap-2 py-0.5">
                    <Icon size={11} className="shrink-0" style={{ color: 'var(--text-dim)' }} />
                    <span className="text-[11px] truncate flex-1" style={{ color: 'var(--text-dim)' }}>{t.label}</span>
                    <span className="text-[10px] font-mono shrink-0" style={{ color: 'var(--text-dim)' }}>{elapsed(t)}</span>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc -b`
Expected: no output (clean). (Component is not rendered yet — Task 4 mounts it.)

- [ ] **Step 3: Commit**

```bash
git add src/components/ActivityMonitor.tsx
git commit -m "feat: ActivityMonitor footer indicator + popover"
```

---

## Task 4: Render ActivityMonitor in the status bar

**Files:**
- Modify: `src/components/StatusBar.tsx`

- [ ] **Step 1: Import the component**

In `src/components/StatusBar.tsx`, add after the existing component imports (after line 5, the `useConnections` import):

```tsx
import ActivityMonitor from '@/components/ActivityMonitor'
```

- [ ] **Step 2: Stop consuming `revalidating`**

Change the destructure on line 10 from:

```tsx
  const { connections, connected, connect, revalidating } = useConnections()
```

to:

```tsx
  const { connections, connected, connect } = useConnections()
```

- [ ] **Step 3: Replace the Revalidating block with the monitor**

Replace the revalidating block (lines 48-54):

```tsx
        {/* Revalidating indicator */}
        {revalidating && (
          <div className="flex items-center gap-1 opacity-70">
            <Loader2 size={10} className="animate-spin" />
            <span>Revalidating…</span>
          </div>
        )}
```

with:

```tsx
        <ActivityMonitor />
```

- [ ] **Step 4: Drop the now-unused `Loader2` import**

The `Loader2` import on line 2 is no longer used in `StatusBar.tsx` (the only use was the revalidating block; `LintStatus` uses it too — verify). Check usage:

Run: `grep -n "Loader2" src/components/StatusBar.tsx`
Expected: `Loader2` still appears inside `LintStatus` (the "Linting…" spinner). If it still appears, **leave the import**. If it does not, remove `Loader2` from the import on line 2.

- [ ] **Step 5: Typecheck**

Run: `npx tsc -b`
Expected: no output (clean).

- [ ] **Step 6: Run existing tests**

Run: `npx vitest run`
Expected: PASS (no regressions).

- [ ] **Step 7: Commit**

```bash
git add src/components/StatusBar.tsx
git commit -m "feat: show ActivityMonitor in the status bar"
```

---

## Task 5: Register query and load-more tasks

**Files:**
- Modify: `src/components/EditorTabs.tsx`

- [ ] **Step 1: Import and consume useTasks**

In `src/components/EditorTabs.tsx`, add the import near the other context imports:

```tsx
import { useTasks } from '@/context/TasksContext'
```

Inside the component body (near the other hook calls, e.g. just after the existing `const ... = useTabs()` / context hooks), add:

```tsx
  const { startTask, endTask } = useTasks()
```

- [ ] **Step 2: Register the query task**

In `runQuery`, immediately after the `setResultMap` block that marks the tab running (after the block ending at line 217, before `try {` on line 219), add:

```tsx
    startTask({
      id: `query:${resultTabId}`,
      kind: 'query',
      label: tab.title,
      detail: rawSql.replace(/\s+/g, ' ').trim().slice(0, 120),
      connectionId: tab.connectionId,
      cancellable: true,
    })
```

(`tab.title` is the editor tab's display name — confirmed on the `Tab` type in `src/context/TabsContext.tsx`.)

In the success branch, after the `setResultMap` that sets `running: false` (after line 235, inside `try`), add:

```tsx
      endTask(`query:${resultTabId}`)
```

In the `catch (e)` branch, after its `setResultMap` (after line 248), add:

```tsx
      endTask(`query:${resultTabId}`)
```

Add `startTask` and `endTask` to the `runQuery` `useCallback` deps array (currently `[activeId, tabs, resultMap, ensureResultTab, persistResults]` on line 250):

```tsx
  }, [activeId, tabs, resultMap, ensureResultTab, persistResults, startTask, endTask])
```

- [ ] **Step 3: Register the load-more task**

In `handleLoadMore`, after the `setResultMap` block that sets `loadingMore: true` (after the block ending at line 301, before `try {` on line 303), add:

```tsx
    startTask({
      id: `load-more:${resultTabId}`,
      kind: 'load-more',
      label: `${editorTab.title} · more`,
      connectionId: editorTab.connectionId,
    })
```

In the success branch, after its `setResultMap` (after line 319), add:

```tsx
      endTask(`load-more:${resultTabId}`)
```

In the `catch` branch, after its `setResultMap` (after line 328), add:

```tsx
      endTask(`load-more:${resultTabId}`)
```

Add `startTask` and `endTask` to the `handleLoadMore` deps array (currently `[tabs, resultMap, persistResults]` on line 330):

```tsx
  }, [tabs, resultMap, persistResults, startTask, endTask])
```

- [ ] **Step 4: Typecheck**

Run: `npx tsc -b`
Expected: no output (clean).

- [ ] **Step 5: Run tests**

Run: `npx vitest run`
Expected: PASS (no regressions).

- [ ] **Step 6: Commit**

```bash
git add src/components/EditorTabs.tsx
git commit -m "feat: register query + load-more tasks in the activity monitor"
```

---

## Task 6: Register schema-fetch tasks

**Files:**
- Modify: `src/components/SqlEditor.tsx`

Context: `fetchSchema` is a module-level function (no hook access). The component already calls `useConnections()` (line 136). We wrap the three call sites with a local `trackedFetch` helper that uses `startTask`/`endTask`.

- [ ] **Step 1: Import and consume useTasks**

Add to the context imports near the top of `src/components/SqlEditor.tsx`:

```tsx
import { useTasks } from '@/context/TasksContext'
```

Inside the component, alongside `const { markConnected, connectEpoch } = useConnections()` (line 136), add:

```tsx
  const { startTask, endTask } = useTasks()
```

- [ ] **Step 2: Add a tracked-fetch helper inside the schema effect**

The schema-fetch effect starts around line 246 (the `useEffect` containing `apply`, `fail`, and the three `fetchSchema(...)` calls at lines 301, 308, 315). Inside that effect, after `const cacheKey = ...` is computed and before `refreshSchemaRef.current = ...`, add:

```tsx
    const trackedFetch = (cid: string, db?: string) => {
      const id = `schema:${cid}:${db ?? ''}`
      startTask({ id, kind: 'schema', label: `Schema · ${db ?? cid}`, background: true })
      return fetchSchema(cid, db).finally(() => endTask(id))
    }
```

- [ ] **Step 3: Route the three call sites through trackedFetch**

Replace each `fetchSchema(connectionId, database)` call inside this effect with `trackedFetch(connectionId, database)`:

- Line 301: `refreshSchemaRef.current = () => { trackedFetch(connectionId, database).then(apply).catch(fail) }`
- Line 308: `trackedFetch(connectionId, database).then(apply).catch(fail)`
- Line 315: `trackedFetch(connectionId, database).then(apply).catch(e => { ... })` (keep the existing `.catch` body)

Add `startTask` and `endTask` to this effect's dependency array (currently `[connectionId, database, connectionId ? connectEpoch(connectionId) : 0]`):

```tsx
  }, [connectionId, database, connectionId ? connectEpoch(connectionId) : 0, startTask, endTask])
```

- [ ] **Step 4: Typecheck**

Run: `npx tsc -b`
Expected: no output (clean).

- [ ] **Step 5: Run tests**

Run: `npx vitest run`
Expected: PASS (no regressions).

- [ ] **Step 6: Commit**

```bash
git add src/components/SqlEditor.tsx
git commit -m "feat: register schema-fetch tasks in the activity monitor"
```

---

## Task 7: Register heartbeat + revalidation tasks

**Files:**
- Modify: `src/context/ConnectionContext.tsx`

- [ ] **Step 1: Import and consume useTasks**

Add the import to `src/context/ConnectionContext.tsx`:

```tsx
import { useTasks } from '@/context/TasksContext'
```

Inside `ConnectionProvider`, after the `useState` declarations (after line 32), add:

```tsx
  const { startTask, endTask } = useTasks()
```

- [ ] **Step 2: Track the revalidation in `reload`**

Wrap the body of `reload` (lines 34-46). Replace:

```tsx
  const reload = useCallback(async () => {
    setRevalidating(true)
    try {
      const list = await invoke<Connection[]>('list_connections').catch(() => [])
      setConnections(list)
      const statuses = await Promise.all(
        list.map(c => invoke<boolean>('connection_status', { id: c.id }).catch(() => false))
      )
      setConnected(new Set(list.filter((_, i) => statuses[i]).map(c => c.id)))
    } finally {
      setRevalidating(false)
    }
  }, [])
```

with:

```tsx
  const reload = useCallback(async () => {
    setRevalidating(true)
    startTask({ id: 'revalidate', kind: 'connection', label: 'Checking connections', background: true })
    try {
      const list = await invoke<Connection[]>('list_connections').catch(() => [])
      setConnections(list)
      const statuses = await Promise.all(
        list.map(c => invoke<boolean>('connection_status', { id: c.id }).catch(() => false))
      )
      setConnected(new Set(list.filter((_, i) => statuses[i]).map(c => c.id)))
    } finally {
      setRevalidating(false)
      endTask('revalidate')
    }
  }, [startTask, endTask])
```

- [ ] **Step 3: Track the heartbeat in `beat`**

In the heartbeat effect, replace the `beat` function (lines 58-73):

```tsx
    const beat = async () => {
      if (document.hidden) return
      const ids = [...connectedRef.current]
      if (ids.length === 0) return
      const alive = await Promise.all(
        ids.map(id => invoke<boolean>('ping_connection', { id }).catch(() => false))
      )
      const dead = ids.filter((_, i) => !alive[i])
      if (dead.length) {
        setConnected(prev => {
          const s = new Set(prev)
          dead.forEach(id => s.delete(id))
          return s
        })
      }
    }
```

with:

```tsx
    const beat = async () => {
      if (document.hidden) return
      const ids = [...connectedRef.current]
      if (ids.length === 0) return
      startTask({ id: 'heartbeat', kind: 'connection', label: 'Heartbeat', background: true })
      try {
        const alive = await Promise.all(
          ids.map(id => invoke<boolean>('ping_connection', { id }).catch(() => false))
        )
        const dead = ids.filter((_, i) => !alive[i])
        if (dead.length) {
          setConnected(prev => {
            const s = new Set(prev)
            dead.forEach(id => s.delete(id))
            return s
          })
        }
      } finally {
        endTask('heartbeat')
      }
    }
```

The heartbeat effect currently has an empty dependency array (`[]` on line 82). Leave it `[]` — `startTask`/`endTask` are referentially stable (memoised with `[]` deps in `TasksProvider`), so the effect does not need to re-run. (Re-running it would tear down and recreate the interval.)

- [ ] **Step 4: Typecheck**

Run: `npx tsc -b`
Expected: no output (clean).

- [ ] **Step 5: Run tests**

Run: `npx vitest run src/context/ConnectionContext.test.tsx`
Expected: PASS. The existing tests render `ConnectionProvider` without a `TasksProvider`; `useTasks()` returns the no-op default, so heartbeat/reload still behave exactly as before.

- [ ] **Step 6: Run the full suite**

Run: `npx vitest run`
Expected: PASS (all tests).

- [ ] **Step 7: Commit**

```bash
git add src/context/ConnectionContext.tsx
git commit -m "feat: register heartbeat + revalidation tasks in the activity monitor"
```

---

## Task 8: Manual verification

**Files:** none (manual).

- [ ] **Step 1: Build**

Run: `npm run build`
Expected: TS type check passes and the bundle is produced with no errors.

- [ ] **Step 2: Launch and exercise**

Run: `npm run tauri dev`

Verify in the running app:
- Footer shows a dim `Activity` icon when idle.
- Running a query → footer shows a spinner + `1`; the popover (click) lists the query with its SQL preview and a live elapsed timer.
- Clicking the cancel `✕` on a running query stops it (query ends, task disappears).
- Scrolling a result to trigger "load more" → a `load-more` task appears briefly.
- After ~30s with a live connection, a dimmed "Heartbeat" entry flickers in the background group; it is not counted in the footer badge.
- On startup / reconnect, "Checking connections" appears as a background task instead of the old "Revalidating…" text.

---

## Notes for the implementer

- Cancel is connection-scoped (`cancel_query` takes `connectionId`), so it cancels whatever query runs on that connection — correct because a connection runs one query at a time.
- `startTask`/`endTask`/`cancelTask` are stable across renders (memoised with empty deps), so adding them to `useCallback`/`useEffect` dependency arrays does not cause re-creation churn.
