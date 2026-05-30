//! Schema/metadata use cases. All dispatch to the connection's driver, which
//! returns `DriverError::Unsupported` for anything its `Capabilities` deny.

use crate::application::connections::load_connection;
use crate::domain::error::DriverError;
use crate::domain::models::schema::SchemaInfo;
use crate::domain::models::session::{Lock, Session};
use crate::domain::models::table_details::TableDetails;
use crate::infrastructure::database::AppState;

pub async fn schemas(
    state:         &AppState,
    connection_id: &str,
    database:      Option<String>,
) -> Result<Vec<SchemaInfo>, DriverError> {
    let mut conn = load_connection(state, connection_id).await?;
    // Inspector "database" dropdown: introspect a different database on the same
    // server by overriding the connection's database before dispatch.
    if let Some(db) = database.filter(|d| !d.is_empty()) {
        conn.database = db;
    }
    let driver = state.drivers.driver_for_str(&conn.driver)?;
    driver.schemas(&conn).await
}

pub async fn list_databases(state: &AppState, connection_id: &str) -> Result<Vec<String>, DriverError> {
    let conn = load_connection(state, connection_id).await?;
    let driver = state.drivers.driver_for_str(&conn.driver)?;
    driver.list_databases(&conn).await
}

pub async fn table_details(
    state:         &AppState,
    connection_id: &str,
    schema:        &str,
    table:         &str,
) -> Result<TableDetails, DriverError> {
    let conn = load_connection(state, connection_id).await?;
    let driver = state.drivers.driver_for_str(&conn.driver)?;
    driver.table_details(&conn, schema, table).await
}

pub async fn sessions(state: &AppState, connection_id: &str) -> Result<Vec<Session>, DriverError> {
    let conn = load_connection(state, connection_id).await?;
    let driver = state.drivers.driver_for_str(&conn.driver)?;
    driver.sessions(&conn).await
}

pub async fn locks(state: &AppState, connection_id: &str) -> Result<Vec<Lock>, DriverError> {
    let conn = load_connection(state, connection_id).await?;
    let driver = state.drivers.driver_for_str(&conn.driver)?;
    driver.locks(&conn).await
}
