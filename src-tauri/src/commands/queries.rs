use chrono::Local;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager, State};

use crate::infrastructure::database::AppState;

#[derive(Debug, Serialize, Deserialize)]
pub struct QueryFileMeta {
    pub name: String,
    pub path: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct Workspace {
    pub name: String,
    pub queries: Vec<QueryFileMeta>,
}

fn queries_dir_path(app: &AppHandle, configured: Option<String>) -> Result<PathBuf, String> {
    if let Some(p) = configured {
        return Ok(PathBuf::from(p));
    }
    let docs = app.path().document_dir().map_err(|e| e.to_string())?;
    Ok(docs.join("Crabeaver").join("queries"))
}

/// Reject names that are empty or could escape the queries dir via path
/// separators or `..` traversal.
fn valid_name(name: &str) -> Result<(), String> {
    let n = name.trim();
    if n.is_empty() || n.contains('/') || n.contains('\\') || n.contains("..") {
        return Err("Invalid name".into());
    }
    Ok(())
}

/// Resolve the queries dir: read the `queries_dir` setting, fall back to the
/// default path, and ensure it exists. Used by every workspace command.
async fn resolve_queries_dir(
    app: &AppHandle,
    state: &State<'_, AppState>,
) -> Result<PathBuf, String> {
    let row = sqlx::query_scalar::<_, String>(
        "SELECT value FROM settings WHERE key = 'queries_dir'",
    )
    .fetch_optional(&state.db)
    .await
    .map_err(|e| e.to_string())?;

    let dir = queries_dir_path(app, row)?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

/// Idempotent migration: ensure `<dir>/Default/` exists and move every `*.sql`
/// file sitting directly in the root into it, carrying along any sibling
/// `<dir>/.history/<stem>/` history folder. Per-file failures are logged and
/// skipped so one bad file can't abort the whole migration.
fn migrate_root_to_default(dir: &Path) -> Result<(), String> {
    let default = dir.join("Default");
    std::fs::create_dir_all(&default).map_err(|e| e.to_string())?;

    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(e) => return Err(e.to_string()),
    };

    for entry in entries.filter_map(|e| e.ok()) {
        let path = entry.path();
        let is_sql_file = path.extension().map(|ext| ext == "sql").unwrap_or(false)
            && entry.file_type().map(|t| t.is_file()).unwrap_or(false);
        if !is_sql_file {
            continue;
        }

        let file_name = match path.file_name() {
            Some(n) => n.to_os_string(),
            None => continue,
        };

        let target = default.join(&file_name);
        if let Err(e) = std::fs::rename(&path, &target) {
            tracing::warn!("migration: failed to move {:?} into Default/: {}", path, e);
            continue;
        }

        // Move the per-query history folder, if present.
        if let Some(stem) = path.file_stem() {
            let old_history = dir.join(".history").join(stem);
            if old_history.exists() {
                let new_history_parent = default.join(".history");
                if let Err(e) = std::fs::create_dir_all(&new_history_parent) {
                    tracing::warn!(
                        "migration: failed to create {:?}: {}",
                        new_history_parent,
                        e
                    );
                    continue;
                }
                let new_history = new_history_parent.join(stem);
                if let Err(e) = std::fs::rename(&old_history, &new_history) {
                    tracing::warn!(
                        "migration: failed to move history {:?} -> {:?}: {}",
                        old_history,
                        new_history,
                        e
                    );
                }
            }
        }
    }

    Ok(())
}

/// List immediate subdirectories of `dir` as workspaces, excluding hidden dirs
/// (name starts with `.`) and `.history`. Each workspace's direct `*.sql` files
/// become its queries, sorted by name; workspaces are sorted by name too.
fn list_workspaces_in(dir: &Path) -> Result<Vec<Workspace>, String> {
    let mut workspaces: Vec<Workspace> = std::fs::read_dir(dir)
        .map_err(|e| e.to_string())?
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().map(|t| t.is_dir()).unwrap_or(false))
        .filter_map(|e| {
            let path = e.path();
            let name = path.file_name()?.to_str()?.to_string();
            if name.starts_with('.') || name == ".history" {
                return None;
            }

            let mut queries: Vec<QueryFileMeta> = std::fs::read_dir(&path)
                .ok()?
                .filter_map(|e| e.ok())
                .filter(|e| {
                    let p = e.path();
                    p.extension().map(|ext| ext == "sql").unwrap_or(false)
                        && e.file_type().map(|t| t.is_file()).unwrap_or(false)
                })
                .filter_map(|e| {
                    let p = e.path();
                    let qname = p.file_stem()?.to_str()?.to_string();
                    Some(QueryFileMeta {
                        name: qname,
                        path: p.to_string_lossy().to_string(),
                    })
                })
                .collect();
            queries.sort_by(|a, b| a.name.cmp(&b.name));

            Some(Workspace { name, queries })
        })
        .collect();

    workspaces.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(workspaces)
}

/// Create a new workspace dir under `dir`. Errors if a sibling with that name
/// already exists.
fn create_workspace_in(dir: &Path, name: &str) -> Result<(), String> {
    valid_name(name)?;
    let p = dir.join(name.trim());
    if p.exists() {
        return Err("Workspace already exists".into());
    }
    std::fs::create_dir(p).map_err(|e| e.to_string())
}

/// Rename a workspace dir. Errors if the target already exists.
fn rename_workspace_in(dir: &Path, old_name: &str, new_name: &str) -> Result<(), String> {
    valid_name(new_name)?;
    let target = dir.join(new_name.trim());
    if target.exists() {
        return Err("Workspace already exists".into());
    }
    std::fs::rename(dir.join(old_name.trim()), target).map_err(|e| e.to_string())
}

/// Delete a workspace dir and everything inside it.
fn delete_workspace_in(dir: &Path, name: &str) -> Result<(), String> {
    valid_name(name)?;
    std::fs::remove_dir_all(dir.join(name.trim())).map_err(|e| e.to_string())
}

/// Create an empty `*.sql` query inside a workspace, choosing a unique filename:
/// `<name>.sql`, then `<name> (2).sql`, `<name> (3).sql`, … Returns the full path.
fn create_query_in(dir: &Path, workspace: &str, name: &str) -> Result<String, String> {
    valid_name(workspace)?;
    valid_name(name)?;

    let ws_dir = dir.join(workspace.trim());
    if !ws_dir.exists() {
        return Err("Workspace does not exist".into());
    }

    let base = name.trim();
    let mut candidate = ws_dir.join(format!("{}.sql", base));
    let mut n = 2;
    while candidate.exists() {
        candidate = ws_dir.join(format!("{} ({}).sql", base, n));
        n += 1;
    }

    std::fs::write(&candidate, "").map_err(|e| e.to_string())?;
    Ok(candidate.to_string_lossy().to_string())
}

#[tauri::command]
pub async fn get_queries_dir(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let row = sqlx::query_scalar::<_, String>(
        "SELECT value FROM settings WHERE key = 'queries_dir'",
    )
    .fetch_optional(&state.db)
    .await
    .map_err(|e| e.to_string())?;

    let path = queries_dir_path(&app, row)?;
    std::fs::create_dir_all(&path).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().to_string())
}

#[tauri::command]
pub async fn set_queries_dir(
    path: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    std::fs::create_dir_all(&path).map_err(|e| e.to_string())?;
    sqlx::query(
        "INSERT INTO settings (key, value) VALUES ('queries_dir', ?) \
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    )
    .bind(&path)
    .execute(&state.db)
    .await
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn list_query_files(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<Vec<QueryFileMeta>, String> {
    let row = sqlx::query_scalar::<_, String>(
        "SELECT value FROM settings WHERE key = 'queries_dir'",
    )
    .fetch_optional(&state.db)
    .await
    .map_err(|e| e.to_string())?;

    let dir = queries_dir_path(&app, row)?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;

    // read_dir is non-recursive: .history/ contents never appear here
    let mut files: Vec<QueryFileMeta> = std::fs::read_dir(&dir)
        .map_err(|e| e.to_string())?
        .filter_map(|e| e.ok())
        .filter(|e| {
            let p = e.path();
            p.extension().map(|ext| ext == "sql").unwrap_or(false)
                && e.file_type().map(|t| t.is_file()).unwrap_or(false)
        })
        .filter_map(|e| {
            let path = e.path();
            let name = path.file_stem()?.to_str()?.to_string();
            Some(QueryFileMeta {
                name,
                path: path.to_string_lossy().to_string(),
            })
        })
        .collect();

    files.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(files)
}

#[tauri::command]
pub async fn read_query_file(path: String) -> Result<String, String> {
    std::fs::read_to_string(&path).map_err(|e| e.to_string())
}

fn append_snapshot(file_path: &Path, content: &str) -> Result<(), String> {
    let stem = file_path
        .file_stem()
        .unwrap_or_default()
        .to_string_lossy()
        .to_string();
    let parent = file_path.parent().unwrap_or(Path::new("."));
    let history_dir = parent.join(".history").join(&stem);
    std::fs::create_dir_all(&history_dir).map_err(|e| e.to_string())?;

    let timestamp = Local::now().format("%Y-%m-%dT%H-%M-%S").to_string();
    let snapshot_path = history_dir.join(format!("{}.sql", timestamp));
    std::fs::write(&snapshot_path, content).map_err(|e| e.to_string())?;

    // Enforce 50-snapshot cap: sort alphabetically (timestamp names sort chronologically),
    // delete the oldest entries if over the limit.
    let mut snapshots: Vec<PathBuf> = std::fs::read_dir(&history_dir)
        .map_err(|e| e.to_string())?
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| p.extension().map(|ext| ext == "sql").unwrap_or(false))
        .collect();

    if snapshots.len() > 50 {
        snapshots.sort();
        for path in snapshots.iter().take(snapshots.len() - 50) {
            let _ = std::fs::remove_file(path);
        }
    }

    Ok(())
}

#[tauri::command]
pub async fn write_query_file(path: String, content: String) -> Result<(), String> {
    let p = Path::new(&path);
    if let Some(parent) = p.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::write(p, &content).map_err(|e| e.to_string())?;
    append_snapshot(p, &content)
}

#[tauri::command]
pub async fn delete_query_file(path: String) -> Result<(), String> {
    std::fs::remove_file(&path).map_err(|e| e.to_string())
}

/// Write exported result data to the user's Downloads directory and return the
/// full path. `filename` is reduced to a basename (path separators stripped) so a
/// crafted column/table name can't escape the directory.
#[tauri::command]
pub async fn save_to_downloads(
    app:      AppHandle,
    filename: String,
    contents: String,
) -> Result<String, String> {
    let dir = app.path().download_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;

    let safe = filename.replace(['/', '\\'], "_");
    let safe = safe.trim();
    let safe = if safe.is_empty() { "export.txt" } else { safe };

    let path = dir.join(safe);
    std::fs::write(&path, contents).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().to_string())
}

#[tauri::command]
pub async fn rename_query_file(old_path: String, new_path: String) -> Result<(), String> {
    std::fs::rename(&old_path, &new_path).map_err(|e| e.to_string())?;

    let old = Path::new(&old_path);
    let new = Path::new(&new_path);
    if let (Some(old_stem), Some(new_stem), Some(parent)) =
        (old.file_stem(), new.file_stem(), old.parent())
    {
        let old_history = parent.join(".history").join(old_stem);
        if old_history.exists() {
            let new_history = parent.join(".history").join(new_stem);
            let _ = std::fs::rename(old_history, new_history);
        }
    }

    Ok(())
}

#[tauri::command]
pub async fn list_workspaces(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<Vec<Workspace>, String> {
    let dir = resolve_queries_dir(&app, &state).await?;
    migrate_root_to_default(&dir)?;
    list_workspaces_in(&dir)
}

#[tauri::command]
pub async fn create_workspace(
    app: AppHandle,
    state: State<'_, AppState>,
    name: String,
) -> Result<(), String> {
    let dir = resolve_queries_dir(&app, &state).await?;
    create_workspace_in(&dir, &name)
}

#[tauri::command]
pub async fn rename_workspace(
    app: AppHandle,
    state: State<'_, AppState>,
    old_name: String,
    new_name: String,
) -> Result<(), String> {
    let dir = resolve_queries_dir(&app, &state).await?;
    rename_workspace_in(&dir, &old_name, &new_name)
}

#[tauri::command]
pub async fn delete_workspace(
    app: AppHandle,
    state: State<'_, AppState>,
    name: String,
) -> Result<(), String> {
    let dir = resolve_queries_dir(&app, &state).await?;
    delete_workspace_in(&dir, &name)
}

#[tauri::command]
pub async fn create_query(
    app: AppHandle,
    state: State<'_, AppState>,
    workspace: String,
    name: String,
) -> Result<String, String> {
    let dir = resolve_queries_dir(&app, &state).await?;
    create_query_in(&dir, &workspace, &name)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    #[test]
    fn append_snapshot_creates_history_entry() {
        let dir = TempDir::new().unwrap();
        let file = dir.path().join("test.sql");
        fs::write(&file, "SELECT 1").unwrap();

        append_snapshot(&file, "SELECT 1").unwrap();

        let history = dir.path().join(".history").join("test");
        assert!(history.exists(), ".history/test/ should be created");
        assert_eq!(fs::read_dir(&history).unwrap().count(), 1);
    }

    #[test]
    fn append_snapshot_enforces_50_cap() {
        let dir = TempDir::new().unwrap();
        let file = dir.path().join("q.sql");
        fs::write(&file, "").unwrap();

        // Pre-fill history with 51 entries (names sort before timestamp names)
        let history_dir = dir.path().join(".history").join("q");
        fs::create_dir_all(&history_dir).unwrap();
        for i in 0..51u32 {
            fs::write(history_dir.join(format!("{:04}.sql", i)), "x").unwrap();
        }

        // 51 existing + 1 appended = 52; cap removes 2 oldest -> 50
        append_snapshot(&file, "trigger").unwrap();

        let count = fs::read_dir(&history_dir).unwrap().count();
        assert_eq!(count, 50);

        // oldest two pre-filled entries (0000.sql, 0001.sql) should be gone
        assert!(!history_dir.join("0000.sql").exists(), "oldest snapshot should be deleted");
        assert!(!history_dir.join("0001.sql").exists(), "second oldest should be deleted");
        // newer entry should survive
        assert!(history_dir.join("0002.sql").exists(), "newer snapshots should be kept");
    }

    #[test]
    fn list_query_files_filter_excludes_non_sql_and_dirs() {
        let dir = TempDir::new().unwrap();
        let sub = dir.path().join("subdir");
        fs::create_dir_all(&sub).unwrap();
        fs::write(dir.path().join("query.sql"), "").unwrap();
        fs::write(dir.path().join("readme.md"), "").unwrap();

        let files: Vec<_> = fs::read_dir(dir.path())
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| {
                let p = e.path();
                p.extension().map(|ext| ext == "sql").unwrap_or(false)
                    && e.file_type().map(|t| t.is_file()).unwrap_or(false)
            })
            .collect();

        assert_eq!(files.len(), 1);
        assert!(files[0].path().ends_with("query.sql"));
    }

    #[test]
    fn rename_query_file_moves_history_folder() {
        let dir = TempDir::new().unwrap();
        let old_file = dir.path().join("old.sql");
        let new_file = dir.path().join("new.sql");
        fs::write(&old_file, "SELECT 1").unwrap();

        let history = dir.path().join(".history").join("old");
        fs::create_dir_all(&history).unwrap();
        fs::write(history.join("snap.sql"), "SELECT 1").unwrap();

        // Replicate the rename logic (sans async wrapper)
        fs::rename(&old_file, &new_file).unwrap();
        let old_history = dir.path().join(".history").join("old");
        let new_history = dir.path().join(".history").join("new");
        if old_history.exists() {
            fs::rename(&old_history, &new_history).unwrap();
        }

        assert!(new_history.exists());
        assert!(!old_history.exists());
        assert_eq!(fs::read_dir(&new_history).unwrap().count(), 1);
    }

    #[test]
    fn valid_name_rejects_unsafe_and_accepts_plain() {
        assert!(valid_name("a/b").is_err());
        assert!(valid_name("..").is_err());
        assert!(valid_name("").is_err());
        assert!(valid_name("   ").is_err());
        assert!(valid_name("a\\b").is_err());
        assert!(valid_name("Analytics").is_ok());
    }

    #[test]
    fn migration_moves_root_sql_and_history_into_default() {
        let dir = TempDir::new().unwrap();
        let root = dir.path();

        // Root-level query plus its history folder.
        fs::write(root.join("foo.sql"), "SELECT 1").unwrap();
        let history = root.join(".history").join("foo");
        fs::create_dir_all(&history).unwrap();
        fs::write(history.join("snap.sql"), "SELECT 1").unwrap();

        migrate_root_to_default(root).unwrap();

        // foo.sql moved into Default/.
        assert!(!root.join("foo.sql").exists(), "root foo.sql should be moved");
        assert!(root.join("Default").join("foo.sql").exists());

        // History folder moved into Default/.history/foo/.
        let moved_history = root.join("Default").join(".history").join("foo");
        assert!(moved_history.exists(), "history should move into Default/.history/");
        assert_eq!(fs::read_dir(&moved_history).unwrap().count(), 1);
        assert!(!root.join(".history").join("foo").exists());

        // Second run is a no-op (no root .sql left, no error).
        migrate_root_to_default(root).unwrap();
        assert!(root.join("Default").join("foo.sql").exists());
        assert!(!root.join("foo.sql").exists());
    }

    #[test]
    fn create_query_picks_unique_name_on_collision() {
        let dir = TempDir::new().unwrap();
        let root = dir.path();
        fs::create_dir_all(root.join("Default")).unwrap();

        let p1 = create_query_in(root, "Default", "report").unwrap();
        assert!(p1.ends_with("report.sql"));
        assert!(Path::new(&p1).exists());

        // Collision -> "report (2).sql".
        let p2 = create_query_in(root, "Default", "report").unwrap();
        assert!(p2.ends_with("report (2).sql"), "got {p2}");
        assert!(Path::new(&p2).exists());

        // Another collision -> "report (3).sql".
        let p3 = create_query_in(root, "Default", "report").unwrap();
        assert!(p3.ends_with("report (3).sql"), "got {p3}");
    }

    #[test]
    fn create_query_rejects_missing_workspace() {
        let dir = TempDir::new().unwrap();
        assert!(create_query_in(dir.path(), "Nope", "q").is_err());
    }

    #[test]
    fn delete_workspace_removes_dir() {
        let dir = TempDir::new().unwrap();
        let root = dir.path();
        let ws = root.join("Analytics");
        fs::create_dir_all(&ws).unwrap();
        fs::write(ws.join("q.sql"), "SELECT 1").unwrap();
        assert!(ws.exists());

        delete_workspace_in(root, "Analytics").unwrap();
        assert!(!ws.exists(), "workspace dir should be removed");
    }

    #[test]
    fn list_workspaces_excludes_hidden_and_history() {
        let dir = TempDir::new().unwrap();
        let root = dir.path();
        fs::create_dir_all(root.join("Default")).unwrap();
        fs::write(root.join("Default").join("a.sql"), "").unwrap();
        fs::create_dir_all(root.join(".history").join("foo")).unwrap();
        fs::create_dir_all(root.join(".hidden")).unwrap();

        let ws = list_workspaces_in(root).unwrap();
        assert_eq!(ws.len(), 1);
        assert_eq!(ws[0].name, "Default");
        assert_eq!(ws[0].queries.len(), 1);
        assert_eq!(ws[0].queries[0].name, "a");
    }
}
