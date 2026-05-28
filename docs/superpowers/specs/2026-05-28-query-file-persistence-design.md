# Query File Persistence & Saved Indicator

**Date:** 2026-05-28
**Status:** Approved

## Overview

Replace the current SQLite session blob with a file-first model. Each query tab maps to a `.sql` file on disk. Auto-save runs on a debounce; a dot indicator on the tab title shows unsaved state. Every save appends a timestamped snapshot for version history.

## File Layout

```
~/Documents/Crabeaver/queries/       ← default, user-configurable
  Query 1.sql
  My Analysis.sql
  .history/
    Query 1/
      2026-05-28T14-32-00.sql
      2026-05-28T15-10-44.sql
    My Analysis/
      2026-05-28T16-00-01.sql
```

- Snapshots use dashes instead of colons in timestamps for filesystem compatibility.
- Snapshots are capped at 50 per file; oldest are dropped when the cap is exceeded.
- `.history/` is created lazily on the first snapshot write.
- `list_query_files` excludes `.history/` from results.

## Data Model

### Tab (TypeScript)

```ts
interface Tab {
  id: number        // React key only
  title: string     // matches filename without .sql extension
  filePath: string  // absolute path to .sql file
  content: string
  isDirty: boolean
}
```

### SQLite (retained keys)

| Key | Value |
|-----|-------|
| `active_query_file` | Filename (not full path) of the active tab on last exit |
| `queries_dir` | User-configured queries directory (absent = use default) |

The `tab_sessions` key is removed.

## Tauri Commands (Rust)

| Command | Signature | Notes |
|---------|-----------|-------|
| `get_queries_dir` | `() → String` | Returns configured path or OS default |
| `set_queries_dir` | `(path: String) → ()` | Saves to settings; creates dir if missing |
| `list_query_files` | `() → Vec<QueryFileMeta>` | Sorted by name; excludes `.history/` |
| `read_query_file` | `(path: String) → String` | |
| `write_query_file` | `(path: String, content: String) → ()` | Writes file + appends snapshot; enforces cap |
| `delete_query_file` | `(path: String) → ()` | Deletes file; history is preserved |
| `rename_query_file` | `(old: String, new: String) → ()` | Renames file and `.history/<name>/` folder |

```rust
pub struct QueryFileMeta {
    pub name: String,   // filename without .sql
    pub path: String,   // absolute path
}
```

## Frontend Components

### TabsContext

- On mount: call `list_query_files()` → create one `Tab` per file. If dir is empty, create `Query 1.sql` and one blank tab.
- Restore active tab from `get_setting('active_query_file')`.
- `updateContent(id, content)` sets `isDirty: true` and starts 800ms debounce timer.
- Debounce fires → `write_query_file(filePath, content)` → `isDirty: false`.
- On unmount/close: flush pending saves synchronously.
- `openQueryTab()` picks the next unused `Query N` name, calls `write_query_file` to create the file immediately (empty content), adds tab.
- `closeTab(id)` removes tab from state; file remains on disk.
- `renameTab(id, newTitle)` calls `rename_query_file`, updates tab state on success; reverts title on failure.

### EditorTabs

- Tab title rendered as `● Query 1` when `isDirty`, `Query 1` when clean.
- The dot is styled with `text-th-dim` and a small left margin.

### SettingsTab

- New "Queries Directory" section with a text input (read-only display) and a "Browse" button.
- "Browse" opens a Tauri folder-picker dialog (`open({ directory: true })`).
- Selecting a new directory calls `set_queries_dir`, then re-triggers the startup scan to reload tabs.

## Data Flow: Edit → Save → Snapshot

```
User types
  → isDirty: true, dot appears on tab
  → debounce resets (800ms)
  → debounce fires
  → write_query_file(path, content)
      → write file atomically
      → append .history/<name>/<timestamp>.sql
      → if snapshots > 50, delete oldest
  → isDirty: false, dot clears
```

## Error Handling

| Scenario | Behavior |
|----------|----------|
| Write fails (disk full, permissions) | `isDirty` stays true; status bar shows error. Content safe in memory. |
| Queries dir deleted mid-session | Next save recreates it automatically. |
| Duplicate filename on new tab | Increment suffix until unique (`Query 2`, `Query 3`, …). |
| Rename collision | Rename fails with error; tab title reverts. |
| Cold start, dir missing | Dir is created; one blank `Query 1.sql` opened. |

## Testing

- **Rust unit tests** in `commands/queries.rs`:
  - `write_query_file` creates a snapshot in `.history/`
  - Snapshot cap: writing 51 times leaves exactly 50 snapshots
  - `list_query_files` excludes `.history/` entries
  - `rename_query_file` renames both file and history folder
- **TypeScript** (`tabs.test.ts`): update existing tests to include `filePath` and `isDirty` fields in `Tab`.

## Out of Scope

- In-app snapshot browser / history viewer (future feature)
- Conflict resolution for files edited externally while app is open
