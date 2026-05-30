use serde::{Deserialize, Serialize};

/// One column in a query result or schema description. Engine-agnostic: drivers
/// fill `type_name` with whatever their server reports. FK fields are populated
/// by schema introspection and default to empty for raw query results.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ColumnInfo {
    pub name:      String,
    pub type_name: String,
    /// True when this column is a foreign key. Populated by schema queries;
    /// defaults to false for QueryResult columns (execute doesn't know FK context).
    #[serde(default)]
    pub is_fk:     bool,
    /// The referenced table (schema.table) when is_fk = true.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fk_ref:    Option<String>,   // "schema.table"
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fk_col:    Option<String>,   // referenced column name
}

/// The result of running one statement. `rows` is a JSON matrix so any engine's
/// value types can be represented uniformly across the IPC boundary.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QueryResult {
    pub columns:       Vec<ColumnInfo>,
    pub rows:          Vec<Vec<serde_json::Value>>,
    pub affected_rows: Option<u64>,
    pub execution_ms:  u64,
}
