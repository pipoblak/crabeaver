use crate::domain::models::connection::{Connection, QueryResult};

/// Defines what the application needs from any database engine.
/// Infrastructure layer implements this; domain only defines it.
#[async_trait::async_trait]
pub trait DatabasePort: Send + Sync {
    async fn test(&self, conn: &Connection) -> Result<(), String>;
    async fn execute(&self, conn: &Connection, sql: &str) -> Result<QueryResult, String>;
    async fn schemas(&self, conn: &Connection) -> Result<Vec<SchemaInfo>, String>;
}

#[derive(Debug, serde::Serialize, serde::Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SchemaInfo {
    pub schema: String,
    pub tables: Vec<TableInfo>,
}

#[derive(Debug, serde::Serialize, serde::Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TableInfo {
    pub name:    String,
    pub columns: Vec<crate::domain::models::connection::ColumnInfo>,
}
