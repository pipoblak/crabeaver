pub mod postgres;

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Instant;
use sqlx::SqlitePool;
use tokio::sync::Mutex;
use crate::infrastructure::database::postgres::PostgresPoolManager;

/// Biometric auth cache: connection_id → last successful auth timestamp.
/// In-memory only — cleared on app restart.
pub type BiometricCache = Arc<Mutex<HashMap<String, Instant>>>;

/// Active query PIDs: connection_id → pg_backend_pid().
/// Used to cancel in-flight queries via pg_cancel_backend().
pub type QueryPids = Arc<Mutex<HashMap<String, i32>>>;

pub struct AppState {
    pub db:              SqlitePool,
    pub pg_pools:        PostgresPoolManager,
    pub biometric_cache: BiometricCache,
    pub biometric_lock:  Arc<Mutex<()>>,
    pub query_pids:      QueryPids,
}
