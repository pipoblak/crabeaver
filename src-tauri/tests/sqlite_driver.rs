//! End-to-end integration tests for the SQLite driver against a real temp `.db`.
//! These need no external server, so they run in CI and prove the `DatabaseDriver`
//! abstraction is real: a second, genuinely different engine works behind it.

use crabeaver_lib::domain::capabilities::Driver;
use crabeaver_lib::domain::models::connection::Connection;
use crabeaver_lib::domain::ports::database_driver::DatabaseDriver;
use crabeaver_lib::infrastructure::database::registry::DriverRegistry;
use crabeaver_lib::infrastructure::database::sqlite::SqliteDriver;
use tempfile::NamedTempFile;

fn conn(path: &str) -> Connection {
    Connection {
        id:         "it-conn".into(),
        name:       "it".into(),
        driver:     "sqlite".into(),
        host:       String::new(),
        port:       0,
        database:   path.into(),
        username:   String::new(),
        password:   String::new(),
        ssl_mode:   String::new(),
        created_at: String::new(),
    }
}

async fn seed(d: &SqliteDriver, c: &Connection) {
    d.execute(c, "CREATE TABLE authors (id INTEGER PRIMARY KEY, name TEXT NOT NULL)").await.unwrap();
    d.execute(
        c,
        "CREATE TABLE books (id INTEGER PRIMARY KEY, title TEXT, \
         author_id INTEGER REFERENCES authors(id))",
    )
    .await
    .unwrap();
    d.execute(c, "CREATE UNIQUE INDEX books_title_idx ON books(title)").await.unwrap();
    d.execute(c, "INSERT INTO authors (name) VALUES ('Ada'), ('Alan')").await.unwrap();
    d.execute(c, "INSERT INTO books (title, author_id) VALUES ('A', 1), ('B', 2)").await.unwrap();
}

#[tokio::test]
async fn execute_select_returns_typed_rows() {
    let tmp = NamedTempFile::new().unwrap();
    let c = conn(tmp.path().to_str().unwrap());
    let d = SqliteDriver::new();
    seed(&d, &c).await;

    let r = d.execute(&c, "SELECT id, name FROM authors ORDER BY id").await.unwrap();
    assert_eq!(r.columns.len(), 2);
    assert_eq!(r.columns[0].name, "id");
    assert_eq!(r.rows.len(), 2);
    // Integer stays an integer, text stays text.
    assert_eq!(r.rows[0][0], serde_json::json!(1));
    assert_eq!(r.rows[0][1], serde_json::json!("Ada"));
}

#[tokio::test]
async fn execute_handles_dml_and_persists() {
    let tmp = NamedTempFile::new().unwrap();
    let c = conn(tmp.path().to_str().unwrap());
    let d = SqliteDriver::new();
    seed(&d, &c).await;

    d.execute(&c, "INSERT INTO authors (name) VALUES ('Grace')").await.unwrap();
    let r = d.execute(&c, "SELECT COUNT(*) AS n FROM authors").await.unwrap();
    assert_eq!(r.rows[0][0], serde_json::json!(3));
}

#[tokio::test]
async fn schemas_lists_tables_and_marks_fk() {
    let tmp = NamedTempFile::new().unwrap();
    let c = conn(tmp.path().to_str().unwrap());
    let d = SqliteDriver::new();
    seed(&d, &c).await;

    let schemas = d.schemas(&c).await.unwrap();
    assert_eq!(schemas.len(), 1);
    assert_eq!(schemas[0].schema, "main");
    let names: Vec<&str> = schemas[0].tables.iter().map(|t| t.name.as_str()).collect();
    assert!(names.contains(&"authors") && names.contains(&"books"));

    let books = schemas[0].tables.iter().find(|t| t.name == "books").unwrap();
    let author_id = books.columns.iter().find(|c| c.name == "author_id").unwrap();
    assert!(author_id.is_fk, "author_id should be detected as a foreign key");
    assert_eq!(author_id.fk_ref.as_deref(), Some("main.authors"));
}

#[tokio::test]
async fn table_details_reports_columns_fk_indexes_and_ddl() {
    let tmp = NamedTempFile::new().unwrap();
    let c = conn(tmp.path().to_str().unwrap());
    let d = SqliteDriver::new();
    seed(&d, &c).await;

    let td = d.table_details(&c, "main", "books").await.unwrap();
    assert_eq!(td.table, "books");
    assert!(td.columns.iter().any(|c| c.name == "id" && c.is_pk));
    assert!(td.columns.iter().any(|c| c.name == "author_id"));
    assert_eq!(td.foreign_keys.len(), 1);
    assert_eq!(td.foreign_keys[0].ref_table, "authors");
    assert!(td.indexes.iter().any(|i| i.name == "books_title_idx" && i.unique));
    assert!(td.ddl.contains("CREATE TABLE"), "ddl should contain the table definition");
    assert_eq!(td.properties.row_count, Some(2));
}

#[tokio::test]
async fn list_databases_returns_main() {
    let tmp = NamedTempFile::new().unwrap();
    let c = conn(tmp.path().to_str().unwrap());
    let d = SqliteDriver::new();
    seed(&d, &c).await;

    let dbs = d.list_databases(&c).await.unwrap();
    assert!(dbs.contains(&"main".to_string()));
}

#[tokio::test]
async fn unsupported_capabilities_error_cleanly() {
    let tmp = NamedTempFile::new().unwrap();
    let c = conn(tmp.path().to_str().unwrap());
    let d = SqliteDriver::new();
    seed(&d, &c).await;

    // capabilities() says these are off; the methods must say so too — no panic.
    assert!(d.sessions(&c).await.unwrap_err().is_unsupported());
    assert!(d.locks(&c).await.unwrap_err().is_unsupported());
    assert!(d.cancel(&c).await.unwrap_err().is_unsupported());
}

#[tokio::test]
async fn registry_dispatches_by_driver_string() {
    let reg = DriverRegistry::new();
    // Known engines resolve.
    assert!(reg.driver_for(Driver::Sqlite).is_ok());
    assert!(reg.driver_for(Driver::Postgres).is_ok());
    assert_eq!(reg.driver_for(Driver::Sqlite).unwrap().capabilities().driver, Driver::Sqlite);
    // Modeled-but-unimplemented engine returns Unsupported, never panics.
    // (match, not unwrap_err — `dyn DatabaseDriver` isn't Debug.)
    match reg.driver_for(Driver::MySql) {
        Err(e) => assert!(e.is_unsupported()),
        Ok(_) => panic!("MySQL should be Unsupported"),
    }
    // Capabilities lookup by string works through the registry.
    assert_eq!(reg.capabilities("sqlite").unwrap().driver, Driver::Sqlite);
}

#[tokio::test]
async fn connecting_to_a_missing_file_errors_not_creates() {
    let c = conn("/nonexistent/dir/does_not_exist.db");
    let d = SqliteDriver::new();
    // create_if_missing(false): opening a missing file must fail, not create it.
    assert!(d.test(&c).await.is_err());
}
