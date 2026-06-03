# Workspaces — Design

**Date:** 2026-06-03
**Status:** Approved

## Problem

Queries are flat `.sql` files in a single configurable directory (`queries_dir`).
They never appear in the sidebar — they only exist as open editor tabs, and the
app auto-opens *every* file on launch. There's no way to organize queries or to
browse saved ones. We want a **Workspaces** section in the sidebar (below
Connections) that groups queries, lets the user browse them, and saves each query
inside a workspace.

## Decisions (settled during brainstorming)

- A **workspace is purely a grouping of queries** — it does NOT bind a connection.
  Connection stays per-tab, exactly as today.
- Storage: **a workspace is an immediate subfolder of `queries_dir`**; a query is
  a `.sql` file inside it. File-based, consistent with today's model.
- **Migration:** existing loose `.sql` files at the root of `queries_dir` move into
  a `Default` workspace folder. Everything ends up inside some workspace.
- **Open model:** the sidebar lists workspaces → queries; clicking a query opens it
  as a tab. On startup the app restores only the tabs that were open last session
  (not every file).

## Out of scope (v1)

- Moving a query between workspaces.
- Workspace-level connection defaults.
- Nested workspaces (subfolders of subfolders) — only one level under the root.

## Storage Model

```
queries_dir/
  Default/
    Query 1.sql
    .history/Query 1/<timestamps>.sql     # per-query history, lives with the query
  Analytics/
    daily revenue.sql
```

- A **workspace** = an immediate subdirectory of `queries_dir` (excluding hidden
  dirs and any top-level `.history`).
- A **query** = a `*.sql` file directly inside a workspace folder.
- Per-query `.history/` versioning stays adjacent to the query (inside the
  workspace folder). `rename_query_file` already moves the matching history folder,
  so renames within a workspace keep history.

### Migration (one-time, idempotent)

Run at the start of `list_workspaces`:
1. Ensure `queries_dir/Default/` exists.
2. For each `*.sql` directly in `queries_dir` (root level only): move it into
   `Default/`, and if a sibling `.history/<stem>/` exists, move that too.
3. Only root-level files are touched, so re-running is a no-op once the root is
   clean.

## Backend (`src-tauri/src/commands/queries.rs`, registered in `lib.rs`)

New types:

```rust
#[derive(Serialize)]
pub struct Workspace { pub name: String, pub queries: Vec<QueryFileMeta> }
```

New commands:
- `list_workspaces(app, state) -> Vec<Workspace>` — runs migration, then lists each
  subfolder (sorted) with its `.sql` files (sorted by name). Skips hidden dirs and
  `.history`.
- `create_workspace(app, state, name) -> ()` — validate name (non-empty, no path
  separators / `..`), `create_dir`. Error if it already exists.
- `rename_workspace(app, state, old, new) -> ()` — fs rename; validate `new`.
- `delete_workspace(app, state, name) -> ()` — `remove_dir_all` the folder.
- `create_query(app, state, workspace, name) -> String` — create an empty `.sql`
  under the workspace, returning its full path. If the name collides, append
  ` (n)` until unique.

Kept as-is (operate on a full `path`, work for any workspace):
`read_query_file`, `write_query_file`, `delete_query_file`, `rename_query_file`,
`save_to_downloads`.

Removed from use: `list_query_files` (flat). Leave the command registered for one
release if cheap, but the frontend stops calling it.

Validation helper: reject workspace/query names containing `/`, `\`, or `..`, or
that are empty/whitespace, with a clear `Err(String)`.

## Frontend

### `src/context/TabsContext.tsx` (load + persist change)

- `Tab` gains `workspace?: string` (the basename of the query file's parent dir).
- **Startup** (`loadTabs`): read setting `open_query_tabs` (JSON `string[]` of file
  paths). For each existing path, read its content into a tab. Active tab from
  setting `active_query_path`. If `open_query_tabs` is empty/missing, open the
  first query found via `list_workspaces` (or create `Default/Query 1.sql` if there
  are none) so the editor is never empty on first run.
- **Persistence:** whenever the open query tabs change, write `open_query_tabs`
  (the list of query tab file paths) and `active_query_path`. The per-tab
  connection map (`tab_query_connections`) is re-keyed **by file path** instead of
  title (titles can now collide across workspaces).
- New actions exposed on the context:
  - `openQueryByPath(path: string)` — focus the tab if already open, else read the
    file and open a new tab (deriving title from stem, workspace from parent dir).
  - `createQuery(workspace: string, title?)` — call `create_query`, then open the
    returned path as a tab.
  - `openQueryTab()` (the existing "+ new") creates a query in the **active tab's
    workspace**, falling back to `Default`.

### `src/hooks/useWorkspaces.ts` (new)

Thin data hook: holds the `Workspace[]` from `list_workspaces`, plus `refresh()`
and mutation wrappers (`createWorkspace`, `renameWorkspace`, `deleteWorkspace`,
`createQuery`, `deleteQuery`, `renameQuery`) that call the backend and `refresh()`.
Errors surface as a returned/thrown message the Sidebar can show inline.

### `src/components/Sidebar.tsx` — new "Workspaces" section

Rendered below the Connections section. Reuses the hoisted, memoized `Row`.
- Section header `Workspaces` with a `+` button → prompt/inline-create a workspace.
- For each workspace: an expandable `Row` (folder icon). On hover: a `+` to add a
  query, and a delete affordance. Double-click renames.
- Under an expanded workspace: each query as a `Row` (file icon). Click →
  `openQueryByPath`. Hover → delete. Double-click → rename.
- After any mutation, `refresh()` the workspace list. Deleting a workspace/query
  that has open tabs closes those tabs (via a TabsContext callback).

### `src/App.tsx`

Pass the query/workspace actions from TabsContext down to `Sidebar` (mirroring how
`openTab` is already threaded), so the sidebar can open queries and the workspace
hook can mutate.

### `src/components/EditorTabs.tsx`

The "+ new result tab" / new-query button routes through the updated
`openQueryTab()` (creates in the active workspace). No results/grid logic changes.

## Data Flow

```
Sidebar click query → openQueryByPath(path) → TabsContext opens/focuses tab → EditorTabs renders
Sidebar "+ query"   → useWorkspaces.createQuery → create_query (rust) → refresh + openQueryByPath
Open tabs change    → persist open_query_tabs + active_query_path (settings)
Next launch         → loadTabs restores exactly those tabs
```

## Error Handling

- Duplicate/invalid workspace or query name → backend `Err`; Sidebar shows an
  inline message, no tab opened.
- Deleting a workspace or query that backs open tabs → close those tabs first
  (match by path / by parent dir).
- Migration errors (a file that can't be moved) → log via `tracing`, skip that
  file, continue; never block app load.
- `openQueryByPath` on a missing file → ignore (stale sidebar), trigger a refresh.

## Testing

Rust (`queries.rs` `#[cfg(test)]`, extends existing tests):
- Migration moves a root-level `.sql` (and its `.history/<stem>`) into `Default/`,
  and is a no-op on a second run.
- `create_workspace` rejects names with `/`, `..`, or empty; creates the dir.
- `create_query` returns a unique path when the name already exists.
- `delete_workspace` removes the folder and its queries.

Frontend (vitest, mock `@tauri-apps/api/core`):
- `loadTabs` restores exactly the tabs listed in `open_query_tabs` and sets the
  active tab from `active_query_path`.
- `openQueryByPath` focuses an already-open tab instead of duplicating it.

## Files

New:
- `src/hooks/useWorkspaces.ts`

Changed:
- `src-tauri/src/commands/queries.rs` — workspace types + commands + migration.
- `src-tauri/src/lib.rs` — register the new commands.
- `src/context/TabsContext.tsx` — session-restore load/persist, path-keyed
  settings, `openQueryByPath` / `createQuery`, `workspace` on `Tab`.
- `src/components/Sidebar.tsx` — Workspaces section.
- `src/App.tsx` — thread the new actions to Sidebar.
- `src/components/EditorTabs.tsx` — new-query routes to active workspace.
