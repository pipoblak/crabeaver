use std::collections::HashMap;
use std::sync::Arc;

use tauri::{AppHandle, Emitter, State};

use crate::application::mcp as app;
use crate::domain::mcp::{McpActivityEntry, McpConnFlags, McpStatus};
use crate::infrastructure::database::AppState;
use crate::infrastructure::mcp::server::ActivitySink;
use crate::infrastructure::mcp::{clients, server};

const ACTIVITY_CAP: usize = 100;

fn url(port: u16) -> String {
    format!("http://127.0.0.1:{port}/mcp")
}

#[tauri::command]
pub async fn mcp_status(state: State<'_, AppState>) -> Result<McpStatus, String> {
    let running = state.mcp_shutdown.lock().await.is_some();
    let port = app::port(&state).await;
    Ok(McpStatus { running, port, url: url(port), has_token: app::token(&state).await.is_some() })
}

/// Build the activity sink + spawn the server with the CURRENT token, storing the
/// shutdown handle. Shared by start and token-rotate restart so the running server
/// always serves the live token.
async fn spawn(app_handle: &AppHandle, state: &AppState) -> Result<u16, String> {
    let token = app::ensure_token(state).await;
    let port = app::port(state).await;
    // Cheap clone: AppState's fields are pools/Arc-shared, so the server task sees
    // the same connections and settings DB as the app.
    let shared: Arc<AppState> = Arc::new(state.clone());

    let buf = state.mcp_activity.clone();
    let app_for_sink = app_handle.clone();
    let sink: ActivitySink = Arc::new(move |entry: McpActivityEntry| {
        if let Ok(mut b) = buf.lock() {
            b.push_back(entry.clone());
            while b.len() > ACTIVITY_CAP {
                b.pop_front();
            }
        }
        let _ = app_for_sink.emit("mcp-activity", entry);
    });

    let (bound, tx) = server::start(shared, port, token, sink).await?;
    *state.mcp_shutdown.lock().await = Some(tx);
    Ok(bound)
}

#[tauri::command]
pub async fn mcp_start(app_handle: AppHandle, state: State<'_, AppState>) -> Result<McpStatus, String> {
    if state.mcp_shutdown.lock().await.is_some() {
        return Err("already running".into());
    }
    let bound = spawn(&app_handle, state.inner()).await?;
    Ok(McpStatus { running: true, port: bound, url: url(bound), has_token: true })
}

#[tauri::command]
pub async fn mcp_recent_activity(state: State<'_, AppState>) -> Result<Vec<McpActivityEntry>, String> {
    let b = state.mcp_activity.lock().map_err(|_| "activity lock poisoned".to_string())?;
    Ok(b.iter().cloned().collect())
}

#[tauri::command]
pub async fn mcp_stop(state: State<'_, AppState>) -> Result<McpStatus, String> {
    if let Some(tx) = state.mcp_shutdown.lock().await.take() {
        let _ = tx.send(());
    }
    let port = app::port(&state).await;
    Ok(McpStatus { running: false, port, url: url(port), has_token: app::token(&state).await.is_some() })
}

#[tauri::command]
pub async fn mcp_rotate_token(app_handle: AppHandle, state: State<'_, AppState>) -> Result<String, String> {
    let token = app::rotate_token(&state).await;
    // The running server captured the old token at start — restart so it serves the
    // new one. Otherwise every client (incl. already-configured ones) gets 401.
    let was_running = { state.mcp_shutdown.lock().await.take() };
    if let Some(tx) = was_running {
        let _ = tx.send(());
        spawn(&app_handle, state.inner()).await?;
    }
    Ok(token)
}

#[tauri::command]
pub async fn mcp_get_token(state: State<'_, AppState>) -> Result<Option<String>, String> {
    Ok(app::token(&state).await)
}

#[tauri::command]
pub async fn mcp_set_port(state: State<'_, AppState>, port: u16) -> Result<(), String> {
    app::set_port(&state, port).await;
    Ok(())
}

#[tauri::command]
pub async fn mcp_set_connection_flags(
    state: State<'_, AppState>,
    connection_id: String,
    expose: bool,
    allow_write: bool,
) -> Result<(), String> {
    app::set_flags(&state, &connection_id, McpConnFlags { expose, allow_write }).await;
    Ok(())
}

#[tauri::command]
pub async fn mcp_connection_flags(
    state: State<'_, AppState>,
) -> Result<HashMap<String, McpConnFlags>, String> {
    Ok(app::flags(&state).await)
}

#[tauri::command]
pub async fn mcp_list_clients() -> Result<Vec<clients::ClientTarget>, String> {
    Ok(clients::list())
}

#[tauri::command]
pub async fn mcp_setup_client(state: State<'_, AppState>, client_id: String) -> Result<(), String> {
    let token = app::ensure_token(&state).await;
    let port = app::port(&state).await;
    clients::install(&client_id, &url(port), &token)
}
