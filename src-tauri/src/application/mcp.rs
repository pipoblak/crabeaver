//! MCP application layer: settings I/O, the safety gate, and tool implementations.
use std::collections::HashMap;

use rand::Rng;

use crate::domain::mcp::{McpConnFlags, SqlKind};
use crate::infrastructure::database::AppState;
use crate::infrastructure::keychain;

const KEY_PORT: &str = "mcp_port";
const KEY_TOKEN: &str = "mcp_token"; // legacy settings key — migrated to the keychain
const KEY_FLAGS: &str = "mcp_conn_flags";
const KEY_AUTOSTART: &str = "mcp_autostart";
const KEY_PROMPT: &str = "mcp_global_prompt";
/// Keychain account holding the MCP bearer token (a local-loopback capability
/// token, kept beside DB passwords; never in the settings DB).
const TOKEN_ID: &str = "mcp-server-token";
pub const DEFAULT_PORT: u16 = 7300;

async fn get(state: &AppState, key: &str) -> Option<String> {
    sqlx::query_scalar::<_, String>("SELECT value FROM settings WHERE key = ?")
        .bind(key)
        .fetch_optional(&state.db)
        .await
        .ok()
        .flatten()
}

async fn set(state: &AppState, key: &str, value: &str) {
    let _ = sqlx::query(
        "INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    )
    .bind(key)
    .bind(value)
    .execute(&state.db)
    .await;
}

/// `cbv_` + 48 base62 chars.
pub fn generate_token() -> String {
    const ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    let mut rng = rand::thread_rng();
    let body: String = (0..48)
        .map(|_| ALPHABET[rng.gen_range(0..ALPHABET.len())] as char)
        .collect();
    format!("cbv_{body}")
}

pub async fn port(state: &AppState) -> u16 {
    get(state, KEY_PORT)
        .await
        .and_then(|s| s.parse().ok())
        .unwrap_or(DEFAULT_PORT)
}

pub async fn set_port(state: &AppState, p: u16) {
    set(state, KEY_PORT, &p.to_string()).await
}

pub async fn autostart(state: &AppState) -> bool {
    get(state, KEY_AUTOSTART).await.as_deref() == Some("true")
}

pub async fn set_autostart(state: &AppState, on: bool) {
    set(state, KEY_AUTOSTART, if on { "true" } else { "false" }).await
}

/// Return the existing token (from the keychain), creating + storing one on first
/// use. Migrates a token previously kept in the settings DB so existing client
/// configs keep working.
pub async fn ensure_token(state: &AppState) -> String {
    if let Ok(t) = keychain::load_password(TOKEN_ID) {
        return t;
    }
    // One-time migration: move a legacy settings-stored token into the keychain.
    if let Some(legacy) = get(state, KEY_TOKEN).await {
        let _ = keychain::store_password(TOKEN_ID, &legacy);
        let _ = sqlx::query("DELETE FROM settings WHERE key = ?").bind(KEY_TOKEN).execute(&state.db).await;
        return legacy;
    }
    let t = generate_token();
    let _ = keychain::store_password(TOKEN_ID, &t);
    t
}

pub async fn token(state: &AppState) -> Option<String> {
    if let Ok(t) = keychain::load_password(TOKEN_ID) {
        return Some(t);
    }
    // Surface a not-yet-migrated legacy token for display without changing it.
    get(state, KEY_TOKEN).await
}

/// Regenerate the token (only on explicit user action) and store it in the keychain.
pub async fn rotate_token(state: &AppState) -> String {
    let t = generate_token();
    let _ = keychain::store_password(TOKEN_ID, &t);
    let _ = sqlx::query("DELETE FROM settings WHERE key = ?").bind(KEY_TOKEN).execute(&state.db).await;
    t
}

pub async fn flags(state: &AppState) -> HashMap<String, McpConnFlags> {
    get(state, KEY_FLAGS)
        .await
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

pub async fn set_flags(state: &AppState, id: &str, f: McpConnFlags) {
    let mut map = flags(state).await;
    map.insert(id.to_string(), f);
    if let Ok(json) = serde_json::to_string(&map) {
        set(state, KEY_FLAGS, &json).await
    }
}

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

/// Classify SQL as Read or Write by AST (not regex). Read = every statement is a
/// pure read. Anything else — or an unparseable/empty string — is Write (fail
/// closed).
///
/// "Pure read" is checked recursively, not just by top-level statement type,
/// because a query can carry a write inside it: data-modifying CTEs
/// (`WITH w AS (UPDATE … RETURNING) SELECT …`), `SELECT … INTO new_table`, and
/// `EXPLAIN ANALYZE <write>` (which executes the inner statement). This is the
/// up-front gate; `execute_readonly` is the engine-level backstop for anything
/// this still misjudges.
pub fn classify(sql: &str) -> SqlKind {
    use sqlparser::dialect::GenericDialect;
    use sqlparser::parser::Parser;

    let stmts = match Parser::parse_sql(&GenericDialect {}, sql) {
        Ok(s) if !s.is_empty() => s,
        _ => return SqlKind::Write,
    };
    if stmts.iter().all(stmt_is_read) {
        SqlKind::Read
    } else {
        SqlKind::Write
    }
}

/// A statement that only reads — no row, schema, or catalog mutation.
fn stmt_is_read(s: &sqlparser::ast::Statement) -> bool {
    use sqlparser::ast::Statement;
    match s {
        Statement::Query(q) => !query_is_write(q),
        // EXPLAIN ANALYZE actually runs the inner statement; plain EXPLAIN does
        // not, but we still require the inner to be a read (conservative).
        Statement::Explain { statement, analyze, .. } => !analyze && stmt_is_read(statement),
        Statement::ExplainTable { .. }
        | Statement::ShowVariable { .. }
        | Statement::ShowVariables { .. }
        | Statement::ShowTables { .. }
        | Statement::ShowColumns { .. } => true,
        _ => false,
    }
}

/// Does this query mutate anything, anywhere within it (CTEs, set operations,
/// `SELECT … INTO`)?
fn query_is_write(q: &sqlparser::ast::Query) -> bool {
    if let Some(with) = &q.with
        && with.cte_tables.iter().any(|c| query_is_write(&c.query))
    {
        return true;
    }
    set_expr_is_write(&q.body)
}

fn set_expr_is_write(e: &sqlparser::ast::SetExpr) -> bool {
    use sqlparser::ast::SetExpr;
    match e {
        // A write embedded in a query body (e.g. inside a CTE).
        SetExpr::Insert(_) | SetExpr::Update(_) => true,
        // SELECT … INTO new_table creates and writes a table.
        SetExpr::Select(s) => s.into.is_some(),
        SetExpr::Query(inner) => query_is_write(inner),
        SetExpr::SetOperation { left, right, .. } => {
            set_expr_is_write(left) || set_expr_is_write(right)
        }
        SetExpr::Values(_) | SetExpr::Table(_) => false,
    }
}

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
    let f = flags
        .get(connection_id)
        .filter(|f| f.expose)
        .ok_or(GateError::Unknown)?;
    match kind {
        SqlKind::Read => Ok(()),
        SqlKind::Write if f.allow_write => Ok(()),
        SqlKind::Write => Err(GateError::WriteNotAllowed),
    }
}

// ── Tool layer ──────────────────────────────────────────────────────────────
use serde::Serialize;

use crate::application::{connections, introspection, query};

#[derive(Serialize)]
pub struct ExposedConn {
    pub id: String,
    pub name: String,
    pub engine: String,
    pub database: String,
    pub write_allowed: bool,
    pub context: String,
}

/// Only exposed connections, with their write flag. Never includes passwords.
pub async fn tool_list_connections(state: &AppState) -> Vec<ExposedConn> {
    let f = flags(state).await;
    let conns = connections::list(state).await.unwrap_or_default();
    conns
        .into_iter()
        .filter_map(|c| {
            let cf = f.get(&c.id).cloned().unwrap_or_default();
            if !cf.expose {
                return None;
            }
            Some(ExposedConn {
                id: c.id,
                name: c.name,
                engine: c.driver,
                database: c.database,
                write_allowed: cf.allow_write,
                context: cf.note,
            })
        })
        .collect()
}

/// Exposure check shared by the introspection tools (no SQL built here — these
/// delegate to existing parameterized use cases).
async fn require_exposed(state: &AppState, connection_id: &str) -> Result<(), GateError> {
    authorize(&flags(state).await, connection_id, SqlKind::Read)
}

pub async fn tool_list_databases(state: &AppState, connection_id: &str) -> Result<Vec<String>, String> {
    require_exposed(state, connection_id).await.map_err(|e| e.message().to_string())?;
    introspection::list_databases(state, connection_id).await.map_err(|e| e.to_string())
}

pub async fn tool_list_schemas(
    state: &AppState,
    connection_id: &str,
    database: Option<String>,
) -> Result<serde_json::Value, String> {
    require_exposed(state, connection_id).await.map_err(|e| e.message().to_string())?;
    let s = introspection::schemas(state, connection_id, database).await.map_err(|e| e.to_string())?;
    serde_json::to_value(s).map_err(|e| e.to_string())
}

pub async fn tool_describe_table(
    state: &AppState,
    connection_id: &str,
    schema: &str,
    table: &str,
) -> Result<serde_json::Value, String> {
    require_exposed(state, connection_id).await.map_err(|e| e.message().to_string())?;
    let d = introspection::table_details(state, connection_id, schema, table).await.map_err(|e| e.to_string())?;
    let mut val = serde_json::to_value(d).map_err(|e| e.to_string())?;
    let note = flags(state).await.get(connection_id).map(|f| f.note.clone()).unwrap_or_default();
    if !note.is_empty() {
        if let Some(obj) = val.as_object_mut() {
            obj.insert("connection_note".into(), serde_json::Value::String(note));
        }
    }
    Ok(val)
}

pub const DEFAULT_QUERY_LIMIT: u32 = 200;
pub const MAX_QUERY_LIMIT: u32 = 10_000;

/// Append `LIMIT n` to a single bare SELECT that lacks one. Leaves writes,
/// multi-statement input, and queries with an existing LIMIT untouched.
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

#[derive(Debug, Serialize)]
pub struct RunResult {
    pub columns: Vec<String>,
    pub rows: Vec<Vec<serde_json::Value>>,
    pub row_count: usize,
    pub kind: &'static str, // "read" | "write"
}

/// The only raw-SQL surface. Runs the full gate, then delegates to `query::execute`.
pub async fn tool_run_query(
    state: &AppState,
    connection_id: &str,
    sql: &str,
    limit: Option<u32>,
) -> Result<RunResult, String> {
    let kind = classify(sql);
    let conn_flags = flags(state).await;
    authorize(&conn_flags, connection_id, kind).map_err(|e| e.message().to_string())?;
    let allow_write = conn_flags.get(connection_id).map(|f| f.allow_write).unwrap_or(false);

    let effective = match kind {
        SqlKind::Read => with_limit(sql, limit.unwrap_or(DEFAULT_QUERY_LIMIT).min(MAX_QUERY_LIMIT)),
        SqlKind::Write => sql.to_string(),
    };
    // Defense in depth: a connection without write permission runs EVERYTHING in
    // an engine-enforced read-only transaction. Statement classification only
    // decides the up-front error and the LIMIT; the read-only execution is the
    // wall that stops anything `classify` misjudges (data-modifying CTEs,
    // SELECT INTO, volatile write functions) from mutating data.
    let result = if allow_write {
        query::execute(state, connection_id, &effective).await
    } else {
        query::execute_readonly(state, connection_id, &effective).await
    }
    .map_err(|e| e.to_string())?;
    let row_count = result.rows.len();
    Ok(RunResult {
        columns: result.columns.iter().map(|c| c.name.clone()).collect(),
        rows: result.rows,
        row_count,
        kind: if kind == SqlKind::Read { "read" } else { "write" },
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::mcp::{McpConnFlags, SqlKind};

    #[test]
    fn limit_appended_only_to_bare_selects() {
        assert_eq!(with_limit("SELECT * FROM t", 200), "SELECT * FROM t LIMIT 200");
        assert_eq!(with_limit("SELECT * FROM t LIMIT 5", 200), "SELECT * FROM t LIMIT 5");
        assert_eq!(with_limit("SELECT * FROM t;", 200), "SELECT * FROM t LIMIT 200");
    }

    #[test]
    fn limit_not_appended_to_writes_or_multistatement() {
        assert_eq!(with_limit("DELETE FROM t", 200), "DELETE FROM t");
        assert_eq!(with_limit("SELECT 1; SELECT 2", 200), "SELECT 1; SELECT 2");
    }

    fn k(sql: &str) -> SqlKind {
        classify(sql)
    }

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
    fn data_modifying_cte_is_write() {
        // The bypass found in testing: a write hidden in a CTE, wrapped in SELECT.
        assert_eq!(
            k("WITH w AS (UPDATE users SET id = id WHERE false RETURNING 1) SELECT count(*) FROM w"),
            SqlKind::Write
        );
        assert_eq!(
            k("WITH w AS (INSERT INTO t VALUES (1) RETURNING 1) SELECT * FROM w"),
            SqlKind::Write
        );
    }

    #[test]
    fn select_into_is_write() {
        // SELECT … INTO creates/writes a table despite reading like a SELECT.
        assert_eq!(k("SELECT id INTO new_t FROM users WHERE false"), SqlKind::Write);
        assert_eq!(k("SELECT id INTO TEMPORARY new_t FROM users"), SqlKind::Write);
    }

    #[test]
    fn explain_analyze_write_is_write() {
        // EXPLAIN ANALYZE executes the inner statement.
        assert_eq!(k("EXPLAIN ANALYZE INSERT INTO t VALUES (1)"), SqlKind::Write);
        // Plain EXPLAIN of a read stays read.
        assert_eq!(k("EXPLAIN SELECT 1"), SqlKind::Read);
    }

    #[test]
    fn read_only_ctes_stay_read() {
        assert_eq!(
            k("WITH a AS (SELECT 1), b AS (SELECT * FROM a) SELECT * FROM b"),
            SqlKind::Read
        );
    }

    #[test]
    fn string_literal_payload_does_not_fool_it() {
        assert_eq!(k("SELECT '; DROP TABLE t'"), SqlKind::Read);
    }

    #[test]
    fn unparseable_or_empty_is_write_fail_closed() {
        assert_eq!(k(""), SqlKind::Write);
        assert_eq!(k("this is not sql @@@"), SqlKind::Write);
    }

    fn flags_of(expose: bool, allow_write: bool) -> HashMap<String, McpConnFlags> {
        let mut m = HashMap::new();
        m.insert("c1".to_string(), McpConnFlags { expose, allow_write, note: String::new() });
        m
    }

    /// AppState backed by a fresh in-memory settings DB with migrations applied.
    async fn mem_state() -> AppState {
        use crate::infrastructure::database::registry::DriverRegistry;
        let pool = sqlx::SqlitePool::connect("sqlite::memory:").await.unwrap();
        sqlx::migrate!("./migrations").run(&pool).await.unwrap();
        AppState {
            db: pool,
            drivers: DriverRegistry::new(),
            biometric_cache: std::sync::Arc::new(tokio::sync::Mutex::new(HashMap::new())),
            biometric_lock: std::sync::Arc::new(tokio::sync::Mutex::new(())),
            schema_indices: std::sync::Arc::new(std::sync::RwLock::new(HashMap::new())),
            mcp_shutdown: std::sync::Arc::new(tokio::sync::Mutex::new(None)),
            mcp_activity: std::sync::Arc::new(std::sync::Mutex::new(std::collections::VecDeque::new())),
        }
    }

    #[tokio::test]
    async fn note_and_flags_are_independent_and_global_prompt_persists() {
        let state = mem_state().await;
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

    #[tokio::test]
    async fn list_connections_includes_context_for_exposed_only() {
        let state = mem_state().await;
        sqlx::query(
            "INSERT INTO connections (id, name, driver, host, port, database_name, username, ssl_mode, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind("c1").bind("Local").bind("sqlite").bind("").bind(0_i64)
        .bind("dev.db").bind("").bind("").bind("")
        .execute(&state.db).await.unwrap();
        set_conn_flags(&state, "c1", true, false).await;
        set_conn_note(&state, "c1", "sandbox").await;

        let list = tool_list_connections(&state).await;
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].context, "sandbox");
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

    #[test]
    fn generated_token_has_prefix_and_length() {
        let t = generate_token();
        assert!(t.starts_with("cbv_"));
        assert!(t.len() >= 4 + 40); // prefix + >= 40 random chars
    }

    #[test]
    fn flags_roundtrip_through_json_map() {
        let mut map = HashMap::new();
        map.insert("c1".to_string(), McpConnFlags { expose: true, allow_write: false, note: String::new() });
        let json = serde_json::to_string(&map).unwrap();
        let back: HashMap<String, McpConnFlags> = serde_json::from_str(&json).unwrap();
        assert!(back.get("c1").unwrap().expose);
        assert!(!back.get("c1").unwrap().allow_write);
    }
}
