//! Tauri command adapter exposing a connector's declared `Capabilities` to the
//! frontend, which mirrors them (`src/connectors/`) to gate UI: a feature is only
//! offered when the active connection's driver reports it.

use tauri::State;

use crate::domain::capabilities::Capabilities;
use crate::infrastructure::database::AppState;

#[tauri::command]
pub async fn connector_capabilities(
    state:  State<'_, AppState>,
    driver: String,
) -> Result<Capabilities, String> {
    state.drivers.capabilities(&driver).map_err(Into::into)
}
