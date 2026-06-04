pub mod postgres;
pub mod registry;
pub mod sqlite;

use std::collections::HashMap;
use std::sync::{Arc, RwLock};
use std::time::Instant;

use sqlx::SqlitePool;
use tokio::sync::Mutex;

use crate::domain::models::language::SchemaIndex;
use crate::infrastructure::database::registry::DriverRegistry;

/// Biometric auth cache: connection_id → last successful auth timestamp.
/// In-memory only — cleared on app restart.
pub type BiometricCache = Arc<Mutex<HashMap<String, Instant>>>;

/// Schema indices for table-existence validation, keyed by a frontend-chosen id
/// (e.g. "connectionId:database"). Primed by `set_schema_index`, read by
/// `validate_sql_batch`. A std `RwLock` (not tokio) because the validation path
/// is synchronous and CPU-bound.
pub type SchemaIndexStore = Arc<RwLock<HashMap<String, SchemaIndex>>>;

/// Shared application state managed by Tauri. Engine-agnostic: query execution,
/// pooling, and per-query cancellation all live inside the drivers held by
/// `drivers`, not here.
#[derive(Clone)]
pub struct AppState {
    /// App settings/connections store (SQLite).
    pub db:              SqlitePool,
    /// All database-engine drivers, dispatched by `connection.driver`.
    pub drivers:         DriverRegistry,
    pub biometric_cache: BiometricCache,
    pub biometric_lock:  Arc<Mutex<()>>,
    /// Per-connection table indices used by SQL validation.
    pub schema_indices:  SchemaIndexStore,
    /// Running MCP server control: `Some(sender)` while running. Sending `()` shuts it down.
    pub mcp_shutdown:    Arc<Mutex<Option<tokio::sync::oneshot::Sender<()>>>>,
    /// Ring buffer of recent MCP tool calls (newest-last). Std mutex: pushed from a
    /// sync sink inside the axum handler, so it can't await.
    pub mcp_activity:    Arc<std::sync::Mutex<std::collections::VecDeque<crate::domain::mcp::McpActivityEntry>>>,
}
