//! Disaster tests — "things that must never happen."
//!
//! Each pins a security or stability invariant whose violation would be a real
//! bug: a leaked password, an injected DROP, a panic on hostile input. SQLite is
//! used where a live engine is needed (fast, deterministic, no server).

use crabeaver_lib::domain::capabilities::{Driver, SqlDialect};
use crabeaver_lib::domain::models::connection::{Connection, ConnectionView};
use crabeaver_lib::domain::models::language::{SchemaIndex, SchemaTable, StatementInput};
use crabeaver_lib::domain::ports::database_driver::DatabaseDriver;
use crabeaver_lib::domain::ports::language_service::LanguageService;
use crabeaver_lib::infrastructure::database::registry::DriverRegistry;
use crabeaver_lib::infrastructure::database::sqlite::SqliteDriver;
use crabeaver_lib::infrastructure::language::sql::SqlLanguageService;
use tempfile::NamedTempFile;

fn sqlite_conn(path: &str) -> Connection {
    Connection {
        id:         "disaster".into(),
        name:       "d".into(),
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

// ── Hostile schema name must never inject or panic ───────────────────────────

#[tokio::test]
async fn schema_details_rejects_injection_in_schema_name() {
    let tmp = NamedTempFile::new().unwrap();
    let c = sqlite_conn(tmp.path().to_str().unwrap());
    let d = SqliteDriver::new();
    d.execute(&c, "CREATE TABLE keep_me (id INTEGER PRIMARY KEY)").await.unwrap();

    // A schema name carrying SQL must be treated as an opaque value, not executed.
    let evil = "main'; DROP TABLE keep_me; --";
    let sd = d.schema_details(&c, evil).await;
    // Either an empty/bounded result or a typed error — never a panic.
    assert!(sd.is_ok() || sd.is_err());

    // The table must still exist: nothing was dropped.
    let r = d.execute(&c, "SELECT count(*) AS n FROM sqlite_master WHERE name = 'keep_me'").await.unwrap();
    assert_eq!(r.rows[0][0], serde_json::json!(1), "hostile schema name must not drop tables");
}

// ── Secrets must never cross the IPC boundary ────────────────────────────────

#[test]
fn connection_view_never_serializes_a_password() {
    // The frontend only ever receives ConnectionView. It has no password field —
    // a compile-time guarantee. Pin it at runtime so a future careless edit fails.
    let view = ConnectionView {
        id:         "1".into(),
        name:       "n".into(),
        driver:     "postgres".into(),
        host:       "h".into(),
        port:       5432,
        database:   "d".into(),
        username:   "u".into(),
        ssl_mode:   "prefer".into(),
        created_at: "t".into(),
    };
    let json = serde_json::to_value(&view).unwrap();
    assert!(json.get("password").is_none(), "ConnectionView must NEVER carry a password");

    // The internal Connection keeps the password — it stays server-side only.
    let conn = Connection {
        id:         "1".into(),
        name:       "n".into(),
        driver:     "postgres".into(),
        host:       "h".into(),
        port:       5432,
        database:   "d".into(),
        username:   "u".into(),
        password:   "s3cret".into(),
        ssl_mode:   "prefer".into(),
        created_at: "t".into(),
    };
    assert_eq!(
        serde_json::to_value(&conn).unwrap().get("password").and_then(|v| v.as_str()),
        Some("s3cret"),
    );
}

// ── Garbage / hostile driver strings must never panic ────────────────────────

#[test]
fn garbage_driver_strings_error_never_panic() {
    let reg = DriverRegistry::new();
    for bad in ["", "   ", "nosql", "'; DROP TABLE connections; --", "\u{0}", "🦀", "post gres"] {
        assert!(Driver::parse(bad).is_err(), "{bad:?} should not parse");
        assert!(reg.driver_for_str(bad).is_err());
        assert!(reg.capabilities(bad).is_err());
    }
    // Whitespace around a valid driver is tolerated (trimmed), not an error.
    assert!(Driver::parse("  postgres\n").is_ok());
}

// ── Identifier injection must be inert ───────────────────────────────────────

#[tokio::test]
async fn hostile_table_name_cannot_execute_sql() {
    let tmp = NamedTempFile::new().unwrap();
    let c = sqlite_conn(tmp.path().to_str().unwrap());
    let d = SqliteDriver::new();
    d.execute(&c, "CREATE TABLE victim (id INTEGER)").await.unwrap();
    d.execute(&c, "INSERT INTO victim VALUES (1)").await.unwrap();

    // A table name carrying a DROP must be treated as data/identifier, never run.
    let _ = d.table_details(&c, "main", "victim\"; DROP TABLE victim; --").await;

    let r = d.execute(&c, "SELECT COUNT(*) FROM victim").await.unwrap();
    assert_eq!(r.rows[0][0], serde_json::json!(1), "victim must survive the injection attempt");
}

#[test]
fn validate_with_hostile_table_names_does_not_panic() {
    let idx = SchemaIndex::from_tables(&[SchemaTable {
        schema: "main".into(),
        name:   "x\"; DROP TABLE t; --".into(),
    }]);
    let svc = SqlLanguageService::new(SqlDialect::Sqlite);
    let stmts = [StatementInput { start_line: 0, sql: "SELECT * FROM weird".into() }];
    let _ = svc.validate_batch(&stmts, Some(&idx)); // must not panic
}

// ── Capability gating: unsupported ops error, never panic ─────────────────────

#[tokio::test]
async fn unsupported_capabilities_error_not_panic() {
    let tmp = NamedTempFile::new().unwrap();
    let c = sqlite_conn(tmp.path().to_str().unwrap());
    let d = SqliteDriver::new();
    d.execute(&c, "CREATE TABLE t (id INTEGER)").await.unwrap();
    assert!(d.sessions(&c).await.unwrap_err().is_unsupported());
    assert!(d.locks(&c).await.unwrap_err().is_unsupported());
    assert!(d.cancel(&c).await.unwrap_err().is_unsupported());
}

// ── Connecting to nothing fails fast, never creates ──────────────────────────

#[tokio::test]
async fn missing_sqlite_file_errors_without_creating_it() {
    let path = "/no/such/dir/ghost.db";
    let d = SqliteDriver::new();
    assert!(d.test(&sqlite_conn(path)).await.is_err());
    assert!(!std::path::Path::new(path).exists(), "must not create the file");
}

// ── Value decoding must survive anything a column can hold ────────────────────

#[tokio::test]
async fn decode_survives_null_blob_real_and_megabyte_text() {
    let tmp = NamedTempFile::new().unwrap();
    let c = sqlite_conn(tmp.path().to_str().unwrap());
    let d = SqliteDriver::new();
    d.execute(&c, "CREATE TABLE m (i INTEGER, r REAL, t TEXT, b BLOB, n TEXT)").await.unwrap();
    d.execute(&c, "INSERT INTO m VALUES (42, 3.5, 'hi', x'00ff', NULL)").await.unwrap();
    let big = "x".repeat(1_000_000);
    d.execute(&c, &format!("INSERT INTO m VALUES (1, 1.0, '{big}', NULL, NULL)")).await.unwrap();

    let r = d.execute(&c, "SELECT i, r, t, b, n FROM m ORDER BY i DESC").await.unwrap();
    assert_eq!(r.rows[0][0], serde_json::json!(42)); // int stays int
    assert_eq!(r.rows[0][1], serde_json::json!(3.5)); // real keeps its decimal
    assert_eq!(r.rows[0][2], serde_json::json!("hi"));
    assert_eq!(r.rows[0][3], serde_json::json!("00ff")); // blob -> hex
    assert!(r.rows[0][4].is_null()); // NULL -> json null
    // The megabyte cell round-trips without panicking or truncating.
    assert_eq!(r.rows[1][2].as_str().map(|s| s.len()), Some(1_000_000));
}

#[tokio::test]
async fn empty_and_whitespace_sql_does_not_panic() {
    let tmp = NamedTempFile::new().unwrap();
    let c = sqlite_conn(tmp.path().to_str().unwrap());
    let d = SqliteDriver::new();
    // Whatever the result, it must not panic.
    let _ = d.execute(&c, "").await;
    let _ = d.execute(&c, "   \n  ").await;
    let _ = d.execute(&c, "-- just a comment").await;
}

// ── Parser must be bounded — no stack overflow on adversarial input ───────────

#[test]
fn deeply_nested_sql_is_recursion_bounded() {
    let svc = SqlLanguageService::new(SqlDialect::Postgres);
    let depth = 10_000;
    let sql = format!("SELECT {}1{}", "(".repeat(depth), ")".repeat(depth));
    // The recursion guard must trip and produce a diagnostic — never overflow.
    let diags = svc.validate(&sql);
    assert!(!diags.is_empty(), "deeply nested input should be flagged, not crash");
}

#[test]
fn very_wide_sql_does_not_panic_or_hang() {
    let svc = SqlLanguageService::new(SqlDialect::Postgres);
    // 20k projected columns.
    let cols = std::iter::repeat_n("1", 20_000).collect::<Vec<_>>().join(", ");
    let _ = svc.validate(&format!("SELECT {cols}")); // must complete without panic
}

// ── Dialect mismatch is a lint difference, not a crash ───────────────────────

#[test]
fn switching_dialects_never_panics() {
    let sql = "SELECT `x`, \"y\" FROM t WHERE a ILIKE 'b'";
    for dialect in [SqlDialect::Postgres, SqlDialect::MySql, SqlDialect::Sqlite, SqlDialect::Generic] {
        let svc = SqlLanguageService::new(dialect);
        let _ = svc.validate(sql);
        let _ = svc.complete(sql, 5);
    }
}
