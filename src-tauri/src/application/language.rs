//! Language use cases: route validation/completion to the right dialect service
//! (by the connection's driver) and own the per-connection schema-index store.

use std::sync::Arc;

use crate::domain::capabilities::{Driver, SqlDialect};
use crate::domain::models::language::{
    CompletionResult, Diagnostic, SchemaIndex, SchemaTable, StatementInput,
};
use crate::domain::ports::language_service::LanguageService;
use crate::infrastructure::database::AppState;
use crate::infrastructure::language::sql::SqlLanguageService;

/// Resolve a language service from an optional driver string via the language
/// registry. Defaults to Postgres (historical behavior / only fully-wired engine)
/// when the driver is absent or unparseable, so the editor always lints with
/// *some* dialect.
fn service(driver: Option<&str>) -> Arc<dyn LanguageService> {
    let drv = driver.and_then(|d| Driver::parse(d).ok()).unwrap_or(Driver::Postgres);
    crate::infrastructure::language::service_for(drv)
        // Only reachable for a future non-SQL engine; fall back to Postgres SQL.
        .unwrap_or_else(|| Arc::new(SqlLanguageService::new(SqlDialect::Postgres)))
}

pub fn validate(driver: Option<&str>, sql: &str) -> Vec<Diagnostic> {
    service(driver).validate(sql)
}

pub fn complete(driver: Option<&str>, sql: &str, cursor: usize) -> CompletionResult {
    service(driver).complete(sql, cursor)
}

pub fn validate_batch(
    state:      &AppState,
    driver:     Option<&str>,
    statements: &[StatementInput],
    schema_key: Option<&str>,
) -> Vec<Diagnostic> {
    let svc = service(driver);
    // Hold the read guard for the whole parallel pass; the borrowed index is
    // shared read-only across rayon workers.
    let store = state.schema_indices.read().ok();
    let idx: Option<&SchemaIndex> =
        store.as_ref().zip(schema_key).and_then(|(map, key)| map.get(key));
    svc.validate_batch(statements, idx)
}

pub fn set_schema_index(state: &AppState, key: String, tables: Vec<SchemaTable>) {
    let idx = SchemaIndex::from_tables(&tables);
    if let Ok(mut map) = state.schema_indices.write() {
        map.insert(key, idx);
    }
}
