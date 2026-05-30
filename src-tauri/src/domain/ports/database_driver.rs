use async_trait::async_trait;

use crate::domain::capabilities::Capabilities;
use crate::domain::error::DriverError;
use crate::domain::models::connection::Connection;
use crate::domain::models::query::QueryResult;
use crate::domain::models::schema::SchemaInfo;
use crate::domain::models::session::{Lock, Session};
use crate::domain::models::table_details::TableDetails;

/// Everything the application needs from a database engine. Each engine provides
/// one implementation in `infrastructure/database/<engine>/`. The implementation
/// owns its own connection pools and any per-connection state (e.g. the in-flight
/// query id used by `cancel`).
///
/// ## Contract
/// - A method for a capability this engine lacks MUST return
///   `DriverError::Unsupported`, never panic. The matching `Capabilities` flag
///   MUST be `false` so the frontend never calls it.
/// - Implementations decode/quote all values and identifiers safely: a table or
///   schema name is never string-interpolated into SQL (see disaster tests).
/// - `&self` is shared across async tasks; use interior mutability for pools.
#[async_trait]
pub trait DatabaseDriver: Send + Sync {
    /// What this engine supports (including which `Driver` it is). Must be
    /// consistent: every `false` flag implies the corresponding method returns
    /// `Unsupported`.
    fn capabilities(&self) -> Capabilities;

    // ── Lifecycle ───────────────────────────────────────────────────────────

    /// Open (and cache) a pool for this connection. Used to pre-warm on connect.
    async fn connect(&self, conn: &Connection) -> Result<(), DriverError>;

    /// Close and drop any cached pool for this connection id.
    async fn disconnect(&self, id: &str);

    /// Whether a live (non-closed) pool is currently cached for this id.
    async fn is_connected(&self, id: &str) -> bool;

    /// One-shot connectivity check using a throwaway connection. Never cached.
    async fn test(&self, conn: &Connection) -> Result<(), DriverError>;

    // ── Query ───────────────────────────────────────────────────────────────

    /// Execute a statement and return rows or an affected-row count.
    async fn execute(&self, conn: &Connection, sql: &str) -> Result<QueryResult, DriverError>;

    /// Cancel the query currently in flight for this connection, if the engine
    /// supports it. No-op (Ok) when nothing is running.
    async fn cancel(&self, conn: &Connection) -> Result<(), DriverError>;

    // ── Introspection ────────────────────────────────────────────────────────

    /// Schemas → tables → columns (with FK annotations where available).
    async fn schemas(&self, conn: &Connection) -> Result<Vec<SchemaInfo>, DriverError>;

    /// Databases reachable on the same server. Single-database engines return
    /// just their one database name.
    async fn list_databases(&self, conn: &Connection) -> Result<Vec<String>, DriverError>;

    /// Deep details for one table: columns, constraints, FKs, indexes, DDL.
    async fn table_details(
        &self,
        conn:   &Connection,
        schema: &str,
        table:  &str,
    ) -> Result<TableDetails, DriverError>;

    // ── Server activity (Postgres-style; optional) ───────────────────────────

    /// Active server sessions. `Unsupported` when `capabilities().sessions` is false.
    async fn sessions(&self, conn: &Connection) -> Result<Vec<Session>, DriverError>;

    /// Held/awaited locks. `Unsupported` when `capabilities().locks` is false.
    async fn locks(&self, conn: &Connection) -> Result<Vec<Lock>, DriverError>;
}
