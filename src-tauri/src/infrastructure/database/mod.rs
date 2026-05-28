// Concrete DB adapters (PostgreSQL, MySQL, SQLite, etc.)
// Each implements the traits defined in domain::ports.

use sqlx::SqlitePool;

pub struct AppState {
    pub db: SqlitePool,
}
