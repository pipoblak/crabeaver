//! Query execution use cases. Pure dispatch: load the connection, pick its driver,
//! delegate. Per-query cancellation state lives inside the driver, not here.

use crate::application::connections::load_connection;
use crate::domain::error::DriverError;
use crate::domain::models::query::QueryResult;
use crate::infrastructure::database::AppState;

pub async fn execute(
    state:         &AppState,
    connection_id: &str,
    sql:           &str,
) -> Result<QueryResult, DriverError> {
    let conn = load_connection(state, connection_id).await?;
    let driver = state.drivers.driver_for_str(&conn.driver)?;
    driver.execute(&conn, sql).await
}

/// Execute under engine-enforced read-only semantics (see
/// `DatabaseDriver::execute_readonly`). The MCP gate uses this for any
/// connection without write permission so a write that slips past statement
/// classification still cannot mutate data.
pub async fn execute_readonly(
    state:         &AppState,
    connection_id: &str,
    sql:           &str,
) -> Result<QueryResult, DriverError> {
    let conn = load_connection(state, connection_id).await?;
    let driver = state.drivers.driver_for_str(&conn.driver)?;
    driver.execute_readonly(&conn, sql).await
}

pub async fn cancel(state: &AppState, connection_id: &str) -> Result<(), DriverError> {
    let conn = load_connection(state, connection_id).await?;
    let driver = state.drivers.driver_for_str(&conn.driver)?;
    driver.cancel(&conn).await
}
