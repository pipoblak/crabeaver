use serde::{Deserialize, Serialize};

/// Full connection record — internal only, never serialized to the frontend.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Connection {
    pub id:         String,
    pub name:       String,
    pub driver:     String,
    pub host:       String,
    pub port:       u16,
    pub database:   String,
    pub username:   String,
    pub password:   String,
    pub ssl_mode:   String,
    pub created_at: String,
}

/// Safe view sent to the frontend — no password field.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionView {
    pub id:         String,
    pub name:       String,
    pub driver:     String,
    pub host:       String,
    pub port:       u16,
    pub database:   String,
    pub username:   String,
    pub ssl_mode:   String,
    pub created_at: String,
}


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

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QueryResult {
    pub columns:         Vec<ColumnInfo>,
    pub rows:            Vec<Vec<serde_json::Value>>,
    pub affected_rows:   Option<u64>,
    pub execution_ms:    u64,
}
