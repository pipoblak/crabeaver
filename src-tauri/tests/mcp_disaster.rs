//! Disaster tests for the MCP surface — invariants that must never break:
//! an unexposed/non-write connection cannot be mutated, passwords never leak.
use std::collections::HashMap;
use std::sync::{Arc, RwLock};

use sqlx::sqlite::SqlitePoolOptions;
use tempfile::NamedTempFile;
use tokio::sync::Mutex;

use crabeaver_lib::application::mcp;
use crabeaver_lib::domain::mcp::{McpConnFlags, SqlKind};
use crabeaver_lib::infrastructure::database::registry::DriverRegistry;
use crabeaver_lib::infrastructure::database::AppState;

/// AppState backed by an in-memory settings DB, with one sqlite data connection
/// `c1` pointing at `data_path`.
async fn state_with_conn(data_path: &str) -> AppState {
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect("sqlite::memory:")
        .await
        .unwrap();
    sqlx::migrate!("./migrations").run(&pool).await.unwrap();
    sqlx::query(
        "INSERT INTO connections (id, name, driver, host, port, database_name, username, ssl_mode, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind("c1").bind("d").bind("sqlite").bind("").bind(0_i64)
    .bind(data_path).bind("").bind("").bind("")
    .execute(&pool)
    .await
    .unwrap();

    AppState {
        db: pool,
        drivers: DriverRegistry::new(),
        biometric_cache: Arc::new(Mutex::new(HashMap::new())),
        biometric_lock: Arc::new(Mutex::new(())),
        schema_indices: Arc::new(RwLock::new(HashMap::new())),
        mcp_shutdown: Arc::new(Mutex::new(None)),
    }
}

#[tokio::test]
async fn mcp_blocks_writes_on_unexposed_and_non_write_connections() {
    let tmp = NamedTempFile::new().unwrap();
    let state = state_with_conn(tmp.path().to_str().unwrap()).await;

    // Not exposed → even a read is "unknown connection".
    let f = mcp::flags(&state).await;
    assert!(mcp::authorize(&f, "c1", SqlKind::Read).is_err());

    // Exposed read-only → a write is rejected before it ever reaches the driver.
    mcp::set_flags(&state, "c1", McpConnFlags { expose: true, allow_write: false }).await;
    let write = mcp::tool_run_query(&state, "c1", "CREATE TABLE hax (x int)", None).await;
    assert!(write.is_err(), "write must be rejected on a non-write connection");

    // Reads still work.
    let read = mcp::tool_run_query(&state, "c1", "SELECT 1", None).await;
    assert!(read.is_ok(), "reads must work on an exposed connection: {read:?}");
}

#[tokio::test]
async fn mcp_list_connections_never_contains_password() {
    let tmp = NamedTempFile::new().unwrap();
    let state = state_with_conn(tmp.path().to_str().unwrap()).await;
    mcp::set_flags(&state, "c1", McpConnFlags { expose: true, allow_write: false }).await;

    let list = mcp::tool_list_connections(&state).await;
    assert_eq!(list.len(), 1);
    let json = serde_json::to_string(&list).unwrap();
    assert!(!json.to_lowercase().contains("password"), "MCP must never surface a password");
}
