//! Connection use cases: CRUD against the local store, the biometric+keychain gate
//! that turns a stored row into a usable `Connection`, and lifecycle (test/connect/
//! disconnect). Engine dispatch happens here via `state.drivers`; no SQL for the
//! *target* database lives in this layer.

use std::time::{Duration, Instant};

use uuid::Uuid;

use crate::domain::capabilities::Driver;
use crate::domain::error::DriverError;
use crate::domain::models::connection::{Connection, ConnectionView};
use crate::infrastructure::biometric;
use crate::infrastructure::database::AppState;
use crate::infrastructure::keychain;

const BIOMETRIC_CACHE_TTL: Duration = Duration::from_secs(5 * 60);

fn db_err(e: impl std::fmt::Display) -> DriverError {
    DriverError::Query(e.to_string())
}

// ── CRUD ─────────────────────────────────────────────────────────────────────

pub async fn list(state: &AppState) -> Result<Vec<ConnectionView>, DriverError> {
    let rows = sqlx::query(
        "SELECT id, name, driver, host, port, database_name, username,
                ssl_mode, created_at
         FROM connections ORDER BY created_at ASC",
    )
    .fetch_all(&state.db)
    .await
    .map_err(db_err)?;

    Ok(rows.iter().map(row_to_view).collect())
}

pub async fn add(
    state:    &AppState,
    conn:     ConnectionView,
    password: String,
) -> Result<ConnectionView, DriverError> {
    let id  = Uuid::new_v4().to_string();
    let now = chrono::Utc::now().to_rfc3339();
    let port = conn.port as i64;

    sqlx::query(
        "INSERT INTO connections
         (id, name, driver, host, port, database_name, username, ssl_mode, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&id).bind(&conn.name).bind(&conn.driver).bind(&conn.host)
    .bind(port).bind(&conn.database).bind(&conn.username)
    .bind(&conn.ssl_mode).bind(&now)
    .execute(&state.db)
    .await
    .map_err(db_err)?;

    keychain::store_password(&id, &password).map_err(DriverError::Auth)?;

    Ok(ConnectionView { id, created_at: now, ..conn })
}

pub async fn update(
    state:    &AppState,
    conn:     ConnectionView,
    password: Option<String>,
) -> Result<(), DriverError> {
    let port = conn.port as i64;
    sqlx::query(
        "UPDATE connections SET name=?, host=?, port=?, database_name=?,
         username=?, ssl_mode=? WHERE id=?",
    )
    .bind(&conn.name).bind(&conn.host).bind(port).bind(&conn.database)
    .bind(&conn.username).bind(&conn.ssl_mode).bind(&conn.id)
    .execute(&state.db)
    .await
    .map_err(db_err)?;

    match password.filter(|p| !p.is_empty()) {
        Some(pwd) => keychain::store_password(&conn.id, &pwd).map_err(DriverError::Auth)?,
        None => {
            // Verify a keychain entry exists; reject the save if there's nothing to keep.
            keychain::load_password(&conn.id).map_err(|_| {
                DriverError::Auth(
                    "No password saved yet. Enter a password to save this connection.".to_string(),
                )
            })?;
        }
    }

    // A changed host/port/db invalidates any open pool.
    state.drivers.disconnect_all(&conn.id).await;
    Ok(())
}

pub async fn delete(state: &AppState, id: &str) -> Result<(), DriverError> {
    state.drivers.disconnect_all(id).await;
    keychain::delete_password(id);
    sqlx::query("DELETE FROM connections WHERE id = ?")
        .bind(id)
        .execute(&state.db)
        .await
        .map_err(db_err)?;
    Ok(())
}

// ── Lifecycle ──────────────────────────────────────────────────────────────────

pub fn has_password(id: &str) -> bool {
    keychain::load_password(id).is_ok()
}

pub async fn test(
    state:    &AppState,
    conn:     ConnectionView,
    password: Option<String>,
) -> Result<String, DriverError> {
    let driver_kind = Driver::parse(&conn.driver)?;
    let pwd = if driver_kind.requires_password() {
        match password.filter(|p| !p.is_empty()) {
            Some(p) => p,
            None if !conn.id.is_empty() => keychain::load_password(&conn.id).map_err(DriverError::Auth)?,
            _ => return Err(DriverError::Auth("Password is required".to_string())),
        }
    } else {
        // File-based engine (SQLite): no password needed.
        password.unwrap_or_default()
    };
    let database = conn.database.clone();
    let driver = state.drivers.driver_for_str(&conn.driver)?;
    driver.test(&view_with_password(conn, pwd)).await?;
    Ok(format!("Connected to {} successfully", database))
}

pub async fn connect(state: &AppState, id: &str) -> Result<(), DriverError> {
    let conn = load_connection(state, id).await?;
    let driver = state.drivers.driver_for_str(&conn.driver)?;
    driver.connect(&conn).await
}

pub async fn disconnect(state: &AppState, id: &str) -> Result<(), DriverError> {
    state.drivers.disconnect_all(id).await;
    Ok(())
}

pub async fn is_connected(state: &AppState, id: &str) -> bool {
    state.drivers.is_connected_any(id).await
}

// ── Shared: stored row → usable Connection ───────────────────────────────────

/// Load the full connection (with password) for `id`, applying the biometric gate.
/// The gate is serialised through `biometric_lock` so concurrent callers trigger a
/// single prompt, and cached for `BIOMETRIC_CACHE_TTL` so repeat calls don't re-prompt.
pub async fn load_connection(state: &AppState, id: &str) -> Result<Connection, DriverError> {
    if biometric::is_required(&state.db, id).await {
        // Acquire the global auth lock: the first caller authenticates, others wait
        // then hit the cache.
        let _auth_guard = state.biometric_lock.lock().await;

        let cached = {
            let cache = state.biometric_cache.lock().await;
            cache.get(id).map(|t| t.elapsed() < BIOMETRIC_CACHE_TTL).unwrap_or(false)
        };

        if !cached {
            biometric::authenticate("Authenticate to access database").map_err(DriverError::Auth)?;
            state.biometric_cache.lock().await.insert(id.to_string(), Instant::now());
        }
        // _auth_guard drops here — the next waiter re-checks the cache and skips auth.
    }

    let row = sqlx::query(
        "SELECT id, name, driver, host, port, database_name, username,
                ssl_mode, created_at
         FROM connections WHERE id = ?",
    )
    .bind(id)
    .fetch_optional(&state.db)
    .await
    .map_err(db_err)?
    .ok_or_else(|| DriverError::NotFound(format!("Connection '{}' not found", id)))?;

    let view = row_to_view(&row);
    let password = keychain::load_password(id).map_err(DriverError::Auth)?;
    Ok(view_with_password(view, password))
}

// ── Row mapping ────────────────────────────────────────────────────────────────

pub(crate) fn view_with_password(view: ConnectionView, password: String) -> Connection {
    Connection {
        id:         view.id,
        name:       view.name,
        driver:     view.driver,
        host:       view.host,
        port:       view.port,
        database:   view.database,
        username:   view.username,
        password,
        ssl_mode:   view.ssl_mode,
        created_at: view.created_at,
    }
}

fn row_to_view(row: &sqlx::sqlite::SqliteRow) -> ConnectionView {
    use sqlx::Row;
    ConnectionView {
        id:         row.try_get("id").unwrap_or_default(),
        name:       row.try_get("name").unwrap_or_default(),
        driver:     row.try_get("driver").unwrap_or_default(),
        host:       row.try_get("host").unwrap_or_default(),
        port:       row.try_get::<i64, _>("port").unwrap_or(5432) as u16,
        database:   row.try_get("database_name").unwrap_or_default(),
        username:   row.try_get("username").unwrap_or_default(),
        ssl_mode:   row.try_get("ssl_mode").unwrap_or_else(|_| "prefer".into()),
        created_at: row.try_get("created_at").unwrap_or_default(),
    }
}
