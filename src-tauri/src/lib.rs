mod application;
mod commands;
mod domain;
mod infrastructure;

use commands::table_details::get_table_details;
use commands::biometric::{biometric_authenticate, biometric_available, enable_biometric};
use commands::connectors::connector_capabilities;
use commands::connections::{
    add_connection, cancel_query, connect, connection_status, delete_connection,
    disconnect, execute_query, get_locks, get_schemas, get_sessions, has_password,
    list_connections, list_databases, test_connection, update_connection,
};
use commands::marketplace::{install_theme, search_marketplace};
use commands::queries::{
    delete_query_file, get_queries_dir, list_query_files, read_query_file,
    rename_query_file, set_queries_dir, write_query_file,
};
use commands::settings::{delete_theme, get_setting, get_themes, save_theme, set_setting};
use commands::sql_completion::get_sql_completions;
use commands::sql_validation::{set_schema_index, validate_sql, validate_sql_batch};
use infrastructure::database::{registry::DriverRegistry, AppState};
use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode};
use std::str::FromStr;
use tauri::Manager;

/// Open the webview DevTools — available only in dev builds.
/// Called from the frontend via F12 or the debug panel.
#[tauri::command]
#[cfg(debug_assertions)]
fn open_devtools(window: tauri::WebviewWindow) {
    window.open_devtools();
}

/// Stub for release builds so the invoke_handler compiles.
#[tauri::command]
#[cfg(not(debug_assertions))]
fn open_devtools() {}

/// Receives log lines forwarded from the frontend (dev builds only).
/// Appears in the same terminal as Rust tracing output.
#[tauri::command]
#[cfg(debug_assertions)]
fn log_from_frontend(level: String, message: String) {
    match level.as_str() {
        "error" => tracing::error!(target: "frontend", "{}", message),
        "warn"  => tracing::warn! (target: "frontend", "{}", message),
        "debug" => tracing::debug!(target: "frontend", "{}", message),
        _       => tracing::info! (target: "frontend", "{}", message),
    }
}

#[tauri::command]
#[cfg(not(debug_assertions))]
fn log_from_frontend(_level: String, _message: String) {}

pub fn run() {
    // Structured logging — reads RUST_LOG env var (default: info).
    // In dev: `RUST_LOG=debug cargo tauri dev` for verbose output.
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new(
                    if cfg!(debug_assertions) { "debug" } else { "warn" }
                )),
        )
        .with_target(false)
        .compact()
        .init();

    tauri::Builder::default()
        .setup(|app| {
            let app_dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&app_dir)?;

            let db_path = app_dir.join("crabeaver.db");
            let db_url = format!("sqlite:{}", db_path.display());

            let pool = tauri::async_runtime::block_on(async {
                let opts = SqliteConnectOptions::from_str(&db_url)?
                    .create_if_missing(true)
                    .journal_mode(SqliteJournalMode::Wal);
                sqlx::SqlitePool::connect_with(opts).await
            })?;

            tauri::async_runtime::block_on(
                sqlx::migrate!("./migrations").run(&pool)
            )?;

            tracing::info!("Database ready: {}", db_path.display());

            app.manage(AppState {
                db:              pool,
                drivers:         DriverRegistry::new(),
                biometric_cache: std::sync::Arc::new(tokio::sync::Mutex::new(std::collections::HashMap::new())),
                biometric_lock:  std::sync::Arc::new(tokio::sync::Mutex::new(())),
                schema_indices:  std::sync::Arc::new(std::sync::RwLock::new(std::collections::HashMap::new())),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // Table details
            get_table_details,
            // Dev tools
            open_devtools, log_from_frontend,
            // Biometric
            biometric_available, biometric_authenticate, enable_biometric,
            // Connectors
            connector_capabilities,
            // Connections
            list_connections, add_connection, update_connection, delete_connection,
            test_connection, connect, disconnect, connection_status, has_password,
            execute_query, cancel_query, get_locks, get_schemas, get_sessions, list_databases,
            // Themes / settings
            search_marketplace, install_theme,
            get_setting, set_setting, get_themes, save_theme, delete_theme,
            // SQL
            get_sql_completions, validate_sql, validate_sql_batch, set_schema_index,
            // Query files
            get_queries_dir, set_queries_dir, list_query_files,
            read_query_file, write_query_file, delete_query_file, rename_query_file,
        ])
        .run(tauri::generate_context!())
        .expect("error running tauri app");
}
