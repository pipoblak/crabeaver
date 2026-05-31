//! Tauri command adapters for connections, query execution, and Postgres-style
//! server activity. Each command deserializes its args, calls an `application`
//! use case, and flattens `DriverError` to the `String` the IPC boundary expects.
//! No SQL and no engine logic live here.

use tauri::State;

use crate::application::{connections as app, introspection as introspect, query as query_app};
use crate::domain::models::connection::ConnectionView;
use crate::domain::models::query::QueryResult;
use crate::domain::models::schema::SchemaInfo;
use crate::domain::models::session::{Lock, Session};
use crate::infrastructure::database::AppState;

// ── Connection CRUD ────────────────────────────────────────────────────────

#[tauri::command]
pub async fn list_connections(state: State<'_, AppState>) -> Result<Vec<ConnectionView>, String> {
    app::list(&state).await.map_err(Into::into)
}

#[tauri::command]
pub async fn add_connection(
    state:    State<'_, AppState>,
    conn:     ConnectionView,
    password: String,
) -> Result<ConnectionView, String> {
    app::add(&state, conn, password).await.map_err(Into::into)
}

#[tauri::command]
pub async fn update_connection(
    state:    State<'_, AppState>,
    conn:     ConnectionView,
    password: Option<String>,
) -> Result<(), String> {
    app::update(&state, conn, password).await.map_err(Into::into)
}

#[tauri::command]
pub async fn delete_connection(state: State<'_, AppState>, id: String) -> Result<(), String> {
    app::delete(&state, &id).await.map_err(Into::into)
}

// ── Connection lifecycle ───────────────────────────────────────────────────

#[tauri::command]
pub fn has_password(id: String) -> bool {
    app::has_password(&id)
}

#[tauri::command]
pub async fn test_connection(
    state:    State<'_, AppState>,
    conn:     ConnectionView,
    password: Option<String>,
) -> Result<String, String> {
    app::test(&state, conn, password).await.map_err(Into::into)
}

#[tauri::command]
pub async fn connect(state: State<'_, AppState>, id: String) -> Result<(), String> {
    app::connect(&state, &id).await.map_err(Into::into)
}

#[tauri::command]
pub async fn disconnect(state: State<'_, AppState>, id: String) -> Result<(), String> {
    app::disconnect(&state, &id).await.map_err(Into::into)
}

#[tauri::command]
pub async fn connection_status(state: State<'_, AppState>, id: String) -> Result<bool, String> {
    Ok(app::is_connected(&state, &id).await)
}

#[tauri::command]
pub async fn ping_connection(state: State<'_, AppState>, id: String) -> Result<bool, String> {
    Ok(app::ping(&state, &id).await)
}

// ── Query execution ────────────────────────────────────────────────────────

#[tauri::command]
pub async fn execute_query(
    state:         State<'_, AppState>,
    connection_id: String,
    sql:           String,
) -> Result<QueryResult, String> {
    query_app::execute(&state, &connection_id, &sql).await.map_err(Into::into)
}

#[tauri::command]
pub async fn cancel_query(state: State<'_, AppState>, connection_id: String) -> Result<(), String> {
    query_app::cancel(&state, &connection_id).await.map_err(Into::into)
}

// ── Server activity / introspection ────────────────────────────────────────

#[tauri::command]
pub async fn get_sessions(
    state:         State<'_, AppState>,
    connection_id: String,
) -> Result<Vec<Session>, String> {
    introspect::sessions(&state, &connection_id).await.map_err(Into::into)
}

#[tauri::command]
pub async fn get_locks(
    state:         State<'_, AppState>,
    connection_id: String,
) -> Result<Vec<Lock>, String> {
    introspect::locks(&state, &connection_id).await.map_err(Into::into)
}

#[tauri::command]
pub async fn list_databases(
    state:         State<'_, AppState>,
    connection_id: String,
) -> Result<Vec<String>, String> {
    introspect::list_databases(&state, &connection_id).await.map_err(Into::into)
}

#[tauri::command]
pub async fn get_schemas(
    state:         State<'_, AppState>,
    connection_id: String,
    database:      Option<String>,
) -> Result<Vec<SchemaInfo>, String> {
    introspect::schemas(&state, &connection_id, database).await.map_err(Into::into)
}
