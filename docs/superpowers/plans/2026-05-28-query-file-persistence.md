# Query File Persistence & Saved Indicator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the SQLite session blob with a file-first model where each query tab is a `.sql` file on disk, auto-saved with a debounce and versioned with timestamped snapshots.

**Architecture:** On startup, scan `~/Documents/Crabeaver/queries/` (user-configurable) and open one tab per `.sql` file. Edits set `isDirty: true` (dot on tab) and start an 800ms debounce; on fire, write the file and append a timestamped snapshot to `.history/<name>/`. The SQLite session blob is removed; only `active_query_file` and `queries_dir` keys remain.

**Tech Stack:** Rust/Tauri 2 (file I/O, `chrono` for timestamps), React/TypeScript (TabsContext, EditorTabs), Vitest (TS unit tests), `tempfile` crate (Rust unit tests).

---

## File Map

| Action | Path | Purpose |
|--------|------|---------|
| Create | `src-tauri/src/commands/queries.rs` | 7 Tauri commands + `append_snapshot` helper + unit tests |
| Modify | `src-tauri/src/commands/mod.rs` | expose `queries` module |
| Modify | `src-tauri/src/lib.rs` | register 7 new commands |
| Modify | `src-tauri/Cargo.toml` | add `chrono`, `tempfile` dev-dep |
| Modify | `src/lib/tabs.ts` | add `filePath`, `isDirty` to `Tab`; add `markClean`; update function signatures |
| Modify | `src/lib/tabs.test.ts` | update tests for new `Tab` shape + `markClean` |
| Modify | `src/context/TabsContext.tsx` | file-first restore, per-tab debounce save, `renameTab`, `reloadTabs`, expose `restored` |
| Modify | `src/App.tsx` | move to inner `AppShell` pattern to consume `restored` from context |
| Modify | `src/components/EditorTabs.tsx` | `●` dot when `isDirty`, double-click inline rename |
| Modify | `src/components/SettingsTab.tsx` | queries directory section with Set button |

---

## Task 1: Rust dependencies + queries commands

**Files:**
- Modify: `src-tauri/Cargo.toml`
- Create: `src-tauri/src/commands/queries.rs`

- [ ] **Step 1: Add chrono + tempfile to Cargo.toml**

In `[dependencies]` block add:
```toml
chrono = { version = "0.4", features = ["clock"] }
```

Add a new `[dev-dependencies]` section at the end of the file:
```toml
[dev-dependencies]
tempfile = "3"
```

- [ ] **Step 2: Create `src-tauri/src/commands/queries.rs`**

```rust
use chrono::Local;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager, State};

use crate::infrastructure::database::AppState;

#[derive(Debug, Serialize, Deserialize)]
pub struct QueryFileMeta {
    pub name: String,
    pub path: String,
}

fn queries_dir_path(app: &AppHandle, configured: Option<String>) -> Result<PathBuf, String> {
    if let Some(p) = configured {
        return Ok(PathBuf::from(p));
    }
    let docs = app.path().document_dir().map_err(|e| e.to_string())?;
    Ok(docs.join("Crabeaver").join("queries"))
}

#[tauri::command]
pub async fn get_queries_dir(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let row = sqlx::query_scalar::<_, String>(
        "SELECT value FROM settings WHERE key = 'queries_dir'",
    )
    .fetch_optional(&state.db)
    .await
    .map_err(|e| e.to_string())?;

    let path = queries_dir_path(&app, row)?;
    std::fs::create_dir_all(&path).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().to_string())
}

#[tauri::command]
pub async fn set_queries_dir(
    path: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    std::fs::create_dir_all(&path).map_err(|e| e.to_string())?;
    sqlx::query(
        "INSERT INTO settings (key, value) VALUES ('queries_dir', ?) \
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    )
    .bind(&path)
    .execute(&state.db)
    .await
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn list_query_files(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<Vec<QueryFileMeta>, String> {
    let row = sqlx::query_scalar::<_, String>(
        "SELECT value FROM settings WHERE key = 'queries_dir'",
    )
    .fetch_optional(&state.db)
    .await
    .map_err(|e| e.to_string())?;

    let dir = queries_dir_path(&app, row)?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;

    // read_dir is non-recursive: .history/ contents never appear here
    let mut files: Vec<QueryFileMeta> = std::fs::read_dir(&dir)
        .map_err(|e| e.to_string())?
        .filter_map(|e| e.ok())
        .filter(|e| {
            let p = e.path();
            p.extension().map(|ext| ext == "sql").unwrap_or(false)
                && e.file_type().map(|t| t.is_file()).unwrap_or(false)
        })
        .filter_map(|e| {
            let path = e.path();
            let name = path.file_stem()?.to_str()?.to_string();
            Some(QueryFileMeta {
                name,
                path: path.to_string_lossy().to_string(),
            })
        })
        .collect();

    files.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(files)
}

#[tauri::command]
pub async fn read_query_file(path: String) -> Result<String, String> {
    std::fs::read_to_string(&path).map_err(|e| e.to_string())
}

fn append_snapshot(file_path: &Path, content: &str) -> Result<(), String> {
    let stem = file_path
        .file_stem()
        .unwrap_or_default()
        .to_string_lossy()
        .to_string();
    let parent = file_path.parent().unwrap_or(Path::new("."));
    let history_dir = parent.join(".history").join(&stem);
    std::fs::create_dir_all(&history_dir).map_err(|e| e.to_string())?;

    let timestamp = Local::now().format("%Y-%m-%dT%H-%M-%S").to_string();
    let snapshot_path = history_dir.join(format!("{}.sql", timestamp));
    std::fs::write(&snapshot_path, content).map_err(|e| e.to_string())?;

    // Enforce 50-snapshot cap: sort alphabetically (timestamp names sort chronologically),
    // delete the oldest entries if over the limit.
    let mut snapshots: Vec<PathBuf> = std::fs::read_dir(&history_dir)
        .map_err(|e| e.to_string())?
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| p.extension().map(|ext| ext == "sql").unwrap_or(false))
        .collect();

    if snapshots.len() > 50 {
        snapshots.sort();
        for path in snapshots.iter().take(snapshots.len() - 50) {
            let _ = std::fs::remove_file(path);
        }
    }

    Ok(())
}

#[tauri::command]
pub async fn write_query_file(path: String, content: String) -> Result<(), String> {
    let p = Path::new(&path);
    if let Some(parent) = p.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::write(p, &content).map_err(|e| e.to_string())?;
    append_snapshot(p, &content)
}

#[tauri::command]
pub async fn delete_query_file(path: String) -> Result<(), String> {
    std::fs::remove_file(&path).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn rename_query_file(old_path: String, new_path: String) -> Result<(), String> {
    std::fs::rename(&old_path, &new_path).map_err(|e| e.to_string())?;

    let old = Path::new(&old_path);
    let new = Path::new(&new_path);
    if let (Some(old_stem), Some(new_stem), Some(parent)) =
        (old.file_stem(), new.file_stem(), old.parent())
    {
        let old_history = parent.join(".history").join(old_stem);
        if old_history.exists() {
            let new_history = parent.join(".history").join(new_stem);
            let _ = std::fs::rename(old_history, new_history);
        }
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    #[test]
    fn append_snapshot_creates_history_entry() {
        let dir = TempDir::new().unwrap();
        let file = dir.path().join("test.sql");
        fs::write(&file, "SELECT 1").unwrap();

        append_snapshot(&file, "SELECT 1").unwrap();

        let history = dir.path().join(".history").join("test");
        assert!(history.exists(), ".history/test/ should be created");
        assert_eq!(fs::read_dir(&history).unwrap().count(), 1);
    }

    #[test]
    fn append_snapshot_enforces_50_cap() {
        let dir = TempDir::new().unwrap();
        let file = dir.path().join("q.sql");
        fs::write(&file, "").unwrap();

        // Pre-fill history with 51 entries (names sort before timestamp names)
        let history_dir = dir.path().join(".history").join("q");
        fs::create_dir_all(&history_dir).unwrap();
        for i in 0..51u32 {
            fs::write(history_dir.join(format!("{:04}.sql", i)), "x").unwrap();
        }

        // 51 existing + 1 appended = 52; cap removes 2 oldest → 50
        append_snapshot(&file, "trigger").unwrap();

        let count = fs::read_dir(&history_dir).unwrap().count();
        assert_eq!(count, 50);
    }

    #[test]
    fn list_query_files_filter_excludes_non_sql_and_dirs() {
        let dir = TempDir::new().unwrap();
        // Subdirectory — read_dir is non-recursive, so its contents never appear,
        // but the dir entry itself is filtered by is_file().
        let sub = dir.path().join("subdir");
        fs::create_dir_all(&sub).unwrap();
        fs::write(dir.path().join("query.sql"), "").unwrap();
        fs::write(dir.path().join("readme.md"), "").unwrap();

        let files: Vec<_> = fs::read_dir(dir.path())
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| {
                let p = e.path();
                p.extension().map(|ext| ext == "sql").unwrap_or(false)
                    && e.file_type().map(|t| t.is_file()).unwrap_or(false)
            })
            .collect();

        assert_eq!(files.len(), 1);
        assert!(files[0].path().ends_with("query.sql"));
    }

    #[test]
    fn rename_query_file_moves_history_folder() {
        let dir = TempDir::new().unwrap();
        let old_file = dir.path().join("old.sql");
        let new_file = dir.path().join("new.sql");
        fs::write(&old_file, "SELECT 1").unwrap();

        let history = dir.path().join(".history").join("old");
        fs::create_dir_all(&history).unwrap();
        fs::write(history.join("snap.sql"), "SELECT 1").unwrap();

        // Replicate the rename logic (sans async wrapper)
        fs::rename(&old_file, &new_file).unwrap();
        let old_history = dir.path().join(".history").join("old");
        let new_history = dir.path().join(".history").join("new");
        if old_history.exists() {
            fs::rename(&old_history, &new_history).unwrap();
        }

        assert!(new_history.exists());
        assert!(!old_history.exists());
        assert_eq!(fs::read_dir(&new_history).unwrap().count(), 1);
    }
}
```

- [ ] **Step 3: Run tests**

```bash
cd src-tauri && cargo test queries
```

Expected output: `test commands::queries::tests::append_snapshot_creates_history_entry ... ok` (×4 tests).

- [ ] **Step 4: Commit**

```bash
git add src-tauri/Cargo.toml src-tauri/src/commands/queries.rs
git commit -m "feat: add Rust query file commands with snapshot versioning"
```

---

## Task 2: Register queries commands

**Files:**
- Modify: `src-tauri/src/commands/mod.rs`
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: Expose queries module in mod.rs**

Replace the full content of `src-tauri/src/commands/mod.rs`:

```rust
pub mod marketplace;
pub mod queries;
pub mod settings;
pub mod sql_completion;
pub mod sql_validation;
```

- [ ] **Step 2: Import and register in lib.rs**

At the top of `src-tauri/src/lib.rs`, add after the existing `use` lines:

```rust
use commands::queries::{
    delete_query_file, get_queries_dir, list_query_files, read_query_file,
    rename_query_file, set_queries_dir, write_query_file,
};
```

Replace the `invoke_handler!` block:

```rust
.invoke_handler(tauri::generate_handler![
    search_marketplace,
    install_theme,
    get_setting,
    set_setting,
    get_themes,
    save_theme,
    delete_theme,
    get_sql_completions,
    validate_sql,
    get_queries_dir,
    set_queries_dir,
    list_query_files,
    read_query_file,
    write_query_file,
    delete_query_file,
    rename_query_file,
])
```

- [ ] **Step 3: Verify build**

```bash
cd src-tauri && cargo build
```

Expected: Compiles with no errors.

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/commands/mod.rs src-tauri/src/lib.rs
git commit -m "feat: register query file Tauri commands"
```

---

## Task 3: Update Tab type and pure logic

**Files:**
- Modify: `src/lib/tabs.ts`
- Modify: `src/lib/tabs.test.ts`

- [ ] **Step 1: Rewrite tabs.ts**

```typescript
export interface Tab {
  id: number
  title: string
  filePath: string
  content: string
  isDirty: boolean
}

export interface TabsState {
  tabs: Tab[]
  activeId: number
}

export function openTab(state: TabsState, id: number, filePath: string): TabsState {
  const n = state.tabs.length + 1
  return {
    tabs: [...state.tabs, { id, title: `Query ${n}`, filePath, content: '', isDirty: false }],
    activeId: id,
  }
}

export function closeTab(state: TabsState, id: number): TabsState {
  if (state.tabs.length <= 1) return state
  const idx = state.tabs.findIndex(t => t.id === id)
  const tabs = state.tabs.filter(t => t.id !== id)
  const activeId = id === state.activeId
    ? tabs[Math.min(idx, tabs.length - 1)].id
    : state.activeId
  return { tabs, activeId }
}

export function updateContent(state: TabsState, id: number, content: string): TabsState {
  return {
    ...state,
    tabs: state.tabs.map(t => t.id === id ? { ...t, content, isDirty: true } : t),
  }
}

export function markClean(state: TabsState, id: number): TabsState {
  return {
    ...state,
    tabs: state.tabs.map(t => t.id === id ? { ...t, isDirty: false } : t),
  }
}

// filePath defaults to a temp path so existing tests don't need to supply it
export function initialState(filePath = '/tmp/Query 1.sql'): TabsState {
  return {
    tabs: [{ id: 1, title: 'Query 1', filePath, content: '', isDirty: false }],
    activeId: 1,
  }
}
```

- [ ] **Step 2: Rewrite tabs.test.ts**

```typescript
import { describe, it, expect } from 'vitest'
import { openTab, closeTab, updateContent, markClean, initialState } from './tabs'

describe('initialState', () => {
  it('starts with one Query 1 tab active', () => {
    const s = initialState()
    expect(s.tabs).toHaveLength(1)
    expect(s.tabs[0].title).toBe('Query 1')
    expect(s.tabs[0].isDirty).toBe(false)
    expect(s.activeId).toBe(1)
  })
})

describe('openTab', () => {
  it('appends tab and activates it', () => {
    const s = openTab(initialState(), 2, '/tmp/q2.sql')
    expect(s.tabs).toHaveLength(2)
    expect(s.activeId).toBe(2)
  })

  it('derives title from tab count at open time', () => {
    const s1 = openTab(initialState(), 2, '/tmp/q2.sql')
    const s2 = openTab(s1, 3, '/tmp/q3.sql')
    expect(s2.tabs[1].title).toBe('Query 2')
    expect(s2.tabs[2].title).toBe('Query 3')
  })

  it('preserves existing tab content', () => {
    const filled = updateContent(initialState(), 1, 'SELECT 1')
    const s = openTab(filled, 2, '/tmp/q2.sql')
    expect(s.tabs[0].content).toBe('SELECT 1')
  })

  it('new tab starts clean, empty, with correct filePath', () => {
    const s = openTab(initialState(), 2, '/tmp/q2.sql')
    expect(s.tabs[1].content).toBe('')
    expect(s.tabs[1].isDirty).toBe(false)
    expect(s.tabs[1].filePath).toBe('/tmp/q2.sql')
  })
})

describe('closeTab', () => {
  it('cannot close the last tab', () => {
    const s = initialState()
    expect(closeTab(s, 1)).toBe(s)
  })

  it('removes the tab', () => {
    const s = openTab(initialState(), 2, '/tmp/q2.sql')
    const next = closeTab(s, 2)
    expect(next.tabs).toHaveLength(1)
    expect(next.tabs[0].id).toBe(1)
  })

  it('activates previous tab when closing active', () => {
    const s = openTab(openTab(initialState(), 2, '/tmp/q2.sql'), 3, '/tmp/q3.sql')
    const next = closeTab(s, 3)
    expect(next.activeId).toBe(2)
  })

  it('keeps active unchanged when closing non-active tab', () => {
    const s = openTab(initialState(), 2, '/tmp/q2.sql')
    const next = closeTab(s, 1)
    expect(next.activeId).toBe(2)
  })

  it('closing middle tab clamps active within bounds', () => {
    const s0 = openTab(openTab(initialState(), 2, '/tmp/q2.sql'), 3, '/tmp/q3.sql')
    const s1 = { ...s0, activeId: 2 }
    const next = closeTab(s1, 1)
    expect(next.activeId).toBe(2)
    expect(next.tabs.map(t => t.id)).toEqual([2, 3])
  })

  it('closing first tab when active selects next', () => {
    const s = { ...openTab(initialState(), 2, '/tmp/q2.sql'), activeId: 1 }
    const next = closeTab(s, 1)
    expect(next.activeId).toBe(2)
  })
})

describe('updateContent', () => {
  it('marks tab dirty and sets content', () => {
    const s = updateContent(initialState(), 1, 'SELECT 1')
    expect(s.tabs[0].isDirty).toBe(true)
    expect(s.tabs[0].content).toBe('SELECT 1')
  })

  it('updates content of target tab only', () => {
    const s = openTab(initialState(), 2, '/tmp/q2.sql')
    const next = updateContent(s, 1, 'SELECT 1')
    expect(next.tabs[0].content).toBe('SELECT 1')
    expect(next.tabs[1].content).toBe('')
  })

  it('ignores unknown id', () => {
    const s = initialState()
    const next = updateContent(s, 999, 'x')
    expect(next.tabs[0].content).toBe('')
    expect(next.tabs[0].isDirty).toBe(false)
  })

  it('does not change activeId', () => {
    const s = openTab(initialState(), 2, '/tmp/q2.sql')
    const next = updateContent(s, 1, 'x')
    expect(next.activeId).toBe(2)
  })
})

describe('markClean', () => {
  it('clears isDirty for the target tab', () => {
    const dirty = updateContent(initialState(), 1, 'SELECT 1')
    expect(dirty.tabs[0].isDirty).toBe(true)
    const clean = markClean(dirty, 1)
    expect(clean.tabs[0].isDirty).toBe(false)
    expect(clean.tabs[0].content).toBe('SELECT 1')
  })

  it('does not affect other tabs', () => {
    const s = openTab(updateContent(initialState(), 1, 'x'), 2, '/tmp/q2.sql')
    const dirty2 = updateContent(s, 2, 'y')
    const cleaned = markClean(dirty2, 1)
    expect(cleaned.tabs[0].isDirty).toBe(false)
    expect(cleaned.tabs[1].isDirty).toBe(true)
  })
})
```

- [ ] **Step 3: Run tests**

```bash
npm test
```

Expected: All tests pass (27 tests total).

- [ ] **Step 4: Commit**

```bash
git add src/lib/tabs.ts src/lib/tabs.test.ts
git commit -m "feat: add filePath, isDirty, markClean to Tab type"
```

---

## Task 4: Rewrite TabsContext (file-first)

**Files:**
- Modify: `src/context/TabsContext.tsx`
- Modify: `src/App.tsx`

- [ ] **Step 1: Replace TabsContext.tsx**

```typescript
import { createContext, useContext, useState, useCallback, useEffect, useRef } from 'react'
import { invoke } from '@tauri-apps/api/core'
import type { Tab } from '@/lib/tabs'

interface QueryFileMeta {
  name: string
  path: string
}

interface TabsContextValue {
  tabs: Tab[]
  activeId: number
  restored: boolean
  setActiveId: (id: number) => void
  openQueryTab: () => Promise<void>
  closeTab: (id: number) => void
  updateContent: (id: number, content: string) => void
  renameTab: (id: number, newTitle: string) => Promise<void>
  reloadTabs: () => Promise<void>
}

const TabsContext = createContext<TabsContextValue>(null!)
let nextId = 1

export function TabsProvider({ children }: { children: React.ReactNode }) {
  const [tabs, setTabs] = useState<Tab[]>([])
  const [activeId, setActiveIdState] = useState(0)
  const [restored, setRestored] = useState(false)
  const saveTimers = useRef(new Map<number, ReturnType<typeof setTimeout>>())
  const tabsRef = useRef<Tab[]>([])

  // Keep tabsRef in sync so callbacks can read current tabs without stale closures
  useEffect(() => { tabsRef.current = tabs }, [tabs])

  const loadTabs = useCallback(async () => {
    saveTimers.current.forEach(t => clearTimeout(t))
    saveTimers.current.clear()
    setRestored(false)

    try {
      const files = await invoke<QueryFileMeta[]>('list_query_files')

      if (files.length === 0) {
        const dir = await invoke<string>('get_queries_dir')
        const filePath = `${dir}/Query 1.sql`
        await invoke('write_query_file', { path: filePath, content: '' })
        nextId = 2
        setTabs([{ id: 1, title: 'Query 1', filePath, content: '', isDirty: false }])
        setActiveIdState(1)
      } else {
        const loadedTabs: Tab[] = await Promise.all(
          files.map(async (f, i) => {
            const id = i + 1
            const content = await invoke<string>('read_query_file', { path: f.path })
            return { id, title: f.name, filePath: f.path, content, isDirty: false }
          })
        )
        nextId = loadedTabs.length + 1
        setTabs(loadedTabs)

        const activeFile = await invoke<string | null>('get_setting', { key: 'active_query_file' })
        const activeTab = loadedTabs.find(t => t.title === activeFile) ?? loadedTabs[0]
        setActiveIdState(activeTab.id)
      }
    } catch (e) {
      console.error('Session restore failed:', e)
      setTabs([{ id: 1, title: 'Query 1', filePath: '', content: '', isDirty: false }])
      setActiveIdState(1)
      nextId = 2
    } finally {
      setRestored(true)
    }
  }, [])

  useEffect(() => { loadTabs() }, [loadTabs])

  const setActiveId = useCallback((id: number) => {
    setActiveIdState(id)
    const tab = tabsRef.current.find(t => t.id === id)
    if (tab) {
      invoke('set_setting', { key: 'active_query_file', value: tab.title }).catch(() => {})
    }
  }, [])

  const openQueryTab = useCallback(async () => {
    try {
      const dir = await invoke<string>('get_queries_dir')
      const existing = new Set(tabsRef.current.map(t => t.title))
      let n = tabsRef.current.length + 1
      while (existing.has(`Query ${n}`)) n++
      const title = `Query ${n}`
      const filePath = `${dir}/${title}.sql`
      await invoke('write_query_file', { path: filePath, content: '' })
      const id = nextId++
      setTabs(prev => [...prev, { id, title, filePath, content: '', isDirty: false }])
      setActiveIdState(id)
      invoke('set_setting', { key: 'active_query_file', value: title }).catch(() => {})
    } catch (e) {
      console.error('Failed to create query tab:', e)
    }
  }, [])

  const closeTab = useCallback((id: number) => {
    const existing = saveTimers.current.get(id)
    if (existing) clearTimeout(existing)
    saveTimers.current.delete(id)

    const current = tabsRef.current
    if (current.length <= 1) return
    const idx = current.findIndex(t => t.id === id)
    const next = current.filter(t => t.id !== id)
    setTabs(next)

    if (id === activeId) {
      const newActive = next[Math.min(idx, next.length - 1)]
      setActiveIdState(newActive.id)
      invoke('set_setting', { key: 'active_query_file', value: newActive.title }).catch(() => {})
    }
  }, [activeId])

  const updateContent = useCallback((id: number, content: string) => {
    setTabs(prev => prev.map(t => t.id === id ? { ...t, content, isDirty: true } : t))

    const existing = saveTimers.current.get(id)
    if (existing) clearTimeout(existing)

    const timer = setTimeout(async () => {
      saveTimers.current.delete(id)
      const tab = tabsRef.current.find(t => t.id === id)
      if (!tab || !tab.filePath) return
      try {
        await invoke('write_query_file', { path: tab.filePath, content })
        setTabs(prev => prev.map(t => t.id === id ? { ...t, isDirty: false } : t))
      } catch (e) {
        console.error(`Save failed for tab ${id}:`, e)
        // isDirty stays true — content still in memory
      }
    }, 800)

    saveTimers.current.set(id, timer)
  }, [])

  const renameTab = useCallback(async (id: number, newTitle: string) => {
    const tab = tabsRef.current.find(t => t.id === id)
    if (!tab || tab.title === newTitle || !newTitle.trim()) return
    const dir = tab.filePath.substring(0, tab.filePath.lastIndexOf('/'))
    const newPath = `${dir}/${newTitle}.sql`
    try {
      await invoke('rename_query_file', { oldPath: tab.filePath, newPath })
      setTabs(prev => prev.map(t => t.id === id ? { ...t, title: newTitle, filePath: newPath } : t))
      invoke('set_setting', { key: 'active_query_file', value: newTitle }).catch(() => {})
    } catch (e) {
      console.error('Rename failed:', e)
      // title reverts — state unchanged
    }
  }, [])

  return (
    <TabsContext.Provider value={{
      tabs, activeId, restored,
      setActiveId, openQueryTab, closeTab, updateContent, renameTab, reloadTabs: loadTabs,
    }}>
      {children}
    </TabsContext.Provider>
  )
}

export const useTabs = () => useContext(TabsContext)
```

- [ ] **Step 2: Update App.tsx to use inner AppShell for `restored`**

```typescript
import { useState } from 'react'
import ActivityBar from '@/components/ActivityBar'
import Sidebar from '@/components/Sidebar'
import EditorTabs from '@/components/EditorTabs'
import SettingsTab from '@/components/SettingsTab'
import StatusBar from '@/components/StatusBar'
import { TabsProvider, useTabs } from '@/context/TabsContext'

export type AppView = 'editor' | 'settings'

function AppShell() {
  const [view, setView] = useState<AppView>('editor')
  const { restored } = useTabs()

  return (
    <div className="flex flex-col h-screen w-screen overflow-hidden bg-th-bg text-th-text">
      <div className="flex flex-1 min-h-0">
        <ActivityBar view={view} setView={setView} />
        {view === 'editor' && <Sidebar />}
        <main className="flex flex-col flex-1 min-w-0 relative">
          <div className={`absolute inset-0 flex-col ${view === 'editor' ? 'flex' : 'hidden'}`}>
            {restored && <EditorTabs />}
          </div>
          {view === 'settings' && <SettingsTab />}
        </main>
      </div>
      <StatusBar />
    </div>
  )
}

export default function App() {
  return (
    <TabsProvider>
      <AppShell />
    </TabsProvider>
  )
}
```

- [ ] **Step 3: Commit**

```bash
git add src/context/TabsContext.tsx src/App.tsx
git commit -m "feat: file-first TabsContext with per-tab auto-save, isDirty, renameTab"
```

---

## Task 5: Dot indicator and inline rename in EditorTabs

**Files:**
- Modify: `src/components/EditorTabs.tsx`

- [ ] **Step 1: Replace EditorTabs.tsx**

```typescript
import { useEffect, useState } from 'react'
import { X } from 'lucide-react'
import { useTabs } from '@/context/TabsContext'
import SqlEditor from '@/components/SqlEditor'

export default function EditorTabs() {
  const { tabs, activeId, setActiveId, openQueryTab, closeTab, updateContent, renameTab } = useTabs()
  const [editingId, setEditingId] = useState<number | null>(null)
  const [editTitle, setEditTitle] = useState('')

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey) {
        if (e.key === 't') { e.preventDefault(); openQueryTab() }
        if (e.key === 'w') { e.preventDefault(); closeTab(activeId) }
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [openQueryTab, closeTab, activeId])

  const startRename = (id: number, currentTitle: string) => {
    setEditingId(id)
    setEditTitle(currentTitle)
  }

  const commitRename = async () => {
    if (editingId !== null) {
      const fallback = tabs.find(t => t.id === editingId)?.title ?? ''
      await renameTab(editingId, editTitle.trim() || fallback)
    }
    setEditingId(null)
  }

  const active = tabs.find(t => t.id === activeId)

  return (
    <div className="flex flex-col flex-1 min-h-0">
      <div className="flex items-center overflow-x-auto shrink-0 bg-th-tab-inactive border-b border-b-th-border">
        {tabs.map(tab => {
          const isActive = tab.id === activeId
          const isEditing = editingId === tab.id
          return (
            <button
              key={tab.id}
              onClick={() => setActiveId(tab.id)}
              onDoubleClick={() => startRename(tab.id, tab.title)}
              className={`group flex items-center h-9 px-4 gap-2 text-[13px] cursor-pointer select-none shrink-0 transition-colors rounded-none border-r border-r-th-border border-t
                ${isActive
                  ? 'bg-th-tab-active text-th-bright border-t-th-accent'
                  : 'bg-transparent text-th-dim border-t-transparent hover:text-th-text hover:bg-th-hover'}`}
            >
              {tab.isDirty && (
                <span className="text-th-dim text-[10px] leading-none">●</span>
              )}
              {isEditing ? (
                <input
                  autoFocus
                  value={editTitle}
                  onChange={e => setEditTitle(e.target.value)}
                  onBlur={commitRename}
                  onKeyDown={e => {
                    if (e.key === 'Enter') commitRename()
                    if (e.key === 'Escape') setEditingId(null)
                  }}
                  onClick={e => e.stopPropagation()}
                  className="bg-transparent outline outline-1 outline-th-accent text-th-bright px-1 w-24 text-[13px]"
                />
              ) : (
                <span className="shrink-0">{tab.title}</span>
              )}
              <span className="w-4 h-4 flex items-center justify-center shrink-0">
                {tabs.length > 1 && (
                  <span
                    role="button"
                    aria-label={`Close ${tab.title}`}
                    className="flex items-center justify-center w-4 h-4 rounded opacity-0 group-hover:opacity-100 transition-opacity text-th-dim hover:text-th-text"
                    onClick={e => { e.stopPropagation(); closeTab(tab.id) }}
                  >
                    <X size={12} />
                  </span>
                )}
              </span>
            </button>
          )
        })}
        <button
          onClick={openQueryTab}
          className="flex items-center justify-center w-9 h-9 shrink-0 text-lg transition-colors rounded-none text-th-dim hover:text-th-text hover:bg-th-hover"
        >
          +
        </button>
      </div>

      <div className="relative flex-1 min-h-0 bg-th-bg">
        {active && (
          <SqlEditor
            key={active.id}
            value={active.content}
            onChange={v => updateContent(active.id, v)}
          />
        )}
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Commit**

```bash
git add src/components/EditorTabs.tsx
git commit -m "feat: add saved indicator dot and double-click rename on tabs"
```

---

## Task 6: Settings — queries directory section

**Files:**
- Modify: `src/components/SettingsTab.tsx`

- [ ] **Step 1: Add state + load + save logic to SettingsTab**

At the top of the `SettingsTab` function, after the existing state declarations, add:

```typescript
const { reloadTabs } = useTabs()
const [queriesDir, setQueriesDir] = useState('')
const [dirInput, setDirInput] = useState('')
const [dirSaving, setDirSaving] = useState(false)
const [dirError, setDirError] = useState<string | null>(null)

useEffect(() => {
  invoke<string>('get_queries_dir')
    .then(dir => { setQueriesDir(dir); setDirInput(dir) })
    .catch(() => {})
}, [])

const saveDir = async () => {
  const trimmed = dirInput.trim()
  if (!trimmed || trimmed === queriesDir) return
  setDirSaving(true)
  setDirError(null)
  try {
    await invoke('set_queries_dir', { path: trimmed })
    setQueriesDir(trimmed)
    await reloadTabs()
  } catch (e) {
    setDirError(String(e))
  } finally {
    setDirSaving(false)
  }
}
```

- [ ] **Step 2: Add `useTabs` import to SettingsTab.tsx**

At the top of the file, add:
```typescript
import { useTabs } from '@/context/TabsContext'
```

- [ ] **Step 3: Add "Queries Directory" section to the left panel**

In the JSX, after the closing `</div>` of the `allThemes.map` list (still inside the left panel `<div className="flex flex-col w-56 ...">`), add:

```tsx
<div className="px-4 pt-4 pb-4 border-t border-t-th-border mt-2">
  <SectionHeader label="Queries Directory" />
  <div className="mt-2 flex flex-col gap-1.5">
    <input
      className="w-full h-7 px-2 text-[12px] rounded bg-th-bg border border-th-border text-th-text outline-none focus:border-th-accent font-mono"
      value={dirInput}
      onChange={e => setDirInput(e.target.value)}
      onKeyDown={e => { if (e.key === 'Enter') saveDir() }}
      spellCheck={false}
    />
    <button
      onClick={saveDir}
      disabled={dirSaving || dirInput.trim() === queriesDir}
      className="self-start h-[26px] px-3 text-[12px] rounded border border-th-accent text-th-accent hover:bg-th-accent hover:text-th-bright transition-colors disabled:opacity-40 disabled:cursor-default"
    >
      {dirSaving ? 'Saving…' : 'Set'}
    </button>
    {dirError && (
      <p className="text-[11px] text-th-err">{dirError}</p>
    )}
  </div>
</div>
```

- [ ] **Step 4: Run the app and verify the full feature**

```bash
npm run tauri dev
```

Manual checks:
1. App opens → loads from `~/Documents/Crabeaver/queries/` → creates `Query 1.sql` if dir was empty
2. Typing in editor → `●` appears on tab immediately
3. Stop typing for 800ms → `●` disappears; verify `Query 1.sql` is updated in Finder
4. Check `~/Documents/Crabeaver/queries/.history/Query 1/` contains a timestamped snapshot
5. Double-click a tab title → inline input appears → type new name → Enter → file renamed on disk, history folder renamed
6. Settings → "Queries Directory" section shows current path; change path + Set → tabs reload from new dir

- [ ] **Step 5: Commit**

```bash
git add src/components/SettingsTab.tsx
git commit -m "feat: add queries directory setting with live reload"
```
