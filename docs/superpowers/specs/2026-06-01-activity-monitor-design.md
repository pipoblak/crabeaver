# Activity Monitor — Design

**Date:** 2026-06-01
**Status:** Approved

## Problem

Query loading state lives per-result-tab inside `EditorTabs` (`running` flag). There's
no single place to see what the app is doing against the database. Other async work —
schema introspection, pagination, connection heartbeat/revalidation — is invisible or
scattered (the standalone "Revalidating…" footer indicator is the only hint).

We want a persistent affordance in the main footer (`StatusBar`) that shows when DB
work is happening, and a click-to-open popover that lists the running/pending tasks —
an activity monitor — with the ability to cancel a running query.

## Scope

In scope (decided):
- **All DB activity** as tasks: query execution, pagination ("load more"), schema
  introspection fetches, connection heartbeat + revalidation.
- **Cancel** for query tasks (reuses the existing `cancel_query` IPC).
- **Active only** — no completed/failed history retained.

Out of scope:
- Frontend SQL linting (stays in `LintStatus`, left side of the status bar — it's not
  DB activity).
- Per-query cancel granularity beyond what `cancel_query` offers (it is
  connection-scoped; see Constraints).
- Task history / query log persistence.

## Architecture

New global **`TasksContext`** (`src/context/TasksContext.tsx`): an in-memory registry
that any async DB operation writes into. The footer reads from it.

Provider placement in `src/main.tsx` — **outside** `ConnectionProvider`, since the
connection heartbeat/revalidation registers tasks:

```
ThemeProvider > ValidationProvider > TasksProvider > ConnectionProvider > App
```

`TabsProvider` (in `App.tsx`) is already nested below all of these, so `EditorTabs`
and `SqlEditor` can consume `useTasks()` without reordering.

## Data Model

```ts
type TaskKind = 'query' | 'load-more' | 'schema' | 'connection'

interface Task {
  id: string            // caller-stable, e.g. `query:${resultTabId}`
  kind: TaskKind
  label: string         // tab title / "Schema · mydb" / "Heartbeat · <conn name>"
  detail?: string       // SQL preview for queries (whitespace-collapsed, truncated)
  connectionId?: string // present when the task can be cancelled
  cancellable?: boolean // true only for `query`
  background?: boolean   // schema / connection → subdued, not counted in the badge
  startedAt: number     // Date.now() at registration, for the live elapsed timer
}
```

Backing store: `Map<string, Task>` in a `useState`/`useRef` inside the provider. A
caller-stable `id` makes start/end idempotent and lets a re-run overwrite its own
prior entry instead of stacking duplicates.

### Context API

```ts
interface TasksContextValue {
  tasks: Task[]                          // snapshot, insertion order
  startTask(task: Omit<Task, 'startedAt'>): void  // adds/overwrites by id
  endTask(id: string): void              // removes by id; no-op if absent
  cancelTask(id: string): void           // invoke('cancel_query', {connectionId}) then leaves
                                          // the task to be removed by its owner's endTask
}
const useTasks = () => useContext(...)   // throws if used outside provider
```

Notes:
- `startTask` stamps `startedAt` via `Date.now()`.
- `endTask` is called from the owner's `finally` (success, error, cancel) so tasks
  never leak.
- `cancelTask` fires the IPC; the actual removal still flows through the owner's
  `endTask` when the aborted query's promise settles. This keeps a single removal
  path and avoids a task vanishing before the backend acknowledges.

## UI

### Footer indicator — `src/components/ActivityMonitor.tsx`, rendered inside `StatusBar`

Replaces the standalone "Revalidating…" block (revalidation becomes a background task).

- **Idle** (no tasks): a dim `Activity` icon — the persistent affordance.
- **Foreground tasks active**: spinning `Loader2` + count of foreground tasks (e.g. `2`).
- **Background-only** (e.g. just a heartbeat): quiet state — spinner without a count,
  so heartbeats don't read as "2 things running".
- The whole indicator is a button; clicking toggles the popover.

### Popover

Same pattern as the existing connection picker in `StatusBar` (absolute,
`bottom-full mb-1`, opens upward, closes on outside-click via a `mousedown` listener):

- **Foreground group** (queries, load-more): kind icon, `label`, `detail` (SQL preview)
  on a second line for queries, live elapsed `1.4s`, and an `✕` cancel button for
  `cancellable` tasks → `cancelTask(id)`.
- **Background group** (schema, connection): dimmed, smaller, no cancel.
- **Empty**: "No active tasks".

### Live elapsed timer

One `setInterval` (~200 ms) inside `ActivityMonitor`, running only while
`tasks.length > 0` (cleared otherwise). It bumps a local tick state so the
`Date.now() - startedAt` readouts update. No per-task timers.

## Registration Points

| Location | kind | background | cancellable | id | end in |
|---|---|---|---|---|---|
| `EditorTabs.runQuery` | `query` | no | yes | `query:${resultTabId}` | success / error / cancel branches |
| `EditorTabs` load-more handler | `load-more` | no | no | `load-more:${resultTabId}` | `finally` |
| `SqlEditor.fetchSchema` callers | `schema` | yes | no | `schema:${connectionId}:${database}` | `.finally` |
| `ConnectionContext` heartbeat | `connection` | yes | no | `heartbeat:${connectionId}` | `.finally` |
| `ConnectionContext` revalidation | `connection` | yes | no | `revalidate:${connectionId}` | `.finally` |

`fetchSchema` is a module-level function (no hook access); registration wraps it at the
call sites inside the `SqlEditor` component (which can call `useTasks`), not inside
`fetchSchema` itself.

## Constraints

- `cancel_query` (`src-tauri/src/commands/connections.rs:93`) is **connection-scoped**:
  it cancels whatever query is running on that connection, not a specific query id.
  Acceptable — a connection runs one query at a time. The cancel button passes the
  task's `connectionId`.
- The existing editor-toolbar Cancel button (`EditorTabs.tsx:702`) keeps working
  unchanged; it calls the same IPC.

## Error Handling

- Every task's `endTask` lives in a `finally`/settle path so a thrown query, failed
  schema fetch, or rejected heartbeat still removes its task.
- `cancelTask` swallows IPC errors (best-effort; the query's own error path removes the
  task).
- `useTasks` throws if called outside the provider (matches the other contexts).

## Testing

`src/context/TasksContext.test.tsx` (vitest, mirrors `ConnectionContext.test.tsx`):
- `startTask` adds; same id overwrites instead of duplicating.
- `endTask` removes; unknown id is a no-op.
- Foreground count excludes `background` tasks.
- `cancelTask` invokes `cancel_query` with the task's `connectionId` (mock `invoke`);
  does not itself remove the task.

## Files

New:
- `src/context/TasksContext.tsx`
- `src/context/TasksContext.test.tsx`
- `src/components/ActivityMonitor.tsx`

Changed:
- `src/main.tsx` — add `TasksProvider`.
- `src/components/StatusBar.tsx` — render `ActivityMonitor`; remove the standalone
  "Revalidating…" indicator.
- `src/components/EditorTabs.tsx` — register query + load-more tasks.
- `src/components/SqlEditor.tsx` — register schema-fetch tasks at call sites.
- `src/context/ConnectionContext.tsx` — register heartbeat + revalidation tasks.
