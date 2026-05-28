use crate::infrastructure::database::AppState;
use serde::{Deserialize, Serialize};
use tauri::State;

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Theme {
    pub name: String,
    pub bg: String,
    pub sidebar_bg: String,
    pub activity_bg: String,
    pub tab_active: String,
    pub tab_inactive: String,
    pub tab_accent: String,
    pub border: String,
    pub text: String,
    pub text_dim: String,
    pub text_bright: String,
    pub statusbar: String,
    pub hover: String,
}

#[tauri::command]
pub async fn get_setting(
    state: State<'_, AppState>,
    key: String,
) -> Result<Option<String>, String> {
    let row = sqlx::query_scalar::<_, String>("SELECT value FROM settings WHERE key = ?")
        .bind(&key)
        .fetch_optional(&state.db)
        .await
        .map_err(|e| e.to_string())?;
    Ok(row)
}

#[tauri::command]
pub async fn set_setting(
    state: State<'_, AppState>,
    key: String,
    value: String,
) -> Result<(), String> {
    sqlx::query("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
        .bind(&key)
        .bind(&value)
        .execute(&state.db)
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn get_themes(state: State<'_, AppState>) -> Result<Vec<Theme>, String> {
    let rows = sqlx::query_as::<_, (String, String)>("SELECT name, data FROM themes")
        .fetch_all(&state.db)
        .await
        .map_err(|e| e.to_string())?;

    let themes = rows
        .into_iter()
        .filter_map(|(_, data)| serde_json::from_str::<Theme>(&data).ok())
        .collect();

    Ok(themes)
}

#[tauri::command]
pub async fn save_theme(state: State<'_, AppState>, theme: Theme) -> Result<(), String> {
    let data = serde_json::to_string(&theme).map_err(|e| e.to_string())?;
    sqlx::query("INSERT INTO themes (name, data) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET data = excluded.data")
        .bind(&theme.name)
        .bind(&data)
        .execute(&state.db)
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn delete_theme(state: State<'_, AppState>, name: String) -> Result<(), String> {
    sqlx::query("DELETE FROM themes WHERE name = ?")
        .bind(&name)
        .execute(&state.db)
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}
