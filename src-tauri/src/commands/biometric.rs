//! Tauri command adapters for biometric (Touch ID) gating. The platform logic
//! lives in `infrastructure::biometric`; opting a connection in is recorded in the
//! settings store.

use tauri::State;

use crate::infrastructure::biometric;
use crate::infrastructure::database::AppState;
use crate::infrastructure::keychain;

#[tauri::command]
pub async fn biometric_available() -> bool {
    biometric::available()
}

#[tauri::command]
pub async fn biometric_authenticate(reason: String) -> Result<(), String> {
    biometric::authenticate(&reason)
}

#[tauri::command]
pub async fn enable_biometric(state: State<'_, AppState>, id: String) -> Result<(), String> {
    // Refuse to enable the gate unless a password is actually stored to protect.
    keychain::load_password(&id)?;
    let key = format!("biometric_{id}");
    sqlx::query(
        "INSERT INTO settings (key, value) VALUES (?, 'true') ON CONFLICT(key) DO UPDATE SET value = 'true'",
    )
    .bind(&key)
    .execute(&state.db)
    .await
    .map_err(|e| e.to_string())?;
    Ok(())
}
