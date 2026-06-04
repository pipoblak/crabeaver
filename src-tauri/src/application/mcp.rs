//! MCP application layer: settings I/O, the safety gate, and tool implementations.
use std::collections::HashMap;

use rand::Rng;

use crate::domain::mcp::McpConnFlags;
use crate::infrastructure::database::AppState;

const KEY_PORT: &str = "mcp_port";
const KEY_TOKEN: &str = "mcp_token";
const KEY_FLAGS: &str = "mcp_conn_flags";
pub const DEFAULT_PORT: u16 = 7300;

async fn get(state: &AppState, key: &str) -> Option<String> {
    sqlx::query_scalar::<_, String>("SELECT value FROM settings WHERE key = ?")
        .bind(key)
        .fetch_optional(&state.db)
        .await
        .ok()
        .flatten()
}

async fn set(state: &AppState, key: &str, value: &str) {
    let _ = sqlx::query(
        "INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    )
    .bind(key)
    .bind(value)
    .execute(&state.db)
    .await;
}

/// `cbv_` + 48 base62 chars.
pub fn generate_token() -> String {
    const ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    let mut rng = rand::thread_rng();
    let body: String = (0..48)
        .map(|_| ALPHABET[rng.gen_range(0..ALPHABET.len())] as char)
        .collect();
    format!("cbv_{body}")
}

pub async fn port(state: &AppState) -> u16 {
    get(state, KEY_PORT)
        .await
        .and_then(|s| s.parse().ok())
        .unwrap_or(DEFAULT_PORT)
}

pub async fn set_port(state: &AppState, p: u16) {
    set(state, KEY_PORT, &p.to_string()).await
}

/// Return the existing token, creating + persisting one on first use.
pub async fn ensure_token(state: &AppState) -> String {
    if let Some(t) = get(state, KEY_TOKEN).await {
        return t;
    }
    let t = generate_token();
    set(state, KEY_TOKEN, &t).await;
    t
}

pub async fn token(state: &AppState) -> Option<String> {
    get(state, KEY_TOKEN).await
}

pub async fn rotate_token(state: &AppState) -> String {
    let t = generate_token();
    set(state, KEY_TOKEN, &t).await;
    t
}

pub async fn flags(state: &AppState) -> HashMap<String, McpConnFlags> {
    get(state, KEY_FLAGS)
        .await
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

pub async fn set_flags(state: &AppState, id: &str, f: McpConnFlags) {
    let mut map = flags(state).await;
    map.insert(id.to_string(), f);
    if let Ok(json) = serde_json::to_string(&map) {
        set(state, KEY_FLAGS, &json).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::mcp::McpConnFlags;

    #[test]
    fn generated_token_has_prefix_and_length() {
        let t = generate_token();
        assert!(t.starts_with("cbv_"));
        assert!(t.len() >= 4 + 40); // prefix + >= 40 random chars
    }

    #[test]
    fn flags_roundtrip_through_json_map() {
        let mut map = HashMap::new();
        map.insert("c1".to_string(), McpConnFlags { expose: true, allow_write: false });
        let json = serde_json::to_string(&map).unwrap();
        let back: HashMap<String, McpConnFlags> = serde_json::from_str(&json).unwrap();
        assert!(back.get("c1").unwrap().expose);
        assert!(!back.get("c1").unwrap().allow_write);
    }
}
