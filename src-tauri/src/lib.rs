mod application;
mod commands;
mod domain;
mod infrastructure;

use commands::marketplace::{install_theme, search_marketplace};
use commands::queries::{
    delete_query_file, get_queries_dir, list_query_files, read_query_file,
    rename_query_file, set_queries_dir, write_query_file,
};
use commands::settings::{delete_theme, get_setting, get_themes, save_theme, set_setting};
use commands::sql_completion::get_sql_completions;
use commands::sql_validation::{validate_sql, validate_sql_batch};
use infrastructure::database::AppState;
use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode};
use std::str::FromStr;
use tauri::Manager;

pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let app_dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&app_dir)?;

            let db_path = app_dir.join("crabeaver.db");
            let db_url = format!("sqlite:{}", db_path.display());

            let pool = tauri::async_runtime::block_on(async {
                let opts = SqliteConnectOptions::from_str(&db_url)?
                    .create_if_missing(true)
                    .journal_mode(SqliteJournalMode::Wal);
                sqlx::SqlitePool::connect_with(opts).await
            })?;

            tauri::async_runtime::block_on(
                sqlx::migrate!("./migrations").run(&pool)
            )?;

            app.manage(AppState { db: pool });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            search_marketplace,
            install_theme,
            get_setting,
            set_setting,
            get_themes,
            save_theme,
            delete_theme,
            get_sql_completions,
            validate_sql,
            validate_sql_batch,
            get_queries_dir,
            set_queries_dir,
            list_query_files,
            read_query_file,
            write_query_file,
            delete_query_file,
            rename_query_file,
        ])
        .run(tauri::generate_context!())
        .expect("error running tauri app");
}
