use serde::{Deserialize, Serialize};

use crate::domain::models::query::ColumnInfo;

/// A namespace of tables. Postgres maps this to a schema; SQLite has a single
/// implicit namespace ("main"); other engines map it to whatever groups tables.
#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SchemaInfo {
    pub schema: String,
    pub tables: Vec<TableInfo>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TableInfo {
    pub name:    String,
    pub columns: Vec<ColumnInfo>,
}
