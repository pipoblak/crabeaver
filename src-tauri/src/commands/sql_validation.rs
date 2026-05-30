//! Tauri command adapters for SQL validation. The validation logic lives in the
//! dialect-specific language service; these dispatch via `application::language`.
//! `dialect` is the connection's driver string (optional — defaults to Postgres).

use tauri::State;

use crate::application::language;
use crate::domain::models::language::{Diagnostic, SchemaTable, StatementInput};
use crate::infrastructure::database::AppState;

#[tauri::command]
pub fn validate_sql(sql: String, dialect: Option<String>) -> Vec<Diagnostic> {
    language::validate(dialect.as_deref(), &sql)
}

#[tauri::command]
pub fn set_schema_index(state: State<'_, AppState>, key: String, tables: Vec<SchemaTable>) {
    language::set_schema_index(&state, key, tables);
}

#[tauri::command]
pub fn validate_sql_batch(
    state:      State<'_, AppState>,
    statements: Vec<StatementInput>,
    schema_key: Option<String>,
    dialect:    Option<String>,
) -> Vec<Diagnostic> {
    language::validate_batch(&state, dialect.as_deref(), &statements, schema_key.as_deref())
}
