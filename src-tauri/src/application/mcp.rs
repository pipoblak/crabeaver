//! MCP application layer: settings I/O, the safety gate, and tool implementations.
use std::collections::HashMap;

use rand::Rng;

use crate::domain::mcp::{McpConnFlags, SqlKind};
use crate::infrastructure::database::AppState;

const KEY_PORT: &str = "mcp_port";
const KEY_TOKEN: &str = "mcp_token";
const KEY_FLAGS: &str = "mcp_conn_flags";
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

/// Return the existing token, creating + persisting one on first use.
pub async fn ensure_token(state: &AppState) -> String {
    if let Some(t) = get(state, KEY_TOKEN).await {
        return t;
    }
    let t = generate_token();
    set(state, KEY_TOKEN, &t).await;
    t
}

pub async fn token(state: &AppState) -> Option<String> {
    get(state, KEY_TOKEN).await
}

pub async fn rotate_token(state: &AppState) -> String {
    let t = generate_token();
    set(state, KEY_TOKEN, &t).await;
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
}

/// Only exposed connections, with their write flag. Never includes passwords.
pub async fn tool_list_connections(state: &AppState) -> Vec<ExposedConn> {
    let f = flags(state).await;
    let conns = connections::list(state).await.unwrap_or_default();
    conns
        .into_iter()
        .filter_map(|c| {
            let cf = f.get(&c.id).copied().unwrap_or_default();
            if !cf.expose {
                return None;
            }
            Some(ExposedConn {
                id: c.id,
                name: c.name,
                engine: c.driver,
                database: c.database,
                write_allowed: cf.allow_write,
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
    serde_json::to_value(d).map_err(|e| e.to_string())
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

#[derive(Serialize)]
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
        m.insert("c1".to_string(), McpConnFlags { expose, allow_write });
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

    #[test]
    fn generated_token_has_prefix_and_length() {
        let t = generate_token();
        assert!(t.starts_with("cbv_"));
        assert!(t.len() >= 4 + 40); // prefix + >= 40 random chars
    }

    #[test]
    fn flags_roundtrip_through_json_map() {
        let mut map = HashMap::new();
        map.insert("c1".to_string(), McpConnFlags { expose: true, allow_write: false });
        let json = serde_json::to_string(&map).unwrap();
        let back: HashMap<String, McpConnFlags> = serde_json::from_str(&json).unwrap();
        assert!(back.get("c1").unwrap().expose);
        assert!(!back.get("c1").unwrap().allow_write);
    }
}
