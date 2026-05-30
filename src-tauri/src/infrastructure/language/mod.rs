//! Language services (linting + completion), decoupled per query language. The
//! `sql` service is dialect-parameterized; a future non-SQL engine (DynamoDB /
//! PartiQL) would add its own module and a `service_for` arm.

pub mod sql;

use std::sync::Arc;

use crate::domain::capabilities::Driver;
use crate::domain::ports::language_service::LanguageService;
use crate::infrastructure::language::sql::SqlLanguageService;

/// Resolve the language service for a driver. `None` for an engine whose query
/// language has no service yet (a non-SQL engine). Services are stateless, so this
/// constructs on demand.
pub fn service_for(driver: Driver) -> Option<Arc<dyn LanguageService>> {
    driver
        .sql_dialect()
        .map(|d| Arc::new(SqlLanguageService::new(d)) as Arc<dyn LanguageService>)
}
