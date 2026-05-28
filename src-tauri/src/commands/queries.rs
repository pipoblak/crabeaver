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

fn queries_dir_path(app: &AppHandle, configured: Option<String>) -> Result<PathBuf, String> {
    if let Some(p) = configured {
        return Ok(PathBuf::from(p));
    }
    let docs = app.path().document_dir().map_err(|e| e.to_string())?;
    Ok(docs.join("Crabeaver").join("queries"))
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
}
