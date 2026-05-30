use tauri::State;
use uuid::Uuid;

use crate::domain::models::connection::{Connection, ConnectionView, QueryResult};
use crate::domain::ports::database_port::SchemaInfo;
use crate::infrastructure::database::postgres::PostgresPoolManager;
use crate::infrastructure::database::AppState;

// ── Keychain helpers ───────────────────────────────────────────────────────
//
// macOS: security-framework legacy API (SecKeychainAddGenericPassword).
//   Items created with this API carry a NULL access-control list, meaning
//   any process on the same user account can read them — no "Allow access?"
//   dialog and no code-signature binding that breaks after every cargo build.
//
// Other platforms: keyring crate (Windows Credential Manager, libsecret …).

const SERVICE: &str = "crabeaver";

// macOS: use the `security` CLI so items are not code-signature bound.
// This prevents the "Allow access to keychain?" dialog that appears in dev
// builds every time the binary changes.
#[cfg(target_os = "macos")]
fn store_password(id: &str, password: &str) -> Result<(), String> {
    // Delete existing entry (ignore errors)
    let _ = std::process::Command::new("security")
        .args(["delete-generic-password", "-s", SERVICE, "-a", id])
        .output();
    let out = std::process::Command::new("security")
        .args(["add-generic-password", "-s", SERVICE, "-a", id, "-w", password])
        .output()
        .map_err(|e| format!("security CLI error: {e}"))?;
    if out.status.success() { Ok(()) } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
}

#[cfg(target_os = "macos")]
fn load_password(id: &str) -> Result<String, String> {
    let out = std::process::Command::new("security")
        .args(["find-generic-password", "-s", SERVICE, "-a", id, "-w"])
        .output()
        .map_err(|e| format!("security CLI error: {e}"))?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
    } else {
        Err("Password not found. Open Settings → Connections and re-enter the password.".into())
    }
}

#[cfg(target_os = "macos")]
fn delete_password(id: &str) {
    let _ = std::process::Command::new("security")
        .args(["delete-generic-password", "-s", SERVICE, "-a", id])
        .output();
}

#[cfg(not(target_os = "macos"))]
fn store_password(id: &str, password: &str) -> Result<(), String> {
    keyring::Entry::new(SERVICE, id)
        .and_then(|e| e.set_password(password))
        .map_err(|e| format!("Keychain write failed: {e}"))
}

#[cfg(not(target_os = "macos"))]
fn load_password(id: &str) -> Result<String, String> {
    keyring::Entry::new(SERVICE, id)
        .and_then(|e| e.get_password())
        .map_err(|e| match e {
            keyring::Error::NoEntry => {
                "Password not found. Open Settings → Connections and re-enter the password.".to_string()
            }
            _ => format!("Keychain read failed: {e}"),
        })
}

#[cfg(not(target_os = "macos"))]
fn delete_password(id: &str) {
    if let Ok(e) = keyring::Entry::new(SERVICE, id) {
        let _ = e.delete_credential();
    }
}

/// Public re-exports used by the biometric module.
pub async fn get_connection_by_id_pub(state: &AppState, id: &str) -> Result<Connection, String> {
    get_connection_by_id(state, id).await
}

pub fn store_password_pub(id: &str, password: &str) -> Result<(), String> {
    store_password(id, password)
}
pub fn load_password_pub(id: &str) -> Result<String, String> {
    load_password(id)
}

// ── Connection CRUD ────────────────────────────────────────────────────────

#[tauri::command]
pub async fn list_connections(state: State<'_, AppState>) -> Result<Vec<ConnectionView>, String> {
    let rows = sqlx::query(
        "SELECT id, name, driver, host, port, database_name, username,
                ssl_mode, created_at
         FROM connections ORDER BY created_at ASC",
    )
    .fetch_all(&state.db)
    .await
    .map_err(|e| e.to_string())?;

    Ok(rows.iter().map(row_to_view).collect())
}

#[tauri::command]
pub async fn add_connection(
    state: State<'_, AppState>,
    conn: ConnectionView,
    password: String,
) -> Result<ConnectionView, String> {
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
    .map_err(|e| e.to_string())?;

    store_password(&id, &password)?;

    Ok(ConnectionView { id, created_at: now, ..conn })
}

#[tauri::command]
pub async fn update_connection(
    state: State<'_, AppState>,
    conn: ConnectionView,
    password: Option<String>,
) -> Result<(), String> {
    let port = conn.port as i64;
    sqlx::query(
        "UPDATE connections SET name=?, host=?, port=?, database_name=?,
         username=?, ssl_mode=? WHERE id=?",
    )
    .bind(&conn.name).bind(&conn.host).bind(port).bind(&conn.database)
    .bind(&conn.username).bind(&conn.ssl_mode).bind(&conn.id)
    .execute(&state.db)
    .await
    .map_err(|e| e.to_string())?;

    match password.filter(|p| !p.is_empty()) {
        Some(pwd) => store_password(&conn.id, &pwd)?,
        None => {
            // Verify keychain entry exists; reject save if there's nothing to keep.
            load_password(&conn.id).map_err(|_| {
                "No password saved yet. Enter a password to save this connection.".to_string()
            })?;
        }
    }

    state.pg_pools.disconnect(&conn.id).await;
    Ok(())
}

#[tauri::command]
pub async fn delete_connection(
    state: State<'_, AppState>,
    id: String,
) -> Result<(), String> {
    state.pg_pools.disconnect(&id).await;
    delete_password(&id);
    sqlx::query("DELETE FROM connections WHERE id = ?")
        .bind(&id)
        .execute(&state.db)
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

// ── Connection lifecycle ───────────────────────────────────────────────────

#[tauri::command]
pub fn has_password(id: String) -> bool {
    load_password(&id).is_ok()
}

#[tauri::command]
pub async fn test_connection(
    state: State<'_, AppState>,
    conn: ConnectionView,
    password: Option<String>,
) -> Result<String, String> {
    let pwd = match password.filter(|p| !p.is_empty()) {
        Some(p) => p,
        None if !conn.id.is_empty() => load_password(&conn.id)?,
        _ => return Err("Password is required".to_string()),
    };
    let database = conn.database.clone();
    PostgresPoolManager::test(&view_with_password(conn, pwd)).await?;
    Ok(format!("Connected to {} successfully", database))
}

#[tauri::command]
pub async fn connect(state: State<'_, AppState>, id: String) -> Result<(), String> {
    // Biometric is handled inside get_connection_by_id (with cache) — no duplicate check here
    let conn = get_connection_by_id(&state, &id).await?;
    state.pg_pools.pool(&conn).await?;
    Ok(())
}

#[tauri::command]
pub async fn disconnect(state: State<'_, AppState>, id: String) -> Result<(), String> {
    state.pg_pools.disconnect(&id).await;
    Ok(())
}

#[tauri::command]
pub async fn connection_status(state: State<'_, AppState>, id: String) -> Result<bool, String> {
    Ok(state.pg_pools.is_connected(&id).await)
}

// ── Query execution ────────────────────────────────────────────────────────

#[tauri::command]
pub async fn execute_query(
    state: State<'_, AppState>,
    connection_id: String,
    sql: String,
) -> Result<QueryResult, String> {
    let conn = get_connection_by_id(&state, &connection_id).await?;
    let pool = state.pg_pools.pool(&conn).await?;

    // Record backend PID so the frontend can cancel via cancel_query
    let pid: i32 = sqlx::query_scalar("SELECT pg_backend_pid()")
        .fetch_one(&pool)
        .await
        .unwrap_or(0);
    state.query_pids.lock().await.insert(connection_id.clone(), pid);

    let result = PostgresPoolManager::execute(&pool, &sql).await;

    // Clear PID after query finishes (success or error)
    state.query_pids.lock().await.remove(&connection_id);

    result
}

#[tauri::command]
pub async fn cancel_query(
    state: State<'_, AppState>,
    connection_id: String,
) -> Result<(), String> {
    let pid = state.query_pids.lock().await.get(&connection_id).copied();
    let Some(pid) = pid else { return Ok(()) };

    let conn = get_connection_by_id(&state, &connection_id).await?;
    let pool = state.pg_pools.pool(&conn).await?;

    sqlx::query("SELECT pg_cancel_backend($1)")
        .bind(pid)
        .execute(&pool)
        .await
        .map_err(|e| e.to_string())?;

    Ok(())
}

// ── Session manager ────────────────────────────────────────────────────────

#[derive(serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Session {
    pub pid:              i32,
    pub usename:          Option<String>,
    pub datname:          Option<String>,
    pub application_name: Option<String>,
    pub state:            Option<String>,
    pub wait_event:       Option<String>,
    pub query_start:      Option<String>,
    pub query:            Option<String>,
    pub client_addr:      Option<String>,
    pub client_port:      Option<i32>,
    pub backend_type:     Option<String>,
}

#[tauri::command]
pub async fn get_sessions(
    state: State<'_, AppState>,
    connection_id: String,
) -> Result<Vec<Session>, String> {
    let conn = get_connection_by_id(&state, &connection_id).await?;
    let pool = state.pg_pools.pool(&conn).await?;

    let rows = sqlx::query(
        "SELECT pid,
                usename,
                datname,
                application_name,
                state,
                wait_event,
                to_char(query_start, 'YYYY-MM-DD HH24:MI:SS.MS') AS query_start,
                left(query, 200) AS query,
                host(client_addr)::text AS client_addr,
                client_port,
                backend_type
         FROM pg_stat_activity
         WHERE pid <> pg_backend_pid()
         ORDER BY query_start DESC NULLS LAST"
    )
    .fetch_all(&pool)
    .await
    .map_err(|e| e.to_string())?;

    use sqlx::Row;
    Ok(rows.iter().map(|r| Session {
        pid:              r.try_get("pid").unwrap_or(0),
        usename:          r.try_get("usename").ok(),
        datname:          r.try_get("datname").ok(),
        application_name: r.try_get("application_name").ok(),
        state:            r.try_get("state").ok(),
        wait_event:       r.try_get("wait_event").ok(),
        query_start:      r.try_get("query_start").ok(),
        query:            r.try_get("query").ok(),
        client_addr:      r.try_get("client_addr").ok(),
        client_port:      r.try_get("client_port").ok(),
        backend_type:     r.try_get("backend_type").ok(),
    }).collect())
}

// ── Lock manager ───────────────────────────────────────────────────────────

#[derive(serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Lock {
    pub pid:              i32,
    pub locktype:         Option<String>,
    pub relation:         Option<String>,
    pub mode:             Option<String>,
    pub granted:          Option<bool>,
    pub usename:          Option<String>,
    pub datname:          Option<String>,
    pub application_name: Option<String>,
    pub state:            Option<String>,
    pub query:            Option<String>,
    pub query_start:      Option<String>,
    pub blocking_pids:    Option<String>,
}

#[tauri::command]
pub async fn get_locks(
    state: State<'_, AppState>,
    connection_id: String,
) -> Result<Vec<Lock>, String> {
    let conn = get_connection_by_id(&state, &connection_id).await?;
    let pool = state.pg_pools.pool(&conn).await?;

    let rows = sqlx::query(
        "SELECT DISTINCT
                l.pid,
                l.locktype,
                CASE WHEN l.relation IS NOT NULL
                     THEN l.relation::regclass::text
                     ELSE NULL
                END AS relation,
                l.mode,
                l.granted,
                a.usename,
                a.datname,
                a.application_name,
                a.state,
                left(a.query, 200)                                  AS query,
                to_char(a.query_start,'YYYY-MM-DD HH24:MI:SS.MS')  AS query_start,
                pg_blocking_pids(l.pid)::text                       AS blocking_pids
         FROM pg_locks l
         LEFT JOIN pg_stat_activity a ON a.pid = l.pid
         WHERE l.pid <> pg_backend_pid()
         ORDER BY l.granted ASC, l.pid ASC"
    )
    .fetch_all(&pool)
    .await
    .map_err(|e| e.to_string())?;

    use sqlx::Row;
    Ok(rows.iter().map(|r| Lock {
        pid:              r.try_get("pid").unwrap_or(0),
        locktype:         r.try_get("locktype").ok(),
        relation:         r.try_get("relation").ok(),
        mode:             r.try_get("mode").ok(),
        granted:          r.try_get("granted").ok(),
        usename:          r.try_get("usename").ok(),
        datname:          r.try_get("datname").ok(),
        application_name: r.try_get("application_name").ok(),
        state:            r.try_get("state").ok(),
        query:            r.try_get("query").ok(),
        query_start:      r.try_get("query_start").ok(),
        blocking_pids:    r.try_get("blocking_pids").ok(),
    }).collect())
}

// ── Schema / DB introspection ──────────────────────────────────────────────

#[tauri::command]
pub async fn list_databases(
    state: State<'_, AppState>,
    connection_id: String,
) -> Result<Vec<String>, String> {
    let conn = get_connection_by_id(&state, &connection_id).await?;
    let pool = state.pg_pools.pool(&conn).await?;
    let rows = sqlx::query(
        "SELECT datname FROM pg_database
         WHERE datistemplate = false ORDER BY datname"
    )
    .fetch_all(&pool)
    .await
    .map_err(|e| e.to_string())?;

    use sqlx::Row;
    Ok(rows.iter().map(|r| r.try_get::<String, _>("datname").unwrap_or_default()).collect())
}

#[tauri::command]
pub async fn get_schemas(
    state: State<'_, AppState>,
    connection_id: String,
    database: Option<String>,
) -> Result<Vec<SchemaInfo>, String> {
    let mut conn = get_connection_by_id(&state, &connection_id).await?;
    if let Some(db) = database.filter(|d| !d.is_empty()) {
        conn.database = db;
        // Temporary pool for the requested database — not stored in the pool manager
        let pool = sqlx::postgres::PgPoolOptions::new()
            .max_connections(2)
            .acquire_timeout(std::time::Duration::from_secs(10))
            .connect_with(PostgresPoolManager::connect_options(&conn))
            .await
            .map_err(|e| format!("Connection failed: {e}"))?;
        return PostgresPoolManager::schemas(&pool).await;
    }
    let pool = state.pg_pools.pool(&conn).await?;
    PostgresPoolManager::schemas(&pool).await
}

// ── Helpers ────────────────────────────────────────────────────────────────

async fn get_connection_by_id(state: &AppState, id: &str) -> Result<Connection, String> {
    // Biometric gate — serialised so only ONE prompt fires even for concurrent calls
    if crate::commands::biometric::is_biometric_required(&state.db, id).await {
        const CACHE_TTL: std::time::Duration = std::time::Duration::from_secs(5 * 60);

        // Acquire global auth lock: first caller authenticates, others wait then hit cache
        let _auth_guard = state.biometric_lock.lock().await;

        let cached = {
            let cache = state.biometric_cache.lock().await;
            cache.get(id).map(|t| t.elapsed() < CACHE_TTL).unwrap_or(false)
        };

        if !cached {
            crate::commands::biometric::authenticate_sync("Authenticate to access database")?;
            state.biometric_cache.lock().await
                .insert(id.to_string(), std::time::Instant::now());
        }
        // _auth_guard drops here — next waiter re-checks cache and skips auth
    }

    let row = sqlx::query(
        "SELECT id, name, driver, host, port, database_name, username,
                ssl_mode, created_at
         FROM connections WHERE id = ?",
    )
    .bind(id)
    .fetch_optional(&state.db)
    .await
    .map_err(|e| e.to_string())?
    .ok_or_else(|| format!("Connection '{}' not found", id))?;

    let view = row_to_view(&row);
    let password = load_password(id)?;
    Ok(view_with_password(view, password))
}

fn view_with_password(view: ConnectionView, password: String) -> Connection {
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
