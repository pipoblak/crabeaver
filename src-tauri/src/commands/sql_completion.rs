//! Tauri command adapter for SQL completion. The completion logic lives in the
//! dialect-specific language service; this dispatches via `application::language`.
//! `dialect` is the connection's driver string (optional — defaults to Postgres).

use crate::application::language;
use crate::domain::models::language::CompletionResult;

#[tauri::command]
pub fn get_sql_completions(
    sql:           String,
    cursor_offset: u32,
    dialect:       Option<String>,
) -> CompletionResult {
    language::complete(dialect.as_deref(), &sql, cursor_offset as usize)
}
