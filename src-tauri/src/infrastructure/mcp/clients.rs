use std::path::PathBuf;

use serde::Serialize;
use serde_json::{json, Value};

/// Merge a Crabeaver MCP entry into a client's `mcpServers` JSON object without
/// clobbering existing servers or unrelated keys.
pub fn merge_mcp_servers(existing: Value, url: &str, token: &str) -> Value {
    let mut root = if existing.is_object() { existing } else { json!({}) };
    let entry = json!({
        "type": "http",
        "url": url,
        "headers": { "Authorization": format!("Bearer {token}") }
    });
    match root.get_mut("mcpServers").and_then(|v| v.as_object_mut()) {
        Some(map) => {
            map.insert("crabeaver".into(), entry);
        }
        None => {
            root.as_object_mut()
                .unwrap()
                .insert("mcpServers".into(), json!({ "crabeaver": entry }));
        }
    }
    root
}

/// Argv for `claude mcp add` (Claude Code special-cases to its CLI).
pub fn claude_code_args(url: &str, token: &str) -> Vec<String> {
    vec![
        "mcp".into(),
        "add".into(),
        "--transport".into(),
        "http".into(),
        "crabeaver".into(),
        url.into(),
        "--header".into(),
        format!("Authorization: Bearer {token}"),
    ]
}

#[derive(Serialize, Clone)]
pub struct ClientTarget {
    pub id: String,
    pub name: String,
    pub installed: bool, // already has a crabeaver entry
    pub detected: bool,  // client present on this machine
    pub can_setup: bool, // we can write its config / run its CLI
}

fn home() -> Option<PathBuf> {
    std::env::var_os("HOME").map(PathBuf::from)
}

/// File-based clients using the generic `mcpServers` shape: (id, label, config path).
fn json_clients() -> Vec<(&'static str, &'static str, Option<PathBuf>)> {
    let h = home();
    vec![
        ("cursor", "Cursor", h.as_ref().map(|h| h.join(".cursor/mcp.json"))),
        ("windsurf", "Windsurf", h.as_ref().map(|h| h.join(".codeium/windsurf/mcp_config.json"))),
    ]
}

fn has_crabeaver(path: &PathBuf) -> bool {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str::<Value>(&s).ok())
        .map(|v| v.get("mcpServers").and_then(|m| m.get("crabeaver")).is_some())
        .unwrap_or(false)
}

fn claude_code_present() -> bool {
    std::process::Command::new("claude")
        .arg("--version")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

pub fn list() -> Vec<ClientTarget> {
    let cc = claude_code_present();
    let mut out = vec![ClientTarget {
        id: "claude-code".into(),
        name: "Claude Code".into(),
        detected: cc,
        installed: false,
        can_setup: cc,
    }];
    for (id, name, path) in json_clients() {
        let detected = path
            .as_ref()
            .map(|p| p.exists() || p.parent().map(|d| d.exists()).unwrap_or(false))
            .unwrap_or(false);
        let installed = path.as_ref().map(has_crabeaver).unwrap_or(false);
        out.push(ClientTarget {
            id: id.into(),
            name: name.into(),
            detected,
            installed,
            can_setup: path.is_some(),
        });
    }
    out
}

/// Install the crabeaver entry into one client.
pub fn install(id: &str, url: &str, token: &str) -> Result<(), String> {
    if id == "claude-code" {
        let status = std::process::Command::new("claude")
            .args(claude_code_args(url, token))
            .status()
            .map_err(|e| format!("claude CLI failed: {e}"))?;
        return if status.success() {
            Ok(())
        } else {
            Err("claude mcp add failed".into())
        };
    }
    let path = json_clients()
        .into_iter()
        .find(|(cid, _, _)| *cid == id)
        .and_then(|(_, _, p)| p)
        .ok_or_else(|| format!("unknown client: {id}"))?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let existing = std::fs::read_to_string(&path)
        .ok()
        .and_then(|s| serde_json::from_str::<Value>(&s).ok())
        .unwrap_or(json!({}));
    let merged = merge_mcp_servers(existing, url, token);
    std::fs::write(&path, serde_json::to_string_pretty(&merged).unwrap()).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn merges_without_clobbering() {
        let existing = json!({
            "mcpServers": { "other": { "type": "http", "url": "x" } },
            "unrelated": 1
        });
        let out = merge_mcp_servers(existing, "http://127.0.0.1:7300/mcp", "tok");
        assert_eq!(out["unrelated"], json!(1));
        assert_eq!(out["mcpServers"]["other"]["url"], json!("x"));
        assert_eq!(out["mcpServers"]["crabeaver"]["type"], json!("http"));
        assert_eq!(out["mcpServers"]["crabeaver"]["headers"]["Authorization"], json!("Bearer tok"));
    }

    #[test]
    fn creates_servers_block_when_missing() {
        let out = merge_mcp_servers(json!({}), "u", "t");
        assert_eq!(out["mcpServers"]["crabeaver"]["url"], json!("u"));
    }

    #[test]
    fn claude_code_cli_args_are_correct() {
        let args = claude_code_args("http://127.0.0.1:7300/mcp", "tok");
        assert_eq!(
            args,
            vec![
                "mcp",
                "add",
                "--transport",
                "http",
                "crabeaver",
                "http://127.0.0.1:7300/mcp",
                "--header",
                "Authorization: Bearer tok"
            ]
        );
    }
}
