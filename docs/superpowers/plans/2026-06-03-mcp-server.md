# MCP Server for Crabeaver — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn Crabeaver into a local MCP server that exposes opt-in database connections (introspection + gated query execution) to external MCP clients over `127.0.0.1` HTTP, controlled from a sidebar panel.

**Architecture:** An inbound HTTP adapter (`infrastructure/mcp/`, axum on `127.0.0.1`) speaks MCP JSON-RPC (`initialize` / `tools/list` / `tools/call`). It delegates to a tool+safety layer (`application/mcp.rs`) that reuses the existing query/introspection/connections use cases and enforces exposure + write authorization. Pure types live in `domain/mcp.rs`; thin Tauri commands (`commands/mcp.rs`) let the sidebar drive it.

**Transport decision (resolves spec open item):** v1 hand-rolls JSON-RPC over axum rather than depending on `rmcp`. Rationale: the surface we need is small and fully known, it avoids an unproven SDK↔Tauri-tokio integration, and every line is concrete/testable. The transport is isolated behind `infrastructure/mcp/server.rs` so swapping to `rmcp` later touches only that file. We respond to a `POST /mcp` with a single `application/json` JSON-RPC result (valid Streamable HTTP); `GET /mcp` returns `405` (no server-initiated messages are needed for these tools).

**Tech Stack:** Rust (Tauri v2, axum 0.7, tokio, sqlparser 0.53, sqlx/SQLite, rand 0.8, serde_json); React + TypeScript frontend.

**Spec:** `docs/superpowers/specs/2026-06-03-mcp-server-design.md`

---

## Reused existing APIs (do not re-implement)

- `application::query::execute(state: &AppState, connection_id: &str, sql: &str) -> Result<QueryResult, DriverError>`
- `application::introspection::{schemas(state, id, Option<String>), list_databases(state, id), table_details(state, id, schema, table)}`
- `application::connections::list(state) -> Result<Vec<ConnectionView>, DriverError>` (`ConnectionView { id, name, driver, host, port, database, username, ssl_mode, created_at }`)
- `AppState { db: SqlitePool, drivers, biometric_cache, biometric_lock, schema_indices }`
- Settings store: `SELECT value FROM settings WHERE key = ?` and `INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`.

---

## File Structure

New (Rust, under `src-tauri/src/`):
- `domain/mcp.rs` — pure types: `McpConnFlags`, `McpStatus`, `SqlKind`, `McpActivityEntry`. No HTTP/sqlx.
- `application/mcp.rs` — settings I/O (port/token/flags), the **safety gate** (`classify`, `authorize`), and the 5 **tool** functions reusing existing use cases.
- `infrastructure/mcp/mod.rs` — module wiring.
- `infrastructure/mcp/server.rs` — axum server bound to `127.0.0.1`, start/stop with a shutdown channel, JSON-RPC dispatch.
- `infrastructure/mcp/auth.rs` — bearer-token check.
- `infrastructure/mcp/clients.rs` — client-target registry (detect/install) + generic JSON writer + Claude Code CLI path.
- `commands/mcp.rs` — thin Tauri commands.

Modified (Rust):
- `src-tauri/Cargo.toml` — add `axum`, `rand`.
- `src-tauri/src/infrastructure/database/mod.rs` — add an `mcp` runtime handle to `AppState`.
- `src-tauri/src/lib.rs` — register `commands::mcp::*`, mount modules.
- `src-tauri/tests/disaster.rs` — MCP safety invariants.

New (frontend, under `src/`):
- `src/components/McpPanel.tsx` — sidebar panel.
- `src/hooks/useMcp.ts` — status/actions hook.

Modified (frontend):
- `src/components/ActivityBar.tsx` — add the MCP (server) nav icon + view.
- `src/App.tsx` — render `McpPanel` for the new view.

---

## Phase A — Dependencies, domain types, persistence

### Task A1: Add Rust dependencies

**Files:** Modify `src-tauri/Cargo.toml`

- [ ] **Step 1: Add deps**

In `[dependencies]` add:

```toml
axum = "0.7"
rand = "0.8"
```

- [ ] **Step 2: Verify it resolves**

Run: `cd src-tauri && cargo build`
Expected: compiles (no code uses them yet, but the lockfile resolves).

- [ ] **Step 3: Commit**

```bash
git add src-tauri/Cargo.toml src-tauri/Cargo.lock
git commit -m "chore(mcp): add axum + rand deps"
```

### Task A2: Domain types

**Files:** Create `src-tauri/src/domain/mcp.rs`; Modify `src-tauri/src/domain/mod.rs`

- [ ] **Step 1: Create the types**

`src-tauri/src/domain/mcp.rs`:

```rust
use serde::{Deserialize, Serialize};

/// Per-connection MCP exposure flags.
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq)]
pub struct McpConnFlags {
    pub expose: bool,
    pub allow_write: bool,
}

/// Classification of a `run_query` request.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SqlKind {
    Read,
    Write,
}

/// Server status reported to the sidebar.
#[derive(Debug, Clone, Serialize)]
pub struct McpStatus {
    pub running: bool,
    pub port: u16,
    pub url: String,
    pub has_token: bool,
}

/// One entry in the live activity log (ring buffer).
#[derive(Debug, Clone, Serialize)]
pub struct McpActivityEntry {
    /// Epoch millis (stamped by the caller).
    pub at: i64,
    pub tool: String,
    pub connection: String,
    pub summary: String,
}
```

- [ ] **Step 2: Register the module**

In `src-tauri/src/domain/mod.rs` add `pub mod mcp;` (match the existing `pub mod` style in that file).

- [ ] **Step 3: Verify**

Run: `cd src-tauri && cargo build`
Expected: compiles.

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/domain/mcp.rs src-tauri/src/domain/mod.rs
git commit -m "feat(mcp): domain types"
```

### Task A3: Settings I/O (port, token, per-connection flags)

**Files:** Create `src-tauri/src/application/mcp.rs`; Modify `src-tauri/src/application/mod.rs`

- [ ] **Step 1: Write failing tests**

Append to `src-tauri/src/application/mcp.rs` (create the file with this test module + the functions below in step 3):

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generated_token_has_prefix_and_length() {
        let t = generate_token();
        assert!(t.starts_with("cbv_"));
        assert!(t.len() >= 4 + 40); // prefix + >= 40 random chars
    }

    #[test]
    fn flags_roundtrip_through_json_map() {
        let mut map = std::collections::HashMap::new();
        map.insert("c1".to_string(), super::super::domain::mcp::McpConnFlags { expose: true, allow_write: false });
        let json = serde_json::to_string(&map).unwrap();
        let back: std::collections::HashMap<String, super::super::domain::mcp::McpConnFlags> =
            serde_json::from_str(&json).unwrap();
        assert_eq!(back.get("c1").unwrap().expose, true);
        assert_eq!(back.get("c1").unwrap().allow_write, false);
    }
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd src-tauri && cargo test --lib application::mcp`
Expected: FAIL (`generate_token` not found).

- [ ] **Step 3: Implement the settings layer**

Top of `src-tauri/src/application/mcp.rs`:

```rust
//! MCP application layer: settings I/O, the safety gate, and tool implementations.
use std::collections::HashMap;
use rand::Rng;

use crate::domain::mcp::McpConnFlags;
use crate::infrastructure::database::AppState;

const KEY_PORT: &str = "mcp_port";
const KEY_TOKEN: &str = "mcp_token";
const KEY_FLAGS: &str = "mcp_conn_flags";
pub const DEFAULT_PORT: u16 = 7300;

async fn get(state: &AppState, key: &str) -> Option<String> {
    sqlx::query_scalar::<_, String>("SELECT value FROM settings WHERE key = ?")
        .bind(key).fetch_optional(&state.db).await.ok().flatten()
}

async fn set(state: &AppState, key: &str, value: &str) {
    let _ = sqlx::query(
        "INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
        .bind(key).bind(value).execute(&state.db).await;
}

/// `cbv_` + 48 base62 chars.
pub fn generate_token() -> String {
    const ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    let mut rng = rand::thread_rng();
    let body: String = (0..48).map(|_| ALPHABET[rng.gen_range(0..ALPHABET.len())] as char).collect();
    format!("cbv_{body}")
}

pub async fn port(state: &AppState) -> u16 {
    get(state, KEY_PORT).await.and_then(|s| s.parse().ok()).unwrap_or(DEFAULT_PORT)
}
pub async fn set_port(state: &AppState, p: u16) { set(state, KEY_PORT, &p.to_string()).await }

/// Return the existing token, creating + persisting one on first use.
pub async fn ensure_token(state: &AppState) -> String {
    if let Some(t) = get(state, KEY_TOKEN).await { return t; }
    let t = generate_token();
    set(state, KEY_TOKEN, &t).await;
    t
}
pub async fn token(state: &AppState) -> Option<String> { get(state, KEY_TOKEN).await }
pub async fn rotate_token(state: &AppState) -> String {
    let t = generate_token();
    set(state, KEY_TOKEN, &t).await;
    t
}

pub async fn flags(state: &AppState) -> HashMap<String, McpConnFlags> {
    get(state, KEY_FLAGS).await
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}
pub async fn set_flags(state: &AppState, id: &str, f: McpConnFlags) {
    let mut map = flags(state).await;
    map.insert(id.to_string(), f);
    if let Ok(json) = serde_json::to_string(&map) { set(state, KEY_FLAGS, &json).await }
}
```

- [ ] **Step 4: Register the module**

In `src-tauri/src/application/mod.rs` add `pub mod mcp;`.

- [ ] **Step 5: Run tests**

Run: `cd src-tauri && cargo test --lib application::mcp`
Expected: PASS (2 tests).

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/application/mcp.rs src-tauri/src/application/mod.rs
git commit -m "feat(mcp): settings I/O — port, token, per-connection flags"
```

---

## Phase B — Safety gate

### Task B1: SQL read/write classification

**Files:** Modify `src-tauri/src/application/mcp.rs`

- [ ] **Step 1: Write failing tests**

Add to the `tests` module in `application/mcp.rs`:

```rust
    use crate::domain::mcp::SqlKind;

    fn k(sql: &str) -> SqlKind { classify(sql) }

    #[test]
    fn reads_are_read() {
        assert_eq!(k("SELECT 1"), SqlKind::Read);
        assert_eq!(k("select * from users where id = 1"), SqlKind::Read);
        assert_eq!(k("WITH x AS (SELECT 1) SELECT * FROM x"), SqlKind::Read);
        assert_eq!(k("EXPLAIN SELECT 1"), SqlKind::Read);
    }

    #[test]
    fn writes_are_write() {
        assert_eq!(k("INSERT INTO t VALUES (1)"), SqlKind::Write);
        assert_eq!(k("UPDATE t SET a = 1"), SqlKind::Write);
        assert_eq!(k("DELETE FROM t"), SqlKind::Write);
        assert_eq!(k("DROP TABLE t"), SqlKind::Write);
        assert_eq!(k("CREATE TABLE t (a int)"), SqlKind::Write);
    }

    #[test]
    fn mixed_multistatement_is_write() {
        assert_eq!(k("SELECT 1; DELETE FROM t"), SqlKind::Write);
    }

    #[test]
    fn string_literal_payload_does_not_fool_it() {
        // The ';' lives inside a string literal — still a single SELECT.
        assert_eq!(k("SELECT '; DROP TABLE t'"), SqlKind::Read);
    }

    #[test]
    fn unparseable_or_empty_is_write_fail_closed() {
        assert_eq!(k(""), SqlKind::Write);
        assert_eq!(k("this is not sql @@@"), SqlKind::Write);
    }
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd src-tauri && cargo test --lib application::mcp`
Expected: FAIL (`classify` not found).

- [ ] **Step 3: Implement `classify`**

Add to `application/mcp.rs` (outside the tests module):

```rust
use crate::domain::mcp::SqlKind;

/// Classify SQL as Read or Write by AST (not regex). Read = every statement is a
/// SELECT/WITH…SELECT or EXPLAIN/SHOW. Anything else — or an unparseable/empty
/// string — is Write (fail closed).
pub fn classify(sql: &str) -> SqlKind {
    use sqlparser::ast::Statement;
    use sqlparser::dialect::GenericDialect;
    use sqlparser::parser::Parser;

    let stmts = match Parser::parse_sql(&GenericDialect {}, sql) {
        Ok(s) if !s.is_empty() => s,
        _ => return SqlKind::Write,
    };
    let all_read = stmts.iter().all(|s| {
        matches!(
            s,
            Statement::Query(_)
                | Statement::Explain { .. }
                | Statement::ExplainTable { .. }
                | Statement::ShowVariable { .. }
                | Statement::ShowVariables { .. }
                | Statement::ShowTables { .. }
                | Statement::ShowColumns { .. }
        )
    });
    if all_read { SqlKind::Read } else { SqlKind::Write }
}
```

> If `cargo test` reports a non-existent `Statement` variant for sqlparser 0.53 (e.g. `ShowTables` shape differs), drop only the offending arm from the `matches!` — the catch-all already returns `Write`, so removing a Read arm only makes the gate stricter (safe). Keep `Statement::Query(_)` and `Statement::Explain { .. }`.

- [ ] **Step 4: Run tests**

Run: `cd src-tauri && cargo test --lib application::mcp`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/application/mcp.rs
git commit -m "feat(mcp): AST-based read/write classification (fail-closed)"
```

### Task B2: Authorization gate

**Files:** Modify `src-tauri/src/application/mcp.rs`

- [ ] **Step 1: Write failing tests**

Add to the tests module:

```rust
    use crate::domain::mcp::McpConnFlags;

    fn flags_of(expose: bool, allow_write: bool) -> std::collections::HashMap<String, McpConnFlags> {
        let mut m = std::collections::HashMap::new();
        m.insert("c1".into(), McpConnFlags { expose, allow_write });
        m
    }

    #[test]
    fn unexposed_connection_is_unknown() {
        let f = flags_of(false, false);
        assert_eq!(authorize(&f, "c1", SqlKind::Read).unwrap_err(), GateError::Unknown);
        assert_eq!(authorize(&f, "missing", SqlKind::Read).unwrap_err(), GateError::Unknown);
    }

    #[test]
    fn read_allowed_on_exposed() {
        let f = flags_of(true, false);
        assert!(authorize(&f, "c1", SqlKind::Read).is_ok());
    }

    #[test]
    fn write_blocked_unless_allowed() {
        let f = flags_of(true, false);
        assert_eq!(authorize(&f, "c1", SqlKind::Write).unwrap_err(), GateError::WriteNotAllowed);
        let f2 = flags_of(true, true);
        assert!(authorize(&f2, "c1", SqlKind::Write).is_ok());
    }
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd src-tauri && cargo test --lib application::mcp`
Expected: FAIL (`authorize`/`GateError` not found).

- [ ] **Step 3: Implement**

Add to `application/mcp.rs`:

```rust
use std::collections::HashMap;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GateError {
    /// Connection is not exposed — reported to the agent as "unknown connection".
    Unknown,
    WriteNotAllowed,
}

impl GateError {
    pub fn message(self) -> &'static str {
        match self {
            GateError::Unknown => "unknown connection",
            GateError::WriteNotAllowed => "writes not enabled for this connection",
        }
    }
}

/// Enforce exposure + write authorization for a tool call on `connection_id`.
pub fn authorize(
    flags: &HashMap<String, McpConnFlags>,
    connection_id: &str,
    kind: SqlKind,
) -> Result<(), GateError> {
    let f = flags.get(connection_id).filter(|f| f.expose).ok_or(GateError::Unknown)?;
    match kind {
        SqlKind::Read => Ok(()),
        SqlKind::Write if f.allow_write => Ok(()),
        SqlKind::Write => Err(GateError::WriteNotAllowed),
    }
}
```

(Remove any duplicate `use std::collections::HashMap;` — keep one at the top of the file.)

- [ ] **Step 4: Run tests**

Run: `cd src-tauri && cargo test --lib application::mcp`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/application/mcp.rs
git commit -m "feat(mcp): exposure + write-authorization gate"
```

---

## Phase C — Tool layer

### Task C1: Tool result types + list_connections / introspection tools

**Files:** Modify `src-tauri/src/application/mcp.rs`

- [ ] **Step 1: Implement tool wrappers**

Add to `application/mcp.rs`:

```rust
use serde::Serialize;
use crate::application::{connections, introspection, query};

#[derive(Serialize)]
pub struct ExposedConn {
    pub id: String,
    pub name: String,
    pub engine: String,
    pub database: String,
    pub write_allowed: bool,
}

/// Only exposed connections, with their write flag. Never includes passwords.
pub async fn tool_list_connections(state: &AppState) -> Vec<ExposedConn> {
    let f = flags(state).await;
    let conns = connections::list(state).await.unwrap_or_default();
    conns.into_iter()
        .filter_map(|c| {
            let cf = f.get(&c.id).copied().unwrap_or_default();
            if !cf.expose { return None; }
            Some(ExposedConn {
                id: c.id, name: c.name, engine: c.driver, database: c.database,
                write_allowed: cf.allow_write,
            })
        })
        .collect()
}

/// Shared exposure check for the introspection tools (no SQL is built here —
/// these delegate to existing parameterized use cases).
async fn require_exposed(state: &AppState, connection_id: &str) -> Result<(), GateError> {
    authorize(&flags(state).await, connection_id, SqlKind::Read)
}

pub async fn tool_list_databases(state: &AppState, connection_id: &str) -> Result<Vec<String>, String> {
    require_exposed(state, connection_id).await.map_err(|e| e.message().to_string())?;
    introspection::list_databases(state, connection_id).await.map_err(|e| e.to_string())
}

pub async fn tool_list_schemas(state: &AppState, connection_id: &str, database: Option<String>)
    -> Result<serde_json::Value, String> {
    require_exposed(state, connection_id).await.map_err(|e| e.message().to_string())?;
    let s = introspection::schemas(state, connection_id, database).await.map_err(|e| e.to_string())?;
    serde_json::to_value(s).map_err(|e| e.to_string())
}

pub async fn tool_describe_table(state: &AppState, connection_id: &str, schema: &str, table: &str)
    -> Result<serde_json::Value, String> {
    require_exposed(state, connection_id).await.map_err(|e| e.message().to_string())?;
    let d = introspection::table_details(state, connection_id, schema, table).await.map_err(|e| e.to_string())?;
    serde_json::to_value(d).map_err(|e| e.to_string())
}
```

- [ ] **Step 2: Verify it compiles**

Run: `cd src-tauri && cargo build`
Expected: compiles. (`SchemaInfo`/`TableDetails` already derive `Serialize` — they cross the existing Tauri IPC. If a `serde_json::to_value` fails to compile because a type lacks `Serialize`, add `#[derive(Serialize)]` to that domain type.)

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/application/mcp.rs
git commit -m "feat(mcp): list_connections + introspection tools (exposure-gated)"
```

### Task C2: run_query tool with the gate + auto-LIMIT

**Files:** Modify `src-tauri/src/application/mcp.rs`

- [ ] **Step 1: Write failing tests for the LIMIT helper**

Add to the tests module:

```rust
    #[test]
    fn limit_appended_only_to_bare_selects() {
        assert_eq!(with_limit("SELECT * FROM t", 200), "SELECT * FROM t LIMIT 200");
        // already has LIMIT → untouched
        assert_eq!(with_limit("SELECT * FROM t LIMIT 5", 200), "SELECT * FROM t LIMIT 5");
        // trailing semicolon handled
        assert_eq!(with_limit("SELECT * FROM t;", 200), "SELECT * FROM t LIMIT 200");
    }

    #[test]
    fn limit_not_appended_to_writes_or_multistatement() {
        assert_eq!(with_limit("DELETE FROM t", 200), "DELETE FROM t");
        assert_eq!(with_limit("SELECT 1; SELECT 2", 200), "SELECT 1; SELECT 2");
    }
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd src-tauri && cargo test --lib application::mcp`
Expected: FAIL (`with_limit` not found).

- [ ] **Step 3: Implement `with_limit` + `tool_run_query`**

Add to `application/mcp.rs`:

```rust
pub const DEFAULT_QUERY_LIMIT: u32 = 200;
pub const MAX_QUERY_LIMIT: u32 = 10_000;

/// Append `LIMIT n` to a single bare SELECT that lacks one. Leaves writes,
/// multi-statement input, and queries with an existing LIMIT untouched. Purely a
/// guard so an agent can't accidentally pull a whole table.
pub fn with_limit(sql: &str, limit: u32) -> String {
    let trimmed = sql.trim().trim_end_matches(';').trim();
    let lower = trimmed.to_lowercase();
    let single = !trimmed.contains(';'); // no inner statement separator
    let is_select = lower.starts_with("select") || lower.starts_with("with");
    let has_limit = lower.contains(" limit ");
    if single && is_select && !has_limit {
        format!("{trimmed} LIMIT {limit}")
    } else {
        sql.to_string()
    }
}

#[derive(Serialize)]
pub struct RunResult {
    pub columns: Vec<String>,
    pub rows: Vec<Vec<serde_json::Value>>,
    pub row_count: usize,
    pub kind: &'static str, // "read" | "write"
}

/// The only raw-SQL surface. Runs the full gate, then delegates to the existing
/// `query::execute` use case.
pub async fn tool_run_query(
    state: &AppState,
    connection_id: &str,
    sql: &str,
    limit: Option<u32>,
) -> Result<RunResult, String> {
    let kind = classify(sql);
    authorize(&flags(state).await, connection_id, kind).map_err(|e| e.message().to_string())?;

    let effective = match kind {
        SqlKind::Read => with_limit(sql, limit.unwrap_or(DEFAULT_QUERY_LIMIT).min(MAX_QUERY_LIMIT)),
        SqlKind::Write => sql.to_string(),
    };
    let result = query::execute(state, connection_id, &effective).await.map_err(|e| e.to_string())?;
    let row_count = result.rows.len();
    Ok(RunResult {
        columns: result.columns.iter().map(|c| c.name.clone()).collect(),
        rows: result.rows,
        row_count,
        kind: if kind == SqlKind::Read { "read" } else { "write" },
    })
}
```

> Adjust `result.columns.iter().map(|c| c.name.clone())` and `result.rows` to the real `QueryResult` shape in `domain/models/query.rs` (read it). If `QueryResult` already serializes to `{columns, rows}` the way the frontend consumes it, you may return `serde_json::to_value(result)` instead and drop `RunResult` — but keep `row_count` and `kind` in the response.

- [ ] **Step 4: Run tests**

Run: `cd src-tauri && cargo test --lib application::mcp`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/application/mcp.rs
git commit -m "feat(mcp): run_query tool — full gate + auto-LIMIT"
```

---

## Phase D — HTTP server + auth + JSON-RPC dispatch

### Task D1: AppState runtime handle

**Files:** Modify `src-tauri/src/infrastructure/database/mod.rs`

- [ ] **Step 1: Add the handle field**

In the `AppState` struct add:

```rust
    /// Running MCP server control: `Some(sender)` while running. Sending `()` shuts it down.
    pub mcp_shutdown: std::sync::Arc<tokio::sync::Mutex<Option<tokio::sync::oneshot::Sender<()>>>>,
```

Initialize it wherever `AppState` is constructed (search for `AppState {` construction in `lib.rs`/setup) with `mcp_shutdown: std::sync::Arc::new(tokio::sync::Mutex::new(None))`.

- [ ] **Step 2: Verify**

Run: `cd src-tauri && cargo build`
Expected: compiles.

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/infrastructure/database/mod.rs src-tauri/src/lib.rs
git commit -m "feat(mcp): AppState shutdown handle for the server"
```

### Task D2: Auth check

**Files:** Create `src-tauri/src/infrastructure/mcp/mod.rs`, `src-tauri/src/infrastructure/mcp/auth.rs`; Modify `src-tauri/src/infrastructure/mod.rs`

- [ ] **Step 1: Write failing test**

`src-tauri/src/infrastructure/mcp/auth.rs`:

```rust
/// True iff the `Authorization` header is exactly `Bearer <token>`.
pub fn header_ok(header: Option<&str>, token: &str) -> bool {
    match header {
        Some(h) => h.strip_prefix("Bearer ").map(|t| t == token).unwrap_or(false),
        None => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn matches_correct_bearer_only() {
        assert!(header_ok(Some("Bearer abc"), "abc"));
        assert!(!header_ok(Some("Bearer abc"), "xyz"));
        assert!(!header_ok(Some("abc"), "abc"));        // no scheme
        assert!(!header_ok(None, "abc"));               // missing
    }
}
```

`src-tauri/src/infrastructure/mcp/mod.rs`:

```rust
pub mod auth;
pub mod server;
pub mod clients;
```

Add `pub mod mcp;` to `src-tauri/src/infrastructure/mod.rs`. (Create empty `server.rs`/`clients.rs` with `// filled in later` so the module compiles, or add them in Task D3/F1 and only declare `pub mod auth;` here for now — declare the others as you create them.)

- [ ] **Step 2: Run test**

Run: `cd src-tauri && cargo test --lib infrastructure::mcp::auth`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/infrastructure/mcp/ src-tauri/src/infrastructure/mod.rs
git commit -m "feat(mcp): bearer-token header check"
```

### Task D3: axum server + JSON-RPC dispatch

**Files:** Create/replace `src-tauri/src/infrastructure/mcp/server.rs`

- [ ] **Step 1: Implement the server**

`src-tauri/src/infrastructure/mcp/server.rs`:

```rust
use std::sync::Arc;
use axum::{
    extract::State,
    http::{HeaderMap, StatusCode},
    response::IntoResponse,
    routing::{get, post},
    Json, Router,
};
use serde_json::{json, Value};
use tokio::sync::oneshot;

use crate::application::mcp as app;
use crate::infrastructure::database::AppState;
use super::auth::header_ok;

#[derive(Clone)]
struct Ctx {
    state: Arc<AppState>,
    token: String,
}

/// Tool JSON Schemas advertised by `tools/list`.
fn tool_schemas() -> Value {
    let conn = json!({ "type": "string", "description": "id of an exposed connection" });
    json!([
        { "name": "list_connections", "description": "List exposed database connections.",
          "inputSchema": { "type": "object", "properties": {} } },
        { "name": "list_databases", "description": "List databases on a connection.",
          "inputSchema": { "type": "object", "properties": { "connection_id": conn }, "required": ["connection_id"] } },
        { "name": "list_schemas", "description": "List schemas on a connection.",
          "inputSchema": { "type": "object", "properties": { "connection_id": conn, "database": {"type":"string"} }, "required": ["connection_id"] } },
        { "name": "describe_table", "description": "Columns, types, indexes and foreign keys of a table.",
          "inputSchema": { "type": "object", "properties": { "connection_id": conn, "schema": {"type":"string"}, "table": {"type":"string"} }, "required": ["connection_id","schema","table"] } },
        { "name": "run_query", "description": "Run SQL. Writes require the connection to allow writes.",
          "inputSchema": { "type": "object", "properties": { "connection_id": conn, "sql": {"type":"string"}, "limit": {"type":"integer"} }, "required": ["connection_id","sql"] } }
    ])
}

async fn call_tool(state: &AppState, name: &str, args: &Value) -> Result<Value, String> {
    let cid = || args.get("connection_id").and_then(|v| v.as_str()).unwrap_or("").to_string();
    match name {
        "list_connections" => Ok(serde_json::to_value(app::tool_list_connections(state).await).unwrap()),
        "list_databases" => Ok(serde_json::to_value(app::tool_list_databases(state, &cid()).await?).unwrap()),
        "list_schemas" => {
            let db = args.get("database").and_then(|v| v.as_str()).map(|s| s.to_string());
            app::tool_list_schemas(state, &cid(), db).await
        }
        "describe_table" => {
            let schema = args.get("schema").and_then(|v| v.as_str()).unwrap_or("");
            let table = args.get("table").and_then(|v| v.as_str()).unwrap_or("");
            app::tool_describe_table(state, &cid(), schema, table).await
        }
        "run_query" => {
            let sql = args.get("sql").and_then(|v| v.as_str()).unwrap_or("");
            let limit = args.get("limit").and_then(|v| v.as_u64()).map(|n| n as u32);
            Ok(serde_json::to_value(app::tool_run_query(state, &cid(), sql, limit).await?).unwrap())
        }
        _ => Err(format!("unknown tool: {name}")),
    }
}

async fn handle_post(State(ctx): State<Ctx>, headers: HeaderMap, Json(req): Json<Value>) -> impl IntoResponse {
    let auth = headers.get("authorization").and_then(|v| v.to_str().ok());
    if !header_ok(auth, &ctx.token) {
        return (StatusCode::UNAUTHORIZED, Json(json!({ "error": "unauthorized" }))).into_response();
    }
    let id = req.get("id").cloned().unwrap_or(Value::Null);
    let method = req.get("method").and_then(|m| m.as_str()).unwrap_or("");
    let params = req.get("params").cloned().unwrap_or(json!({}));

    let result: Result<Value, String> = match method {
        "initialize" => Ok(json!({
            "protocolVersion": "2025-03-26",
            "serverInfo": { "name": "crabeaver", "version": env!("CARGO_PKG_VERSION") },
            "capabilities": { "tools": {} }
        })),
        "tools/list" => Ok(json!({ "tools": tool_schemas() })),
        "tools/call" => {
            let name = params.get("name").and_then(|n| n.as_str()).unwrap_or("");
            let args = params.get("arguments").cloned().unwrap_or(json!({}));
            match call_tool(&ctx.state, name, &args).await {
                Ok(v) => Ok(json!({ "content": [{ "type": "text", "text": v.to_string() }], "isError": false })),
                // Tool-level error: report as a tool result with isError, not a JSON-RPC error.
                Err(e) => Ok(json!({ "content": [{ "type": "text", "text": e }], "isError": true })),
            }
        }
        "notifications/initialized" => return StatusCode::ACCEPTED.into_response(),
        _ => Err(format!("method not found: {method}")),
    };

    let body = match result {
        Ok(r) => json!({ "jsonrpc": "2.0", "id": id, "result": r }),
        Err(e) => json!({ "jsonrpc": "2.0", "id": id, "error": { "code": -32601, "message": e } }),
    };
    (StatusCode::OK, Json(body)).into_response()
}

/// Start the server on 127.0.0.1:port. Returns the bound port and a shutdown sender.
pub async fn start(state: Arc<AppState>, port: u16, token: String)
    -> Result<(u16, oneshot::Sender<()>), String> {
    let ctx = Ctx { state, token };
    let app = Router::new()
        .route("/mcp", post(handle_post).get(|| async { StatusCode::METHOD_NOT_ALLOWED }))
        .with_state(ctx);

    let listener = tokio::net::TcpListener::bind(("127.0.0.1", port)).await
        .map_err(|e| format!("port {port} unavailable: {e}"))?;
    let bound = listener.local_addr().map_err(|e| e.to_string())?.port();

    let (tx, rx) = oneshot::channel::<()>();
    tokio::spawn(async move {
        let _ = axum::serve(listener, app)
            .with_graceful_shutdown(async { let _ = rx.await; })
            .await;
    });
    Ok((bound, tx))
}
```

- [ ] **Step 2: Verify it compiles**

Run: `cd src-tauri && cargo build`
Expected: compiles. (If `QueryResult` field access differs, this surfaces here — fix per the Task C2 note.)

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/infrastructure/mcp/server.rs
git commit -m "feat(mcp): axum server — JSON-RPC initialize/tools.list/tools.call + auth"
```

### Task D4: Auth integration test (HTTP)

**Files:** Create `src-tauri/tests/mcp_http.rs`

- [ ] **Step 1: Write the test**

```rust
// Boots the MCP server on an ephemeral port and asserts auth behavior.
use std::sync::Arc;

#[tokio::test]
async fn missing_or_wrong_token_is_401_correct_is_200() {
    let state = Arc::new(crabeaver_lib::test_support::app_state_in_memory().await);
    let (port, _shutdown) = crabeaver_lib::infrastructure::mcp::server::start(state, 0, "secret".into()).await.unwrap();
    let url = format!("http://127.0.0.1:{port}/mcp");
    let client = reqwest::Client::new();
    let body = serde_json::json!({ "jsonrpc":"2.0","id":1,"method":"tools/list" });

    let no_auth = client.post(&url).json(&body).send().await.unwrap();
    assert_eq!(no_auth.status(), 401);

    let wrong = client.post(&url).bearer_auth("nope").json(&body).send().await.unwrap();
    assert_eq!(wrong.status(), 401);

    let ok = client.post(&url).bearer_auth("secret").json(&body).send().await.unwrap();
    assert_eq!(ok.status(), 200);
}
```

> This needs a test helper `crabeaver_lib::test_support::app_state_in_memory()` that builds an `AppState` against an in-memory SQLite (mirror however the existing `tests/disaster.rs` constructs state — read it and reuse its setup; if it has a helper, use that instead of adding a new one). The crate must be referenced by its lib name (check `Cargo.toml` `[lib] name`; the fingerprint output showed `crabeaver_lib`). Make `infrastructure::mcp::server::start` reachable (the modules are `pub`).

- [ ] **Step 2: Run**

Run: `cd src-tauri && cargo test --test mcp_http`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src-tauri/tests/mcp_http.rs src-tauri/src/lib.rs
git commit -m "test(mcp): HTTP auth — 401 without/with wrong token, 200 with correct"
```

---

## Phase E — Tauri commands + lifecycle

### Task E1: Commands

**Files:** Create `src-tauri/src/commands/mcp.rs`; Modify `src-tauri/src/commands/mod.rs`, `src-tauri/src/lib.rs`

- [ ] **Step 1: Implement the commands**

`src-tauri/src/commands/mcp.rs`:

```rust
use std::sync::Arc;
use tauri::State;

use crate::application::mcp as app;
use crate::domain::mcp::{McpConnFlags, McpStatus};
use crate::infrastructure::database::AppState;
use crate::infrastructure::mcp::server;

fn url(port: u16) -> String { format!("http://127.0.0.1:{port}/mcp") }

#[tauri::command]
pub async fn mcp_status(state: State<'_, AppState>) -> Result<McpStatus, String> {
    let running = state.mcp_shutdown.lock().await.is_some();
    let port = app::port(&state).await;
    Ok(McpStatus { running, port, url: url(port), has_token: app::token(&state).await.is_some() })
}

#[tauri::command]
pub async fn mcp_start(state: State<'_, AppState>) -> Result<McpStatus, String> {
    {
        let guard = state.mcp_shutdown.lock().await;
        if guard.is_some() { return Err("already running".into()); }
    }
    let token = app::ensure_token(&state).await;
    let port = app::port(&state).await;
    // Clone the inner AppState into an Arc for the server task. AppState holds
    // pools/registries that are cheap to share; if AppState is not Clone, wrap the
    // shared parts — see note below.
    let shared: Arc<AppState> = state.inner().clone_arc();
    let (bound, tx) = server::start(shared, port, token).await?;
    *state.mcp_shutdown.lock().await = Some(tx);
    Ok(McpStatus { running: true, port: bound, url: url(bound), has_token: true })
}

#[tauri::command]
pub async fn mcp_stop(state: State<'_, AppState>) -> Result<McpStatus, String> {
    if let Some(tx) = state.mcp_shutdown.lock().await.take() { let _ = tx.send(()); }
    let port = app::port(&state).await;
    Ok(McpStatus { running: false, port, url: url(port), has_token: app::token(&state).await.is_some() })
}

#[tauri::command]
pub async fn mcp_rotate_token(state: State<'_, AppState>) -> Result<String, String> {
    Ok(app::rotate_token(&state).await)
}

#[tauri::command]
pub async fn mcp_get_token(state: State<'_, AppState>) -> Result<Option<String>, String> {
    Ok(app::token(&state).await)
}

#[tauri::command]
pub async fn mcp_set_port(state: State<'_, AppState>, port: u16) -> Result<(), String> {
    app::set_port(&state, port).await; Ok(())
}

#[tauri::command]
pub async fn mcp_set_connection_flags(state: State<'_, AppState>, connection_id: String, expose: bool, allow_write: bool) -> Result<(), String> {
    app::set_flags(&state, &connection_id, McpConnFlags { expose, allow_write }).await; Ok(())
}

#[tauri::command]
pub async fn mcp_connection_flags(state: State<'_, AppState>) -> Result<std::collections::HashMap<String, McpConnFlags>, String> {
    Ok(app::flags(&state).await)
}
```

> **Sharing `AppState` with the server task:** the server needs `Arc<AppState>`, but Tauri owns the single `AppState` in `State<'_, AppState>`. Two clean options — pick whichever fits the existing setup (read `lib.rs` `.manage(...)`):
> 1. Change `.manage(app_state)` to `.manage(Arc::new(app_state))` and make commands take `State<'_, Arc<AppState>>`; then `state.inner().clone()` is a cheap `Arc` clone. This is the least-surprising change and removes the need for `clone_arc()`. Prefer this; update the other commands' `State<'_, AppState>` to `State<'_, Arc<AppState>>` only if the compiler requires — Tauri can manage both, but keep one type. If touching every command is too broad, use option 2.
> 2. Keep `State<'_, AppState>` and give `AppState` a `pub fn clone_arc(&self) -> Arc<AppState>` only if its fields are already `Arc`/pools that are `Clone`. If `AppState` isn't `Clone`, option 1 is required.
> Resolve this in this task; do not leave `clone_arc()` undefined.

- [ ] **Step 2: Register**

Add `pub mod mcp;` to `commands/mod.rs`. In `lib.rs`, add all `mcp_*` commands to the `tauri::generate_handler![...]` list and the `use crate::commands::mcp::{...}` import.

- [ ] **Step 3: Verify**

Run: `cd src-tauri && cargo build`
Expected: compiles.

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/commands/mcp.rs src-tauri/src/commands/mod.rs src-tauri/src/lib.rs
git commit -m "feat(mcp): Tauri commands — status/start/stop/token/port/flags"
```

---

## Phase F — Client setup registry

### Task F1: Generic JSON writer + Claude Code, with detection

**Files:** Create `src-tauri/src/infrastructure/mcp/clients.rs`; Modify command file to expose `mcp_list_clients`/`mcp_setup_client`

- [ ] **Step 1: Write failing test for the merge writer**

`src-tauri/src/infrastructure/mcp/clients.rs` (tests at the bottom):

```rust
use serde_json::{json, Value};

/// Merge a Crabeaver MCP entry into a client's `mcpServers` JSON object without
/// clobbering existing servers or unrelated keys.
pub fn merge_mcp_servers(existing: Value, url: &str, token: &str) -> Value {
    let mut root = if existing.is_object() { existing } else { json!({}) };
    let entry = json!({
        "type": "http",
        "url": url,
        "headers": { "Authorization": format!("Bearer {token}") }
    });
    let servers = root.get_mut("mcpServers").and_then(|v| v.as_object_mut());
    match servers {
        Some(map) => { map.insert("crabeaver".into(), entry); }
        None => {
            root.as_object_mut().unwrap().insert("mcpServers".into(), json!({ "crabeaver": entry }));
        }
    }
    root
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn merges_without_clobbering() {
        let existing = json!({
            "mcpServers": { "other": { "type": "http", "url": "x" } },
            "unrelated": 1
        });
        let out = merge_mcp_servers(existing, "http://127.0.0.1:7300/mcp", "tok");
        assert_eq!(out["unrelated"], json!(1));
        assert_eq!(out["mcpServers"]["other"]["url"], json!("x"));        // preserved
        assert_eq!(out["mcpServers"]["crabeaver"]["type"], json!("http")); // added
        assert_eq!(out["mcpServers"]["crabeaver"]["headers"]["Authorization"], json!("Bearer tok"));
    }
    #[test]
    fn creates_servers_block_when_missing() {
        let out = merge_mcp_servers(json!({}), "u", "t");
        assert_eq!(out["mcpServers"]["crabeaver"]["url"], json!("u"));
    }
    #[test]
    fn claude_code_cli_args_are_correct() {
        let args = claude_code_args("http://127.0.0.1:7300/mcp", "tok");
        assert_eq!(args, vec![
            "mcp","add","--transport","http","crabeaver","http://127.0.0.1:7300/mcp",
            "--header","Authorization: Bearer tok"
        ]);
    }
}

/// Argv for `claude mcp add` (Claude Code special-cases to its CLI).
pub fn claude_code_args(url: &str, token: &str) -> Vec<String> {
    vec![
        "mcp".into(), "add".into(), "--transport".into(), "http".into(),
        "crabeaver".into(), url.into(),
        "--header".into(), format!("Authorization: Bearer {token}"),
    ]
}
```

- [ ] **Step 2: Run**

Run: `cd src-tauri && cargo test --lib infrastructure::mcp::clients`
Expected: PASS.

- [ ] **Step 3: Add client descriptors + detect/install + commands**

Add to `clients.rs`:

```rust
use std::path::PathBuf;
use serde::Serialize;

#[derive(Serialize, Clone)]
pub struct ClientTarget {
    pub id: String,
    pub name: String,
    pub installed: bool,     // already has a crabeaver entry
    pub detected: bool,      // client present on this machine
    pub can_setup: bool,     // we can write its config / run its CLI
}

fn home() -> Option<PathBuf> { std::env::var_os("HOME").map(PathBuf::from) }

/// File-based clients with the generic `mcpServers` shape. (path resolver, label)
fn json_clients() -> Vec<(&'static str, &'static str, Option<PathBuf>)> {
    let h = home();
    vec![
        ("cursor", "Cursor", h.as_ref().map(|h| h.join(".cursor/mcp.json"))),
        ("windsurf", "Windsurf", h.as_ref().map(|h| h.join(".codeium/windsurf/mcp_config.json"))),
        // Claude Desktop / VS Code / opencode / Cline added here behind the same shape.
    ]
}

fn has_crabeaver(path: &PathBuf) -> bool {
    std::fs::read_to_string(path).ok()
        .and_then(|s| serde_json::from_str::<Value>(&s).ok())
        .map(|v| v.get("mcpServers").and_then(|m| m.get("crabeaver")).is_some())
        .unwrap_or(false)
}

fn claude_code_present() -> bool {
    std::process::Command::new("claude").arg("--version").output().map(|o| o.status.success()).unwrap_or(false)
}

pub fn list() -> Vec<ClientTarget> {
    let mut out = vec![ClientTarget {
        id: "claude-code".into(), name: "Claude Code".into(),
        detected: claude_code_present(), installed: false, can_setup: claude_code_present(),
    }];
    for (id, name, path) in json_clients() {
        let detected = path.as_ref().map(|p| p.exists() || p.parent().map(|d| d.exists()).unwrap_or(false)).unwrap_or(false);
        let installed = path.as_ref().map(has_crabeaver).unwrap_or(false);
        out.push(ClientTarget { id: id.into(), name: name.into(), detected, installed, can_setup: path.is_some() });
    }
    out
}

/// Install the crabeaver entry into one client. Returns Ok on success.
pub fn install(id: &str, url: &str, token: &str) -> Result<(), String> {
    if id == "claude-code" {
        let status = std::process::Command::new("claude").args(claude_code_args(url, token)).status()
            .map_err(|e| format!("claude CLI failed: {e}"))?;
        return if status.success() { Ok(()) } else { Err("claude mcp add failed".into()) };
    }
    let path = json_clients().into_iter().find(|(cid, _, _)| *cid == id)
        .and_then(|(_, _, p)| p).ok_or_else(|| format!("unknown client: {id}"))?;
    if let Some(dir) = path.parent() { std::fs::create_dir_all(dir).map_err(|e| e.to_string())?; }
    let existing = std::fs::read_to_string(&path).ok()
        .and_then(|s| serde_json::from_str::<Value>(&s).ok()).unwrap_or(json!({}));
    let merged = merge_mcp_servers(existing, url, token);
    std::fs::write(&path, serde_json::to_string_pretty(&merged).unwrap()).map_err(|e| e.to_string())
}
```

Add two commands to `commands/mcp.rs`:

```rust
#[tauri::command]
pub async fn mcp_list_clients() -> Result<Vec<crate::infrastructure::mcp::clients::ClientTarget>, String> {
    Ok(crate::infrastructure::mcp::clients::list())
}

#[tauri::command]
pub async fn mcp_setup_client(state: State<'_, AppState>, client_id: String) -> Result<(), String> {
    let token = app::ensure_token(&state).await;
    let port = app::port(&state).await;
    crate::infrastructure::mcp::clients::install(&client_id, &url(port), &token)
}
```

Register both in `lib.rs`.

- [ ] **Step 4: Verify**

Run: `cd src-tauri && cargo test --lib infrastructure::mcp::clients && cargo build`
Expected: PASS + compiles.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/infrastructure/mcp/clients.rs src-tauri/src/commands/mcp.rs src-tauri/src/lib.rs
git commit -m "feat(mcp): client setup registry — generic JSON writer + Claude Code"
```

---

## Phase G — Frontend MCP panel

### Task G1: useMcp hook

**Files:** Create `src/hooks/useMcp.ts`

- [ ] **Step 1: Implement the hook**

```ts
import { useState, useCallback, useEffect } from 'react'
import { invoke } from '@tauri-apps/api/core'

export interface McpStatus { running: boolean; port: number; url: string; has_token: boolean }
export interface ClientTarget { id: string; name: string; installed: boolean; detected: boolean; can_setup: boolean }
export type ConnFlags = Record<string, { expose: boolean; allow_write: boolean }>

export function useMcp() {
  const [status, setStatus] = useState<McpStatus | null>(null)
  const [token, setToken] = useState<string | null>(null)
  const [clients, setClients] = useState<ClientTarget[]>([])
  const [flags, setFlags] = useState<ConnFlags>({})

  const refresh = useCallback(async () => {
    const [s, t, c, f] = await Promise.all([
      invoke<McpStatus>('mcp_status'),
      invoke<string | null>('mcp_get_token').catch(() => null),
      invoke<ClientTarget[]>('mcp_list_clients').catch(() => []),
      invoke<ConnFlags>('mcp_connection_flags').catch(() => ({})),
    ])
    setStatus(s); setToken(t); setClients(c); setFlags(f)
  }, [])

  useEffect(() => { refresh() }, [refresh])

  const start = useCallback(async () => { setStatus(await invoke<McpStatus>('mcp_start')); }, [])
  const stop  = useCallback(async () => { setStatus(await invoke<McpStatus>('mcp_stop')); }, [])
  const rotate = useCallback(async () => { setToken(await invoke<string>('mcp_rotate_token')); }, [])
  const setPort = useCallback(async (port: number) => { await invoke('mcp_set_port', { port }); await refresh() }, [refresh])
  const setupClient = useCallback(async (id: string) => { await invoke('mcp_setup_client', { clientId: id }); await refresh() }, [refresh])
  const setConnFlags = useCallback(async (connectionId: string, expose: boolean, allow_write: boolean) => {
    await invoke('mcp_set_connection_flags', { connectionId, expose, allowWrite: allow_write }); await refresh()
  }, [refresh])

  return { status, token, clients, flags, refresh, start, stop, rotate, setPort, setupClient, setConnFlags }
}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc -b`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add src/hooks/useMcp.ts
git commit -m "feat(mcp): useMcp hook"
```

### Task G2: McpPanel component + ActivityBar/App wiring

**Files:** Create `src/components/McpPanel.tsx`; Modify `src/components/ActivityBar.tsx`, `src/App.tsx`

- [ ] **Step 1: Implement the panel**

`src/components/McpPanel.tsx` — server toggle + URL/token copy/rotate, per-connection expose/write toggles, client setup list. Uses `useMcp` and `useConnections`:

```tsx
import { useState } from 'react'
import { Server, Copy, RefreshCw, Check } from 'lucide-react'
import { useMcp } from '@/hooks/useMcp'
import { useConnections } from '@/context/ConnectionContext'

export default function McpPanel({ width = 224 }: { width?: number }) {
  const { status, token, clients, flags, start, stop, rotate, setupClient, setConnFlags } = useMcp()
  const { connections } = useConnections()
  const [copied, setCopied] = useState<string | null>(null)

  const copy = (key: string, text: string) => {
    navigator.clipboard.writeText(text).then(() => { setCopied(key); setTimeout(() => setCopied(null), 1200) }).catch(() => {})
  }
  const running = !!status?.running

  return (
    <aside className="flex flex-col shrink-0 overflow-hidden bg-th-sidebar" style={{ width, borderRight: '1px solid var(--border)' }}>
      <div className="px-3 py-2 flex items-center justify-between shrink-0" style={{ borderBottom: '1px solid var(--border)' }}>
        <div className="flex items-center gap-1.5">
          <span className="w-2 h-2 rounded-full" style={{ background: running ? '#22c55e' : 'var(--text-dim)' }} />
          <span className="text-[11px] font-semibold tracking-[0.1em] uppercase text-th-dim">MCP Server</span>
        </div>
        <button onClick={() => (running ? stop() : start())}
          className="text-[11px] px-2 py-0.5 rounded"
          style={{ background: running ? 'var(--hover)' : 'var(--tab-accent)', color: running ? 'var(--text)' : '#fff' }}>
          {running ? 'On' : 'Off'}
        </button>
      </div>

      <div className="overflow-y-auto flex-1">
        {/* Endpoint */}
        <div className="px-3 py-2" style={{ borderBottom: '1px solid var(--border)' }}>
          <Row label={status?.url ?? ''} onCopy={() => status && copy('url', status.url)} copied={copied === 'url'} mono />
          {token && <Row label={`token  ${token.slice(0, 12)}…`} onCopy={() => copy('tok', token)} copied={copied === 'tok'} mono extra={
            <button title="Rotate token" onClick={() => rotate()} className="text-th-dim hover:text-th-accent"><RefreshCw size={11} /></button>
          } />}
        </div>

        {/* Setup */}
        <Section title="Setup">
          {clients.map(c => (
            <div key={c.id} className="flex items-center gap-2 px-3 py-1 text-[12px]">
              <span className="flex-1 truncate" style={{ color: c.detected ? 'var(--text)' : 'var(--text-dim)' }}>{c.name}</span>
              {c.installed ? <span className="text-[10px] text-th-dim">installed</span>
                : c.can_setup ? <button onClick={() => setupClient(c.id)} className="text-[11px] text-th-accent hover:underline">Set up</button>
                : <span className="text-[10px] text-th-dim">copy only</span>}
            </div>
          ))}
        </Section>

        {/* Connections */}
        <Section title="Connections">
          {connections.map(c => {
            const f = flags[c.id] ?? { expose: false, allow_write: false }
            return (
              <div key={c.id} className="flex items-center gap-2 px-3 py-1 text-[12px]">
                <label className="flex items-center gap-1 text-[11px] text-th-dim">
                  <input type="checkbox" checked={f.expose} onChange={e => setConnFlags(c.id, e.target.checked, e.target.checked ? f.allow_write : false)} />expose
                </label>
                <label className="flex items-center gap-1 text-[11px] text-th-dim">
                  <input type="checkbox" disabled={!f.expose} checked={f.allow_write} onChange={e => setConnFlags(c.id, f.expose, e.target.checked)} />write
                </label>
                <span className="flex-1 truncate text-right">{c.name}</span>
              </div>
            )
          })}
        </Section>
      </div>
    </aside>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ borderBottom: '1px solid var(--border)' }}>
      <div className="px-3 py-1.5 text-[10px] font-semibold tracking-widest uppercase text-th-dim">{title}</div>
      {children}
    </div>
  )
}
function Row({ label, onCopy, copied, mono, extra }: { label: string; onCopy: () => void; copied: boolean; mono?: boolean; extra?: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2 py-0.5">
      <span className={`flex-1 truncate text-[11px] ${mono ? 'font-mono' : ''} text-th-dim`}>{label}</span>
      {extra}
      <button onClick={onCopy} className="text-th-dim hover:text-th-accent shrink-0">{copied ? <Check size={11} /> : <Copy size={11} />}</button>
    </div>
  )
}
```

(Imports `Server` is used by ActivityBar, not here — drop it if unused; keep `Copy/RefreshCw/Check`.)

- [ ] **Step 2: ActivityBar — add the nav item**

In `src/components/ActivityBar.tsx`, import `Server` from lucide and add `{ icon: Server, label: 'MCP' }` to `navItems`. The existing nav click already sets the view via label — confirm the label routes (see App.tsx step 3).

- [ ] **Step 3: App — render the panel**

In `src/App.tsx`, where the left panel switches on the active nav (it currently renders `Sidebar` / `SearchPanel`), add a branch: when the MCP nav is active, render `<McpPanel width={sidebarW} />`. Match the existing conditional pattern used for `SearchPanel`.

- [ ] **Step 4: Verify**

Run: `npx tsc -b && npm run build`
Expected: clean + build succeeds.

- [ ] **Step 5: Commit**

```bash
git add src/components/McpPanel.tsx src/components/ActivityBar.tsx src/App.tsx
git commit -m "feat(mcp): sidebar MCP panel + activity-bar entry"
```

---

## Phase H — Disaster tests (safety invariants)

### Task H1: MCP cannot mutate unexposed / non-write connections; no passwords leak

**Files:** Modify `src-tauri/tests/disaster.rs`

- [ ] **Step 1: Add the tests**

Mirror the existing disaster-test setup (read the file first for how it builds state + a SQLite test connection). Add:

```rust
#[tokio::test]
async fn mcp_blocks_writes_on_unexposed_and_non_write_connections() {
    use crabeaver_lib::application::mcp as mcp;
    let state = /* build AppState with one sqlite connection id "c1" — reuse the file's helper */;

    // Not exposed at all → unknown connection, even for reads.
    let f = mcp::flags(&state).await; // empty
    assert!(mcp::authorize(&f, "c1", crabeaver_lib::domain::mcp::SqlKind::Read).is_err());

    // Exposed read-only → write rejected.
    mcp::set_flags(&state, "c1", crabeaver_lib::domain::mcp::McpConnFlags { expose: true, allow_write: false }).await;
    let res = mcp::tool_run_query(&state, "c1", "CREATE TABLE hax (x int)", None).await;
    assert!(res.is_err(), "write must be rejected on a non-write connection");

    // Read still works.
    let ok = mcp::tool_run_query(&state, "c1", "SELECT 1", None).await;
    assert!(ok.is_ok());
}

#[tokio::test]
async fn mcp_list_connections_never_contains_password() {
    use crabeaver_lib::application::mcp as mcp;
    let state = /* build AppState, add a connection WITH a password, expose it */;
    let list = mcp::tool_list_connections(&state).await;
    let json = serde_json::to_string(&list).unwrap();
    assert!(!json.to_lowercase().contains("password"));
}
```

> Fill the `/* build AppState … */` blanks using the exact helper the existing `disaster.rs` already uses to construct state and seed a connection (read it; reuse, don't invent). The assertions and tool calls above are the substance.

- [ ] **Step 2: Run**

Run: `cd src-tauri && cargo test --test disaster`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src-tauri/tests/disaster.rs
git commit -m "test(mcp): disaster — unexposed/non-write can't mutate, no password leak"
```

---

## Phase I — Final verification

### Task I1: Full build + suites + manual smoke

- [ ] **Step 1: Rust**

Run: `cd src-tauri && cargo build && cargo test`
Expected: all pass.

- [ ] **Step 2: Frontend**

Run: `npx tsc -b && npx vitest run && npm run build`
Expected: clean + all pass.

- [ ] **Step 3: Manual smoke (real client)**

Run `npm run tauri dev`. In the MCP panel: turn the server On, expose one connection, click "Set up" for Claude Code (or copy the URL+token). From a terminal:

```bash
curl -s http://127.0.0.1:7300/mcp -H "Authorization: Bearer <token>" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | jq .
curl -s http://127.0.0.1:7300/mcp -H "Authorization: Bearer <token>" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"list_connections","arguments":{}}}' | jq .
```

Expected: `tools/list` shows the 5 tools; `list_connections` shows only the exposed connection; a `run_query` write on a non-write connection returns `isError: true` with "writes not enabled".

- [ ] **Step 4: Commit any fixups**

```bash
git add -A && git commit -m "chore(mcp): final verification fixups"
```

---

## Notes for the implementer

- **`AppState` sharing** (Task E1): resolve the `Arc<AppState>` question before writing the server commands — option 1 (`manage(Arc::new(state))`) is cleanest. Don't leave `clone_arc()` undefined.
- **`QueryResult` shape** (Task C2/D3): read `domain/models/query.rs` and match field access exactly; prefer returning the existing serializable result + `row_count`/`kind` over re-mapping.
- **sqlparser variants** (Task B1): if a Read arm's variant name differs in 0.53, delete that arm only — the fail-closed catch-all keeps it safe.
- **Test crate name**: integration tests reference the lib as `crabeaver_lib` (confirm in `Cargo.toml` `[lib] name`).
- The **activity log** (live feed) from the spec is intentionally deferred: tools work without it. If desired, add a follow-up phase that pushes `McpActivityEntry` over a Tauri event from `call_tool`.
