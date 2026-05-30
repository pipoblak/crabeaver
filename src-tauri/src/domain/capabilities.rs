use serde::{Deserialize, Serialize};

use crate::domain::error::DriverError;

/// Which database engine a connection speaks to. Parsed from the `driver`
/// string stored on every connection. Adding an engine = add a variant here,
/// implement `DatabaseDriver`, and register it (see `infrastructure/database/registry.rs`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Driver {
    Postgres,
    Sqlite,
    MySql,
}

impl Driver {
    /// Parse a stored `driver` string. Accepts common aliases. Unknown strings
    /// return `Config` rather than panicking — a garbage value in the DB must
    /// never crash the app (see disaster tests).
    pub fn parse(s: &str) -> Result<Self, DriverError> {
        match s.trim().to_lowercase().as_str() {
            "postgres" | "postgresql" | "pg" => Ok(Driver::Postgres),
            "sqlite" | "sqlite3"             => Ok(Driver::Sqlite),
            "mysql" | "mariadb"              => Ok(Driver::MySql),
            other => Err(DriverError::Config(format!("unknown database driver '{other}'"))),
        }
    }

    pub fn as_str(&self) -> &'static str {
        match self {
            Driver::Postgres => "postgres",
            Driver::Sqlite   => "sqlite",
            Driver::MySql    => "mysql",
        }
    }

    /// The SQL dialect this engine's language service should use. `None` would be
    /// returned by a future non-SQL engine (DynamoDB/PartiQL); every engine
    /// modeled today is SQL.
    pub fn sql_dialect(&self) -> Option<SqlDialect> {
        match self {
            Driver::Postgres => Some(SqlDialect::Postgres),
            Driver::Sqlite   => Some(SqlDialect::Sqlite),
            Driver::MySql    => Some(SqlDialect::MySql),
        }
    }

    /// Whether connecting requires a password. File-based engines (SQLite) do not,
    /// so the test/connect flow must not demand one for them.
    pub fn requires_password(&self) -> bool {
        match self {
            Driver::Postgres | Driver::MySql => true,
            Driver::Sqlite => false,
        }
    }
}

/// The SQL dialect a connector's language service should parse and complete with.
/// Distinct from `Driver` because several engines can share a dialect family and
/// because non-SQL engines (see `QueryLanguage::PartiQl`) have no SQL dialect.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SqlDialect {
    Postgres,
    MySql,
    Sqlite,
    Generic,
}

/// The query language surface a connector exposes to the editor. `Sql` engines
/// get the SQL editing experience (validation, completion, Monaco `sql`).
/// `PartiQl` is the documented seam for DynamoDB and other NoSQL engines — modeled
/// here so the frontend can branch on it, but not yet implemented.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum QueryLanguage {
    Sql,
    PartiQl,
}

/// What a connector can do. Each `DatabaseDriver` returns its own. The frontend
/// mirrors this (`src/connectors/`) and renders only the features that are `true`,
/// so a connector never offers UI for an operation it would reject with
/// `DriverError::Unsupported`.
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Capabilities {
    pub driver:         Driver,
    pub query_language: QueryLanguage,
    /// `Some` for SQL engines, `None` for non-SQL (PartiQl) engines.
    pub sql_dialect:    Option<SqlDialect>,
    pub schemas:        bool,
    pub list_databases: bool,
    pub table_details:  bool,
    pub schema_details: bool,
    pub sessions:       bool,
    pub locks:          bool,
    pub cancel:         bool,
    pub transactions:   bool,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn driver_parse_accepts_known_aliases() {
        assert_eq!(Driver::parse("postgres").unwrap(), Driver::Postgres);
        assert_eq!(Driver::parse("postgresql").unwrap(), Driver::Postgres);
        assert_eq!(Driver::parse("  PG ").unwrap(), Driver::Postgres);
        assert_eq!(Driver::parse("sqlite").unwrap(), Driver::Sqlite);
        assert_eq!(Driver::parse("MySQL").unwrap(), Driver::MySql);
    }

    #[test]
    fn driver_as_str_roundtrips() {
        for d in [Driver::Postgres, Driver::Sqlite, Driver::MySql] {
            assert_eq!(Driver::parse(d.as_str()).unwrap(), d);
        }
    }

    #[test]
    fn unknown_driver_is_config_error_not_panic() {
        // A garbage / injection-y driver string must never panic — it must surface
        // as a typed Config error (a corrupt DB row should never crash the app).
        for bad in ["", "   ", "nosql", "'; DROP TABLE connections; --"] {
            match Driver::parse(bad) {
                Err(DriverError::Config(_)) => {}
                other => panic!("expected Config error for {bad:?}, got {other:?}"),
            }
        }
    }
}
