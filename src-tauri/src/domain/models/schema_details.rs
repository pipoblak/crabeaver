use serde::{Deserialize, Serialize};

/// The objects that live in one schema, grouped by kind. Produced by
/// `DatabaseDriver::schema_details`. Postgres fills every group; leaner engines
/// (SQLite) populate the kinds they have and leave the rest empty.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SchemaDetails {
    pub schema:             String,
    pub tables:             Vec<ObjectSummary>,
    pub views:              Vec<ObjectSummary>,
    pub materialized_views: Vec<ObjectSummary>,
    pub functions:          Vec<ObjectSummary>,
    pub sequences:          Vec<ObjectSummary>,
}

/// One object in a schema listing. `detail` is a best-effort, engine-specific
/// one-liner (e.g. column count for a table, return type for a function); `None`
/// when the engine has nothing useful to show.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ObjectSummary {
    pub name:   String,
    pub detail: Option<String>,
}
