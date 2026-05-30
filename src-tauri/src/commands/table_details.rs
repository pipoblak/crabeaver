//! Tauri command adapter for the table-details inspector. The introspection SQL
//! lives in the connection's driver; this is a thin dispatch.

use tauri::State;

use crate::application::introspection;
use crate::domain::models::schema_details::SchemaDetails;
use crate::domain::models::table_details::TableDetails;
use crate::infrastructure::database::AppState;

#[tauri::command]
pub async fn get_table_details(
    state:         State<'_, AppState>,
    connection_id: String,
    schema:        String,
    table:         String,
) -> Result<TableDetails, String> {
    introspection::table_details(&state, &connection_id, &schema, &table)
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn get_schema_details(
    state:         State<'_, AppState>,
    connection_id: String,
    schema:        String,
) -> Result<SchemaDetails, String> {
    introspection::schema_details(&state, &connection_id, &schema)
        .await
        .map_err(Into::into)
}
