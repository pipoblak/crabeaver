pub mod postgres;
pub mod registry;

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Instant;

use sqlx::SqlitePool;
use tokio::sync::Mutex;

use crate::infrastructure::database::registry::DriverRegistry;

/// Biometric auth cache: connection_id → last successful auth timestamp.
/// In-memory only — cleared on app restart.
pub type BiometricCache = Arc<Mutex<HashMap<String, Instant>>>;

/// Shared application state managed by Tauri. Engine-agnostic: query execution,
/// pooling, and per-query cancellation all live inside the drivers held by
/// `drivers`, not here.
pub struct AppState {
    /// App settings/connections store (SQLite).
    pub db:              SqlitePool,
    /// All database-engine drivers, dispatched by `connection.driver`.
    pub drivers:         DriverRegistry,
    pub biometric_cache: BiometricCache,
    pub biometric_lock:  Arc<Mutex<()>>,
}
