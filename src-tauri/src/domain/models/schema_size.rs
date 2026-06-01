use serde::{Deserialize, Serialize};

/// On-disk sizes for the tables in one schema, plus the schema total. Engines
/// that cannot report per-object size return `DriverError::Unsupported`
/// (see `Capabilities::table_sizes`).
#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SchemaSizes {
    pub schema:      String,
    /// Sum of every table's `bytes` in this schema.
    pub total_bytes: i64,
    pub tables:      Vec<TableSize>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TableSize {
    pub name:  String,
    /// Total on-disk footprint (table heap + indexes + TOAST for Postgres).
    pub bytes: i64,
}
