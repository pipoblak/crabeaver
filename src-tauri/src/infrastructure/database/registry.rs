use std::sync::Arc;

use crate::domain::capabilities::{Capabilities, Driver};
use crate::domain::error::DriverError;
use crate::domain::ports::database_driver::DatabaseDriver;
use crate::infrastructure::database::postgres::PostgresDriver;

/// Owns one long-lived instance of every database driver. Each driver keeps its
/// own connection pools, so the registry must outlive individual requests — it is
/// constructed once and stored in `AppState`.
///
/// To add an engine: implement `DatabaseDriver`, add a field here, construct it
/// in `new`, and add its `Driver` arm to `driver_for`. Nothing else dispatches.
pub struct DriverRegistry {
    postgres: Arc<dyn DatabaseDriver>,
}

impl Default for DriverRegistry {
    fn default() -> Self {
        Self::new()
    }
}

impl DriverRegistry {
    pub fn new() -> Self {
        Self {
            postgres: Arc::new(PostgresDriver::new()),
        }
    }

    /// Resolve the driver for a parsed `Driver`. Returns `Unsupported` for engines
    /// that are modeled but not yet implemented — never panics.
    pub fn driver_for(&self, driver: Driver) -> Result<Arc<dyn DatabaseDriver>, DriverError> {
        match driver {
            Driver::Postgres => Ok(self.postgres.clone()),
            d @ (Driver::Sqlite | Driver::MySql) => Err(DriverError::Unsupported(format!(
                "the {} driver is not yet implemented",
                d.as_str()
            ))),
        }
    }

    /// Resolve the driver from a stored `driver` string (e.g. on a connection row).
    pub fn driver_for_str(&self, driver: &str) -> Result<Arc<dyn DatabaseDriver>, DriverError> {
        self.driver_for(Driver::parse(driver)?)
    }

    /// Capabilities for a driver string. Used by the frontend to gate UI.
    pub fn capabilities(&self, driver: &str) -> Result<Capabilities, DriverError> {
        Ok(self.driver_for(Driver::parse(driver)?)?.capabilities())
    }

    /// Every registered driver. Lets engine-agnostic call sites (delete/disconnect
    /// a connection whose driver string we don't want to look up) act across all.
    fn all(&self) -> [&Arc<dyn DatabaseDriver>; 1] {
        [&self.postgres]
    }

    /// Drop any cached pool for this id across every driver. A no-op for drivers
    /// holding nothing for the id, so it is safe to call without knowing the engine.
    pub async fn disconnect_all(&self, id: &str) {
        for d in self.all() {
            d.disconnect(id).await;
        }
    }

    /// Whether any driver currently holds a live pool for this id.
    pub async fn is_connected_any(&self, id: &str) -> bool {
        for d in self.all() {
            if d.is_connected(id).await {
                return true;
            }
        }
        false
    }
}
