use bytes::Bytes;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::io::{Cursor, Read};

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
}

#[tauri::command]
pub async fn search_marketplace(query: String) -> Result<Vec<MarketplaceExtension>, String> {
    let client = Client::new();

    let body = serde_json::json!({
        "filters": [{
            "criteria": [
                {"filterType": 8, "value": "Microsoft.VisualStudio.Code"},
                {"filterType": 10, "value": query},
                {"filterType": 12, "value": "5000"}
            ],
            "pageNumber": 1,
            "pageSize": 20,
            "sortBy": 4,
            "sortOrder": 0
        }],
        "assetTypes": [],
        "flags": 512
    });

    let resp = client
        .post("https://marketplace.visualstudio.com/_apis/public/gallery/extensionquery")
        .header("Content-Type", "application/json")
        .header("Accept", "application/json;api-version=7.1-preview.1")
        .header("User-Agent", "db_ide/0.1.0")
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

            if !publisher.is_empty() && !name.is_empty() && !version.is_empty() {
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

    Some(ParsedTheme {
        name,
        bg,
        sidebar_bg,
        activity_bg,
        tab_active,
        tab_inactive,
        tab_accent,
        border,
        text,
        text_dim,
        text_bright,
        statusbar,
        hover,
    })
}
