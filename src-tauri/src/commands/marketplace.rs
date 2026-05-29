use bytes::Bytes;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::io::{Cursor, Read};

use crate::commands::settings::TokenRule;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct MarketplaceExtension {
    pub publisher: String,
    pub name: String,
    pub display_name: String,
    pub description: String,
    pub version: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ParsedTheme {
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
    pub token_rules: Vec<TokenRule>,
}

#[tauri::command]
pub async fn search_marketplace(query: String) -> Result<Vec<MarketplaceExtension>, String> {
    let client = Client::new();

    let body = serde_json::json!({
        "filters": [{
            "criteria": [
                {"filterType": 8, "value": "Microsoft.VisualStudio.Code"},
                {"filterType": 10, "value": query},
                {"filterType": 5, "value": "Themes"}
            ],
            "pageNumber": 1,
            "pageSize": 20,
            "sortBy": 4,
            "sortOrder": 0
        }],
        "assetTypes": [],
        "flags": 516
    });

    let resp = client
        .post("https://marketplace.visualstudio.com/_apis/public/gallery/extensionquery")
        .header("Content-Type", "application/json")
        .header("Accept", "application/json;api-version=7.1-preview.1")
        .header("User-Agent", "crabeaver/0.1.0")
        .json(&body)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    let json: Value = resp.json().await.map_err(|e| e.to_string())?;

    let mut results = Vec::new();

    if let Some(extensions) = json["results"][0]["extensions"].as_array() {
        for ext in extensions {
            let publisher = ext["publisher"]["publisherName"]
                .as_str()
                .unwrap_or("")
                .to_string();
            let name = ext["extensionName"].as_str().unwrap_or("").to_string();
            let display_name = ext["displayName"].as_str().unwrap_or("").to_string();
            let description = ext["shortDescription"].as_str().unwrap_or("").to_string();
            let version = ext["versions"][0]["version"]
                .as_str()
                .unwrap_or("")
                .to_string();

            // Double-check categories contain "Themes"
            let is_theme = ext["categories"]
                .as_array()
                .map(|cats| cats.iter().any(|c| {
                    c.as_str().unwrap_or("").eq_ignore_ascii_case("themes")
                }))
                .unwrap_or(false);

            if is_theme && !publisher.is_empty() && !name.is_empty() && !version.is_empty() {
                results.push(MarketplaceExtension {
                    publisher,
                    name,
                    display_name,
                    description,
                    version,
                });
            }
        }
    }

    Ok(results)
}

#[tauri::command]
pub async fn install_theme(
    publisher: String,
    name: String,
    version: String,
) -> Result<Vec<ParsedTheme>, String> {
    let client = Client::builder()
        .redirect(reqwest::redirect::Policy::limited(10))
        .build()
        .map_err(|e| e.to_string())?;

    let urls = [
        format!(
            "https://{}.gallery.vsassets.io/_apis/public/gallery/publisher/{}/extension/{}/{}/assetbyname/Microsoft.VisualStudio.Services.VSIXPackage",
            publisher, publisher, name, version
        ),
        format!(
            "https://marketplace.visualstudio.com/_apis/public/gallery/publishers/{}/vsextensions/{}/{}/vspackage",
            publisher, name, version
        ),
    ];

    let mut last_err = String::new();
    let mut bytes_opt: Option<Bytes> = None;

    for url in &urls {
        let resp = client
            .get(url)
            .header("User-Agent", "VSCode/1.90.0")
            .header("Accept", "application/octet-stream")
            .send()
            .await;

        match resp {
            Ok(r) if r.status().is_success() => {
                let b = r.bytes().await.map_err(|e| e.to_string())?;
                // ZIP magic bytes: PK\x03\x04
                if b.len() > 4 && b[0] == 0x50 && b[1] == 0x4B {
                    bytes_opt = Some(b);
                    break;
                } else {
                    last_err = format!("Response is not a valid ZIP ({} bytes, starts with {:?})", b.len(), &b[..4.min(b.len())]);
                }
            }
            Ok(r) => { last_err = format!("HTTP {}", r.status()); }
            Err(e) => { last_err = e.to_string(); }
        }
    }

    let bytes = bytes_opt.ok_or_else(|| format!("Download failed: {}", last_err))?;

    let cursor = Cursor::new(bytes.as_ref());
    let mut archive = zip::ZipArchive::new(cursor).map_err(|e| e.to_string())?;

    let mut theme_contents: Vec<String> = Vec::new();

    for i in 0..archive.len() {
        let mut file = archive.by_index(i).map_err(|e| e.to_string())?;
        let fname = file.name().to_lowercase();

        if fname.contains("themes/") && fname.ends_with(".json") {
            let mut content = String::new();
            if file.read_to_string(&mut content).is_ok() {
                theme_contents.push(content);
            }
        }
    }

    let themes: Vec<ParsedTheme> = theme_contents
        .iter()
        .filter_map(|c| serde_json::from_str::<Value>(c).ok())
        .filter_map(|json| parse_vscode_theme(&json))
        .collect();

    if themes.is_empty() {
        return Err("No themes found in this extension".into());
    }

    Ok(themes)
}

fn parse_vscode_theme(json: &Value) -> Option<ParsedTheme> {
    let colors = json.get("colors")?;
    let theme_type = json["type"].as_str().unwrap_or("dark");

    let (fallback_bg, fallback_fg, fallback_dim) = if theme_type == "light" {
        ("#ffffff", "#333333", "#999999")
    } else {
        ("#1e1e1e", "#cccccc", "#858585")
    };

    let get = |key: &str, fallback: &str| -> String {
        colors[key].as_str().unwrap_or(fallback).to_string()
    };

    let bg = get("editor.background", fallback_bg);
    let sidebar_bg = get("sideBar.background", &bg);
    let activity_bg = get("activityBar.background", &bg);
    let tab_active = get("tab.activeBackground", &bg);
    let tab_inactive = get("tab.inactiveBackground", &sidebar_bg);
    let tab_accent = colors["tab.activeBorderTop"]
        .as_str()
        .or_else(|| colors["focusBorder"].as_str())
        .or_else(|| colors["tab.activeBorder"].as_str())
        .unwrap_or("#007acc")
        .to_string();
    let border = {
        let b = get("sideBar.border", "");
        if b.is_empty() { get("panel.border", "#3c3c3c") } else { b }
    };
    let text = get("editor.foreground", fallback_fg);
    let text_dim = get("tab.inactiveForeground", fallback_dim);
    let text_bright = get("tab.activeForeground", "#ffffff");
    let statusbar = get("statusBar.background", "#007acc");
    let hover = get("list.hoverBackground", &sidebar_bg);

    let name = json["name"].as_str().unwrap_or("Unknown Theme").to_string();
    let token_rules = extract_token_rules(json);

    Some(ParsedTheme {
        name, bg, sidebar_bg, activity_bg, tab_active, tab_inactive,
        tab_accent, border, text, text_dim, text_bright, statusbar, hover,
        token_rules,
    })
}

fn extract_token_rules(json: &Value) -> Vec<TokenRule> {
    let Some(arr) = json.get("tokenColors").and_then(|v| v.as_array()) else {
        return vec![];
    };

    let mut rules = Vec::new();
    for entry in arr {
        let settings = &entry["settings"];
        let foreground = settings["foreground"].as_str()
            .map(|s| s.trim_start_matches('#').to_string());
        let font_style = settings["fontStyle"].as_str()
            .map(|s| s.to_string())
            .filter(|s| !s.is_empty());

        if foreground.is_none() && font_style.is_none() {
            continue;
        }

        let push = |rules: &mut Vec<TokenRule>, token: &str| {
            rules.push(TokenRule {
                token: token.to_string(),
                foreground: foreground.clone(),
                font_style: font_style.clone(),
            });
        };

        match &entry["scope"] {
            Value::String(s) => {
                for scope in s.split(',') {
                    push(&mut rules, scope.trim());
                }
            }
            Value::Array(scopes) => {
                for scope in scopes {
                    if let Some(s) = scope.as_str() {
                        push(&mut rules, s.trim());
                    }
                }
            }
            _ => {}
        }
    }
    rules
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn dracula_json() -> Value {
        json!({
            "name": "Dracula",
            "type": "dark",
            "colors": {
                "editor.background": "#282a36",
                "editor.foreground": "#f8f8f2",
                "sideBar.background": "#21222c",
                "activityBar.background": "#191a21",
                "tab.activeBackground": "#282a36",
                "tab.inactiveBackground": "#21222c",
                "tab.activeBorderTop": "#bd93f9",
                "sideBar.border": "#44475a",
                "tab.inactiveForeground": "#6272a4",
                "tab.activeForeground": "#f8f8f2",
                "statusBar.background": "#6272a4",
                "list.hoverBackground": "#44475a"
            }
        })
    }

    #[test]
    fn parse_dark_theme_maps_all_fields() {
        let theme = parse_vscode_theme(&dracula_json()).unwrap();
        assert_eq!(theme.name, "Dracula");
        assert_eq!(theme.bg, "#282a36");
        assert_eq!(theme.text, "#f8f8f2");
        assert_eq!(theme.sidebar_bg, "#21222c");
        assert_eq!(theme.tab_accent, "#bd93f9");
        assert_eq!(theme.statusbar, "#6272a4");
    }

    #[test]
    fn parse_returns_none_when_colors_missing() {
        let json = json!({ "name": "Bad", "type": "dark" });
        assert!(parse_vscode_theme(&json).is_none());
    }

    #[test]
    fn parse_light_theme_uses_light_fallbacks() {
        let json = json!({
            "name": "Light",
            "type": "light",
            "colors": {}
        });
        let theme = parse_vscode_theme(&json).unwrap();
        assert_eq!(theme.bg, "#ffffff");
        assert_eq!(theme.text, "#333333");
    }

    #[test]
    fn parse_dark_theme_uses_dark_fallbacks() {
        let json = json!({
            "name": "Dark Minimal",
            "type": "dark",
            "colors": {}
        });
        let theme = parse_vscode_theme(&json).unwrap();
        assert_eq!(theme.bg, "#1e1e1e");
        assert_eq!(theme.text, "#cccccc");
        assert_eq!(theme.tab_accent, "#007acc");
    }

    #[test]
    fn tab_accent_falls_back_to_focus_border() {
        let json = json!({
            "name": "T",
            "type": "dark",
            "colors": { "focusBorder": "#ff0000" }
        });
        let theme = parse_vscode_theme(&json).unwrap();
        assert_eq!(theme.tab_accent, "#ff0000");
    }

    #[test]
    fn sidebar_bg_falls_back_to_bg() {
        let json = json!({
            "name": "T",
            "type": "dark",
            "colors": { "editor.background": "#123456" }
        });
        let theme = parse_vscode_theme(&json).unwrap();
        assert_eq!(theme.sidebar_bg, "#123456");
    }

    #[test]
    fn border_falls_back_to_panel_border_then_default() {
        let json_panel = json!({
            "name": "T", "type": "dark",
            "colors": { "panel.border": "#aabbcc" }
        });
        assert_eq!(parse_vscode_theme(&json_panel).unwrap().border, "#aabbcc");

        let json_none = json!({ "name": "T", "type": "dark", "colors": {} });
        assert_eq!(parse_vscode_theme(&json_none).unwrap().border, "#3c3c3c");
    }

    #[test]
    fn unknown_name_falls_back_to_unknown_theme() {
        let json = json!({ "type": "dark", "colors": {} });
        let theme = parse_vscode_theme(&json).unwrap();
        assert_eq!(theme.name, "Unknown Theme");
    }
}
