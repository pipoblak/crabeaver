# MCP Context (Global Prompt + Per-Connection Notes) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add user-authored context to the existing Crabeaver MCP server — a global server prompt sent as MCP `initialize.instructions`, and a per-connection note exposed in `list_connections` / `describe_table` — editable from both the sidebar MCP panel and a new Settings → MCP section.

**Architecture:** The MCP server is already built, committed, and tested (backend gate/tools/HTTP server, frontend `McpPanel` + `useMcp`, `mcp_http.rs` + `mcp_disaster.rs`). This plan implements only the **context delta** from the approved spec. Storage reuses the existing `settings` key/value table (global prompt) and the existing JSON-serialized per-connection flags map (note). No new SQL surface, no protocol changes beyond adding `instructions`.

**Tech Stack:** Rust (Tauri v2, axum, sqlx/SQLite, sqlparser), React + TypeScript.

---

## Context: What Already Exists

Do **not** rebuild these — they are done and tested:

- `src-tauri/src/domain/mcp.rs` — `McpConnFlags { expose, allow_write }` (Copy), `SqlKind`, `McpStatus`, `McpActivityEntry`.
- `src-tauri/src/application/mcp.rs` — settings I/O, token, `classify`, `authorize`, `with_limit`, tools `tool_list_connections` / `tool_list_databases` / `tool_list_schemas` / `tool_describe_table` / `tool_run_query`, plus unit tests.
- `src-tauri/src/infrastructure/mcp/{server,auth,clients}.rs` — JSON-RPC over axum, bearer auth, client setup registry.
- `src-tauri/src/commands/mcp.rs` — `mcp_status/start/stop/rotate_token/get_token/set_port/set_connection_flags/connection_flags/list_clients/setup_client/recent_activity`, all registered in `lib.rs`.
- `src/hooks/useMcp.ts`, `src/components/McpPanel.tsx`, `ActivityBar.tsx` (MCP icon), `App.tsx` (panel wired).
- Tests `src-tauri/tests/mcp_http.rs`, `src-tauri/tests/mcp_disaster.rs`.

## File Structure (this plan)

- **Modify** `src-tauri/src/domain/mcp.rs` — add `note` to `McpConnFlags` (drop `Copy`); add `global_prompt` to `McpStatus`.
- **Modify** `src-tauri/src/application/mcp.rs` — global-prompt storage; note-preserving flag setters; `ExposedConn.context`; note in `describe_table`; fix `.copied()` ripple; tests.
- **Modify** `src-tauri/src/infrastructure/mcp/server.rs` — include `instructions` in `initialize`.
- **Modify** `src-tauri/src/commands/mcp.rs` — `global_prompt` in status; new `mcp_set_global_prompt` + `mcp_set_connection_note`; route flag setter through note-preserving helper.
- **Modify** `src-tauri/src/lib.rs` — register the two new commands.
- **Modify** `src-tauri/tests/mcp_http.rs` — assert `initialize` returns `instructions`.
- **Modify** `src/hooks/useMcp.ts` — types + `setGlobalPrompt` / `setConnNote`.
- **Modify** `src/components/McpPanel.tsx` — global-prompt editor + per-connection note input.
- **Create** `src/components/settings/McpSection.tsx` — Settings → MCP form (same hook).
- **Modify** `src/components/SettingsTab.tsx` — register the MCP section.

---

### Task 1: Add `note` to flags + global-prompt storage (domain + application)

**Files:**
- Modify: `src-tauri/src/domain/mcp.rs`
- Modify: `src-tauri/src/application/mcp.rs`
- Test: `src-tauri/src/application/mcp.rs` (inline `#[cfg(test)]`)

- [ ] **Step 1: Update the domain struct**

In `src-tauri/src/domain/mcp.rs`, replace the `McpConnFlags` definition (drop `Copy`, add `note`):

```rust
/// Per-connection MCP exposure flags + user note.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct McpConnFlags {
    pub expose: bool,
    pub allow_write: bool,
    /// Free-text context shown to the agent in `list_connections` / `describe_table`.
    #[serde(default)]
    pub note: String,
}
```

And add `global_prompt` to `McpStatus`:

```rust
/// Server status reported to the sidebar.
#[derive(Debug, Clone, Serialize)]
pub struct McpStatus {
    pub running: bool,
    pub port: u16,
    pub url: String,
    pub has_token: bool,
    pub global_prompt: String,
}
```

- [ ] **Step 2: Fix the `.copied()` ripple in application**

In `src-tauri/src/application/mcp.rs`, `tool_list_connections` reads flags with `.copied()`, which no longer compiles. Change line:

```rust
            let cf = f.get(&c.id).copied().unwrap_or_default();
```
to:
```rust
            let cf = f.get(&c.id).cloned().unwrap_or_default();
```

- [ ] **Step 3: Add global-prompt + note-preserving setters (write the code)**

In `src-tauri/src/application/mcp.rs`, add a `KEY_PROMPT` const next to the others:

```rust
const KEY_PROMPT: &str = "mcp_global_prompt";
```

Add these functions after `set_flags`:

```rust
pub async fn global_prompt(state: &AppState) -> String {
    get(state, KEY_PROMPT).await.unwrap_or_default()
}

pub async fn set_global_prompt(state: &AppState, prompt: &str) {
    set(state, KEY_PROMPT, prompt).await
}

/// Set expose/allow_write while preserving the existing note.
pub async fn set_conn_flags(state: &AppState, id: &str, expose: bool, allow_write: bool) {
    let mut map = flags(state).await;
    let note = map.get(id).map(|f| f.note.clone()).unwrap_or_default();
    map.insert(id.to_string(), McpConnFlags { expose, allow_write, note });
    if let Ok(json) = serde_json::to_string(&map) {
        set(state, KEY_FLAGS, &json).await
    }
}

/// Set the note while preserving expose/allow_write.
pub async fn set_conn_note(state: &AppState, id: &str, note: &str) {
    let mut map = flags(state).await;
    let entry = map.entry(id.to_string()).or_default();
    entry.note = note.to_string();
    if let Ok(json) = serde_json::to_string(&map) {
        set(state, KEY_FLAGS, &json).await
    }
}
```

- [ ] **Step 4: Fix the existing test struct literals**

In the `#[cfg(test)]` module of `src-tauri/src/application/mcp.rs`, two helpers build `McpConnFlags { expose, allow_write }` which now misses `note`. Update:

`flags_of`:
```rust
    fn flags_of(expose: bool, allow_write: bool) -> HashMap<String, McpConnFlags> {
        let mut m = HashMap::new();
        m.insert("c1".to_string(), McpConnFlags { expose, allow_write, note: String::new() });
        m
    }
```

`flags_roundtrip_through_json_map`:
```rust
        map.insert("c1".to_string(), McpConnFlags { expose: true, allow_write: false, note: String::new() });
```

- [ ] **Step 5: Write the failing test for note preservation + global prompt**

Add to the `#[cfg(test)]` module. These need a real `AppState`; mirror the setup `mcp_disaster.rs` uses (in-memory SQLite + migrations). Add this test that exercises persistence:

```rust
    #[tokio::test]
    async fn note_and_flags_are_independent_and_global_prompt_persists() {
        let state = crate::test_support::mem_state().await;
        set_conn_flags(&state, "c1", true, false).await;
        set_conn_note(&state, "c1", "billing prod").await;
        // setting flags again must not wipe the note
        set_conn_flags(&state, "c1", true, true).await;
        let f = flags(&state).await;
        let c1 = f.get("c1").unwrap();
        assert!(c1.expose && c1.allow_write);
        assert_eq!(c1.note, "billing prod");
        // setting the note must not wipe flags
        set_conn_note(&state, "c1", "still here").await;
        let f2 = flags(&state).await;
        assert!(f2.get("c1").unwrap().expose);
        assert_eq!(f2.get("c1").unwrap().note, "still here");
        // global prompt roundtrip
        assert_eq!(global_prompt(&state).await, "");
        set_global_prompt(&state, "DBs of company X").await;
        assert_eq!(global_prompt(&state).await, "DBs of company X");
    }
```

This references a shared `test_support::mem_state()` helper. If it does not already exist, create `src-tauri/src/test_support.rs` with:

```rust
//! Test-only helpers. Compiled for unit tests and integration tests.
#![cfg(any(test, feature = "test-support"))]
use std::collections::{HashMap, VecDeque};
use std::sync::Arc;

use crate::infrastructure::database::{registry::DriverRegistry, AppState};

/// An AppState backed by a fresh in-memory SQLite DB with migrations applied.
pub async fn mem_state() -> AppState {
    let pool = sqlx::SqlitePool::connect("sqlite::memory:").await.unwrap();
    sqlx::migrate!("./migrations").run(&pool).await.unwrap();
    AppState {
        db: pool,
        drivers: DriverRegistry::new(),
        biometric_cache: Arc::new(tokio::sync::Mutex::new(HashMap::new())),
        biometric_lock: Arc::new(tokio::sync::Mutex::new(())),
        schema_indices: Arc::new(std::sync::RwLock::new(HashMap::new())),
        mcp_shutdown: Arc::new(tokio::sync::Mutex::new(None)),
        mcp_activity: Arc::new(std::sync::Mutex::new(VecDeque::new())),
    }
}
```

and declare it in `src-tauri/src/lib.rs` near the other `pub mod` lines:

```rust
#[cfg(any(test, feature = "test-support"))]
pub mod test_support;
```

> Note: check `mcp_disaster.rs` first — it already constructs an in-memory `AppState`. If it has a local helper you can promote, reuse that exact field set instead of duplicating. The `AppState` field list MUST match `lib.rs` exactly (it is the source of truth).

- [ ] **Step 6: Run the test — expect FAIL then PASS**

Run: `cd src-tauri && cargo test --lib mcp::tests::note_and_flags`
Expected: first FAIL (functions/fields missing) until Steps 1–5 compile, then PASS.

- [ ] **Step 7: Run the whole MCP unit suite**

Run: `cd src-tauri && cargo test --lib mcp`
Expected: PASS (all existing gate/classify/token tests still green).

- [ ] **Step 8: Commit**

```bash
git add src-tauri/src/domain/mcp.rs src-tauri/src/application/mcp.rs src-tauri/src/lib.rs src-tauri/src/test_support.rs
git commit -m "feat(mcp): per-connection note + global prompt storage"
```

---

### Task 2: Surface context in tools (`list_connections` + `describe_table`)

**Files:**
- Modify: `src-tauri/src/application/mcp.rs`
- Test: `src-tauri/src/application/mcp.rs`

- [ ] **Step 1: Add `context` to `ExposedConn`**

In `src-tauri/src/application/mcp.rs`, extend the struct:

```rust
#[derive(Serialize)]
pub struct ExposedConn {
    pub id: String,
    pub name: String,
    pub engine: String,
    pub database: String,
    pub write_allowed: bool,
    pub context: String,
}
```

- [ ] **Step 2: Populate `context` in `tool_list_connections`**

In the `Some(ExposedConn { … })` literal, add the note:

```rust
            Some(ExposedConn {
                id: c.id,
                name: c.name,
                engine: c.driver,
                database: c.database,
                write_allowed: cf.allow_write,
                context: cf.note.clone(),
            })
```

- [ ] **Step 3: Add the connection note to `describe_table` output**

Replace the body of `tool_describe_table` so it injects the note (only when non-empty) without changing the existing shape on the happy path:

```rust
pub async fn tool_describe_table(
    state: &AppState,
    connection_id: &str,
    schema: &str,
    table: &str,
) -> Result<serde_json::Value, String> {
    require_exposed(state, connection_id).await.map_err(|e| e.message().to_string())?;
    let d = introspection::table_details(state, connection_id, schema, table)
        .await
        .map_err(|e| e.to_string())?;
    let mut val = serde_json::to_value(d).map_err(|e| e.to_string())?;
    let note = flags(state).await.get(connection_id).map(|f| f.note.clone()).unwrap_or_default();
    if !note.is_empty() {
        if let Some(obj) = val.as_object_mut() {
            obj.insert("connection_note".into(), serde_json::Value::String(note));
        }
    }
    Ok(val)
}
```

- [ ] **Step 4: Write the failing test**

Add to the `#[cfg(test)]` module:

```rust
    #[tokio::test]
    async fn list_connections_includes_context_for_exposed_only() {
        let state = crate::test_support::mem_state().await;
        // Insert a connection row the connections use case can read.
        sqlx::query("INSERT INTO connections (id,name,driver,host,port,username,database) VALUES (?,?,?,?,?,?,?)")
            .bind("c1").bind("Local").bind("sqlite").bind("").bind(0i64).bind("").bind("dev.db")
            .execute(&state.db).await.unwrap();
        set_conn_flags(&state, "c1", true, false).await;
        set_conn_note(&state, "c1", "sandbox").await;

        let list = tool_list_connections(&state).await;
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].context, "sandbox");
    }
```

> Verify the `connections` table column names against `src-tauri/migrations/` before running — adjust the INSERT to match the real schema (this is the canonical place connection rows live). If `connections::list` requires more columns, add them to the INSERT.

- [ ] **Step 5: Run the test**

Run: `cd src-tauri && cargo test --lib mcp::tests::list_connections_includes_context`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/application/mcp.rs
git commit -m "feat(mcp): expose connection note as context in list_connections + describe_table"
```

---

### Task 3: Send the global prompt as `initialize.instructions`

**Files:**
- Modify: `src-tauri/src/infrastructure/mcp/server.rs`
- Test: `src-tauri/tests/mcp_http.rs`

- [ ] **Step 1: Build the `initialize` result from the global prompt**

In `src-tauri/src/infrastructure/mcp/server.rs`, the `initialize` arm is currently a static `json!`. Replace it so it includes `instructions` when the prompt is non-empty. Change the match arm:

```rust
        "initialize" => {
            let prompt = app::global_prompt(&ctx.state).await;
            let mut result = json!({
                "protocolVersion": "2025-03-26",
                "serverInfo": { "name": "crabeaver", "version": env!("CARGO_PKG_VERSION") },
                "capabilities": { "tools": {} }
            });
            if !prompt.is_empty() {
                result.as_object_mut().unwrap().insert("instructions".into(), json!(prompt));
            }
            Ok(result)
        }
```

(`app` is already imported as `crate::application::mcp as app`; `ctx.state` is in scope.)

- [ ] **Step 2: Write the failing integration test**

In `src-tauri/tests/mcp_http.rs`, add a test that sets a prompt, starts the server, and checks `initialize`. Reuse the existing harness in that file (it already builds an `AppState`, starts `server::start`, and POSTs JSON-RPC — follow the existing test's exact pattern for state construction, token, and request shape). Add:

```rust
#[tokio::test]
async fn initialize_includes_global_prompt_as_instructions() {
    // Arrange: state with a global prompt set.
    let state = /* same in-memory AppState construction as the other tests in this file */;
    crabeaver_lib::application::mcp::set_global_prompt(&state, "house rules").await;
    let token = crabeaver_lib::application::mcp::ensure_token(&state).await;

    // Start the server (mirror the existing test's start() call + sink).
    let shared = std::sync::Arc::new(state);
    let sink: crabeaver_lib::infrastructure::mcp::server::ActivitySink = std::sync::Arc::new(|_| {});
    let (port, _tx) = server::start(shared, 0, token.clone(), sink).await.unwrap();
    let url = format!("http://127.0.0.1:{port}/mcp");

    // Act: initialize.
    let client = reqwest::Client::new();
    let resp = client.post(&url)
        .header("Authorization", format!("Bearer {token}"))
        .json(&serde_json::json!({ "jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {} }))
        .send().await.unwrap()
        .json::<serde_json::Value>().await.unwrap();

    // Assert.
    assert_eq!(resp["result"]["instructions"], serde_json::json!("house rules"));
}
```

> Match the in-memory `AppState` construction to whatever `mcp_http.rs` already does at the top of the file — do not invent a different field set.

- [ ] **Step 3: Run the test**

Run: `cd src-tauri && cargo test --test mcp_http initialize_includes_global_prompt`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/infrastructure/mcp/server.rs src-tauri/tests/mcp_http.rs
git commit -m "feat(mcp): send global prompt as initialize.instructions"
```

---

### Task 4: Commands — status field + new setters, note-preserving flags

**Files:**
- Modify: `src-tauri/src/commands/mcp.rs`
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: Add a status builder that includes `global_prompt`**

In `src-tauri/src/commands/mcp.rs`, the three `McpStatus { … }` literals (`mcp_status`, `mcp_start`, `mcp_stop`) now miss `global_prompt`. Add a small helper and use it. Add near `fn url`:

```rust
async fn status_of(state: &AppState, running: bool, port: u16) -> McpStatus {
    McpStatus {
        running,
        port,
        url: url(port),
        has_token: app::token(state).await.is_some(),
        global_prompt: app::global_prompt(state).await,
    }
}
```

Then replace the bodies:

`mcp_status`:
```rust
#[tauri::command]
pub async fn mcp_status(state: State<'_, AppState>) -> Result<McpStatus, String> {
    let running = state.mcp_shutdown.lock().await.is_some();
    let port = app::port(&state).await;
    Ok(status_of(&state, running, port).await)
}
```

`mcp_start` — keep the existing start logic, but change the final `Ok(McpStatus { … })` to:
```rust
    *state.mcp_shutdown.lock().await = Some(tx);
    Ok(status_of(&state, true, bound).await)
```

`mcp_stop`:
```rust
#[tauri::command]
pub async fn mcp_stop(state: State<'_, AppState>) -> Result<McpStatus, String> {
    if let Some(tx) = state.mcp_shutdown.lock().await.take() {
        let _ = tx.send(());
    }
    let port = app::port(&state).await;
    Ok(status_of(&state, false, port).await)
}
```

- [ ] **Step 2: Route the flag setter through the note-preserving helper**

Replace `mcp_set_connection_flags` body so it preserves the note (it currently builds a fresh `McpConnFlags`, which would wipe the note):

```rust
#[tauri::command]
pub async fn mcp_set_connection_flags(
    state: State<'_, AppState>,
    connection_id: String,
    expose: bool,
    allow_write: bool,
) -> Result<(), String> {
    app::set_conn_flags(&state, &connection_id, expose, allow_write).await;
    Ok(())
}
```

Remove the now-unused `McpConnFlags` import if the compiler warns (`use crate::domain::mcp::{McpActivityEntry, McpConnFlags, McpStatus};` → drop `McpConnFlags` if unused).

- [ ] **Step 3: Add the two new commands**

Append to `src-tauri/src/commands/mcp.rs`:

```rust
#[tauri::command]
pub async fn mcp_set_global_prompt(state: State<'_, AppState>, prompt: String) -> Result<(), String> {
    app::set_global_prompt(&state, &prompt).await;
    Ok(())
}

#[tauri::command]
pub async fn mcp_set_connection_note(
    state: State<'_, AppState>,
    connection_id: String,
    note: String,
) -> Result<(), String> {
    app::set_conn_note(&state, &connection_id, &note).await;
    Ok(())
}
```

- [ ] **Step 4: Register the new commands in `lib.rs`**

In `src-tauri/src/lib.rs`, add to the `use commands::mcp::{ … }` import list: `mcp_set_global_prompt, mcp_set_connection_note`. Then add them to the `// MCP server` block of `tauri::generate_handler![ … ]`:

```rust
            mcp_set_global_prompt, mcp_set_connection_note,
```

- [ ] **Step 5: Build to verify the whole backend compiles**

Run: `cd src-tauri && cargo build`
Expected: compiles clean (no missing-field, no unused-import errors).

- [ ] **Step 6: Run the full Rust test suite**

Run: `cd src-tauri && cargo test`
Expected: all green, including `mcp_disaster` and `mcp_http`.

> If `mcp_disaster.rs` constructs `McpConnFlags { expose, allow_write }` literals, they will fail to compile — add `note: String::new()` (or `..Default::default()`) to each. Fix inline; this is expected ripple.

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/commands/mcp.rs src-tauri/src/lib.rs src-tauri/tests/mcp_disaster.rs
git commit -m "feat(mcp): status global_prompt + set_global_prompt/set_connection_note commands"
```

---

### Task 5: Frontend hook — types + setters

**Files:**
- Modify: `src/hooks/useMcp.ts`

- [ ] **Step 1: Extend the types**

In `src/hooks/useMcp.ts`, update the interfaces:

```ts
export interface McpStatus { running: boolean; port: number; url: string; has_token: boolean; global_prompt: string }
export type ConnFlags = Record<string, { expose: boolean; allow_write: boolean; note: string }>
```

- [ ] **Step 2: Add the setters**

Add two callbacks alongside `setConnFlags`:

```ts
  const setGlobalPrompt = useCallback(async (prompt: string) => {
    await invoke('mcp_set_global_prompt', { prompt }); await refresh()
  }, [refresh])
  const setConnNote = useCallback(async (connectionId: string, note: string) => {
    await invoke('mcp_set_connection_note', { connectionId, note }); await refresh()
  }, [refresh])
```

And include them in the returned object:

```ts
  return { status, token, clients, flags, activity, refresh, start, stop, rotate, setPort, setupClient, setConnFlags, setGlobalPrompt, setConnNote }
```

- [ ] **Step 3: Type-check**

Run: `npm run build`
Expected: `tsc -b` passes (no type errors).

- [ ] **Step 4: Commit**

```bash
git add src/hooks/useMcp.ts
git commit -m "feat(mcp): useMcp setters for global prompt + connection note"
```

---

### Task 6: Sidebar panel — global-prompt editor + per-connection note

**Files:**
- Modify: `src/components/McpPanel.tsx`

- [ ] **Step 1: Pull the new hook values**

In `src/components/McpPanel.tsx`, update the destructure:

```tsx
  const { status, token, clients, flags, activity, start, stop, rotate, setupClient, setConnFlags, setGlobalPrompt, setConnNote } = useMcp()
```

- [ ] **Step 2: Add a debounced, controlled `NoteField` component**

Add at the bottom of the file (a small uncontrolled-on-blur editor avoids a round-trip per keystroke):

```tsx
function NoteField({ value, placeholder, onSave, multiline }: {
  value: string; placeholder: string; onSave: (v: string) => void; multiline?: boolean
}) {
  const [draft, setDraft] = useState(value)
  useEffect(() => { setDraft(value) }, [value])
  const commit = () => { if (draft !== value) onSave(draft) }
  const common = {
    value: draft,
    placeholder,
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setDraft(e.target.value),
    onBlur: commit,
    className: 'w-full text-[11px] rounded px-1.5 py-1 outline-none resize-none',
    style: { background: 'var(--sidebar-bg)', border: '1px solid var(--border)', color: 'var(--text)' },
  }
  return multiline
    ? <textarea {...common} rows={2} />
    : <input {...common} onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }} />
}
```

Add the `useEffect` import at the top:

```tsx
import { useState, useEffect } from 'react'
```

- [ ] **Step 3: Add a "Server prompt" section after the Endpoint block**

Immediately after the Endpoint `</div>` (the block bordered below the token row), insert:

```tsx
        {/* Server prompt */}
        <Section title="Server prompt">
          <div className="px-3 py-1.5">
            <NoteField
              value={status?.global_prompt ?? ''}
              placeholder="Context for every client (initialize.instructions)…"
              onSave={setGlobalPrompt}
              multiline
            />
          </div>
        </Section>
```

- [ ] **Step 4: Add the per-connection note under each connection row**

In the Connections `Section`, the current map renders one flex row per connection. Wrap each connection's row + a note field in a column. Replace the inner `return ( <div … flex items-center …> … </div> )` for each connection with:

```tsx
            return (
              <div key={c.id} className="flex flex-col gap-1 px-3 py-1.5" style={{ borderBottom: '1px solid var(--border)' }}>
                <div className="flex items-center gap-2 text-[12px]">
                  <label className="flex items-center gap-1 text-[11px] text-th-dim cursor-pointer">
                    <input type="checkbox" checked={f.expose}
                      onChange={e => setConnFlags(c.id, e.target.checked, e.target.checked ? f.allow_write : false)} />
                    expose
                  </label>
                  <label className="flex items-center gap-1 text-[11px] text-th-dim cursor-pointer" style={{ opacity: f.expose ? 1 : 0.4 }}>
                    <input type="checkbox" disabled={!f.expose} checked={f.allow_write}
                      onChange={e => setConnFlags(c.id, f.expose, e.target.checked)} />
                    write
                  </label>
                  <span className="flex-1 truncate text-right" style={{ color: 'var(--text)' }}>{c.name}</span>
                </div>
                {f.expose && (
                  <NoteField value={f.note ?? ''} placeholder="note for the agent…" onSave={v => setConnNote(c.id, v)} />
                )}
              </div>
            )
```

Also update the default flags fallback to include `note`:

```tsx
            const f = flags[c.id] ?? { expose: false, allow_write: false, note: '' }
```

- [ ] **Step 5: Type-check + run**

Run: `npm run build`
Expected: passes.

Then manually verify in dev (`npm run tauri dev`): open the MCP panel, type a server prompt and a per-connection note, toggle write off/on — confirm the note survives the toggle (it round-trips through `mcp_set_connection_flags` which now preserves it).

- [ ] **Step 6: Commit**

```bash
git add src/components/McpPanel.tsx
git commit -m "feat(mcp): sidebar editors for global prompt + per-connection note"
```

---

### Task 7: Settings → MCP section

**Files:**
- Create: `src/components/settings/McpSection.tsx`
- Modify: `src/components/SettingsTab.tsx`

- [ ] **Step 1: Create the section component**

Create `src/components/settings/McpSection.tsx`. It reuses `useMcp` and `useConnections`, editing the same values as the sidebar (larger editors, all connections in one list):

```tsx
import { useState, useEffect } from 'react'
import { useMcp } from '@/hooks/useMcp'
import { useConnections } from '@/context/ConnectionContext'

export default function McpSection() {
  const { status, flags, setGlobalPrompt, setConnNote, setPort } = useMcp()
  const { connections } = useConnections()

  return (
    <div className="flex flex-col h-full overflow-y-auto">
      <div style={{ padding: '16px 20px 12px', borderBottom: '1px solid var(--border)' }}>
        <p className="text-[15px] font-semibold text-th-bright">MCP Server</p>
      </div>

      <div style={{ padding: '16px 20px' }} className="flex flex-col gap-6">
        <Field label="Global server prompt" description="Sent to every client as initialize.instructions.">
          <Editor value={status?.global_prompt ?? ''} onSave={setGlobalPrompt} rows={4}
            placeholder="DBs of company X. Prefer read queries. Confirm before destructive writes…" />
        </Field>

        <Field label="Default port" description="Port the local MCP server binds (127.0.0.1).">
          <PortInput value={status?.port ?? 7300} onSave={setPort} />
        </Field>

        <Field label="Per-connection notes" description="Shown to the agent in list_connections / describe_table.">
          <div className="flex flex-col gap-3">
            {connections.length === 0 && <p className="text-[12px] text-th-dim">No connections.</p>}
            {connections.map(c => (
              <div key={c.id} className="flex flex-col gap-1">
                <span className="text-[12px] text-th-text">{c.name}{flags[c.id]?.expose ? '' : ' (not exposed)'}</span>
                <Editor value={flags[c.id]?.note ?? ''} onSave={v => setConnNote(c.id, v)} rows={2}
                  placeholder="note for the agent…" />
              </div>
            ))}
          </div>
        </Field>
      </div>
    </div>
  )
}

function Field({ label, description, children }: { label: string; description?: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-[13px] text-th-text">{label}</span>
      {description && <span className="text-[11px] text-th-dim">{description}</span>}
      {children}
    </div>
  )
}

function Editor({ value, onSave, rows, placeholder }: { value: string; onSave: (v: string) => void; rows: number; placeholder: string }) {
  const [draft, setDraft] = useState(value)
  useEffect(() => { setDraft(value) }, [value])
  return (
    <textarea
      value={draft}
      rows={rows}
      placeholder={placeholder}
      onChange={e => setDraft(e.target.value)}
      onBlur={() => { if (draft !== value) onSave(draft) }}
      className="w-full text-[12px] rounded px-2 py-1.5 outline-none resize-none"
      style={{ background: 'var(--sidebar-bg)', border: '1px solid var(--border)', color: 'var(--text)' }}
    />
  )
}

function PortInput({ value, onSave }: { value: number; onSave: (v: number) => void }) {
  const [draft, setDraft] = useState(String(value))
  useEffect(() => { setDraft(String(value)) }, [value])
  return (
    <input
      value={draft}
      inputMode="numeric"
      onChange={e => setDraft(e.target.value.replace(/[^0-9]/g, ''))}
      onBlur={() => { const n = Number(draft); if (n > 0 && n < 65536 && n !== value) onSave(n) }}
      className="w-28 text-[12px] rounded px-2 py-1.5 outline-none"
      style={{ background: 'var(--sidebar-bg)', border: '1px solid var(--border)', color: 'var(--text)' }}
    />
  )
}
```

> Verify the import path/shape of `useConnections` and the connection object's `id`/`name` fields against `src/context/ConnectionContext.tsx` (the sidebar `McpPanel` already imports `useConnections` the same way — mirror it exactly).

- [ ] **Step 2: Register the section in `SettingsTab.tsx`**

In `src/components/SettingsTab.tsx`:

Add the import:
```tsx
import McpSection from '@/components/settings/McpSection'
import { Server } from 'lucide-react'
```

Extend the `Section` type and `SECTIONS` array:
```tsx
type Section = 'themes' | 'editor' | 'connections' | 'mcp' | 'about'
```
```tsx
  { id: 'connections' as Section, label: 'Connections',  icon: Database, },
  { id: 'mcp'         as Section, label: 'MCP Server',    icon: Server,   },
  { id: 'about'       as Section, label: 'About',        icon: Info,     },
```

Add the render line next to the others:
```tsx
        {active === 'mcp'         && <McpSection />}
```

- [ ] **Step 3: Type-check + manual verify**

Run: `npm run build`
Expected: passes.

Manual (`npm run tauri dev`): Settings → MCP Server. Edit the global prompt here, switch to the sidebar MCP panel — confirm the same value shows (both read `mcp_status` / `mcp_connection_flags`). Edit a note in Settings, confirm it appears in the sidebar after refresh.

- [ ] **Step 4: Commit**

```bash
git add src/components/settings/McpSection.tsx src/components/SettingsTab.tsx
git commit -m "feat(mcp): Settings > MCP section (global prompt, port, per-connection notes)"
```

---

### Task 8 (optional): Expand one-click client targets

The spec named Claude Desktop, VS Code, opencode, and Cline; the registry currently ships Claude Code, Cursor, and Windsurf. Adding more is pure data in `json_clients()` — do this only if wanted now; copy/manual still works for the rest.

**Files:**
- Modify: `src-tauri/src/infrastructure/mcp/clients.rs`

- [ ] **Step 1: Add the straightforward `mcpServers`-shaped clients**

Extend `json_clients()` (note: Claude Desktop's path is OS-specific; resolve per `cfg!`):

```rust
fn json_clients() -> Vec<(&'static str, &'static str, Option<PathBuf>)> {
    let h = home();
    let claude_desktop = h.as_ref().map(|h| {
        if cfg!(target_os = "macos") {
            h.join("Library/Application Support/Claude/claude_desktop_config.json")
        } else {
            // Linux/Windows resolution differs; left to follow-up if those platforms ship.
            h.join(".config/Claude/claude_desktop_config.json")
        }
    });
    vec![
        ("cursor", "Cursor", h.as_ref().map(|h| h.join(".cursor/mcp.json"))),
        ("windsurf", "Windsurf", h.as_ref().map(|h| h.join(".codeium/windsurf/mcp_config.json"))),
        ("claude-desktop", "Claude Desktop", claude_desktop),
        ("vscode", "VS Code", h.as_ref().map(|h| h.join(".vscode/mcp.json"))),
        ("opencode", "opencode", h.as_ref().map(|h| h.join(".config/opencode/mcp.json"))),
    ]
}
```

> Cline stores MCP config inside VS Code extension global storage; it does not fit the simple `mcpServers` file shape, so leave it copy-only for now (do NOT fake a path it will not read — the honesty rule from the spec).

- [ ] **Step 2: Build + test**

Run: `cd src-tauri && cargo test --lib clients`
Expected: existing merge/CLI tests still PASS (no behavior change to the writer).

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/infrastructure/mcp/clients.rs
git commit -m "feat(mcp): add Claude Desktop, VS Code, opencode setup targets"
```

---

## Self-Review

- **Spec coverage** — Context section of the spec: global prompt (Task 1 storage, Task 3 instructions, Tasks 6–7 editors) ✓; per-connection note (Task 1 storage, Task 2 list_connections/describe_table, Tasks 6–7 editors) ✓; editable in sidebar AND Settings (Tasks 6, 7) ✓; commands `mcp_set_global_prompt`/`mcp_set_connection_note` (Task 4) ✓; `mcp_status.global_prompt` (Task 4) ✓; persistence with settings + connection flags (Task 1) ✓. Client-target expansion (Task 8, optional) ✓. Everything else in the spec already exists and is tested — noted at top.
- **Placeholder scan** — no TBD/TODO; every code step shows full code. Two integration tests (Task 3, and Task 2's INSERT) intentionally say "match the existing harness / verify column names" because the canonical schema lives in `migrations/` and the test harness already exists in those files — the engineer must read the real source rather than trust a guessed field set. These are verification instructions, not placeholders.
- **Type consistency** — `McpConnFlags { expose, allow_write, note }` used consistently (domain, app setters, tests, disaster test); `set_conn_flags`/`set_conn_note` names match between app (Task 1), commands (Task 4); `setGlobalPrompt`/`setConnNote` match between hook (Task 5), panel (Task 6), settings (Task 7); `mcp_set_global_prompt`/`mcp_set_connection_note` match between commands (Task 4) and hook invoke calls (Task 5); `McpStatus.global_prompt` (domain Task 1) ↔ status builder (Task 4) ↔ hook type (Task 5) ↔ UI reads (Tasks 6–7). Consistent.
