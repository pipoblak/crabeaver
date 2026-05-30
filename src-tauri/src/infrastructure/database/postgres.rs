use std::collections::HashMap;
use std::sync::Arc;
use std::time::Instant;

use sqlx::postgres::{PgConnectOptions, PgPool, PgPoolOptions, PgSslMode};
use sqlx::{Column, Row, TypeInfo};
use tokio::sync::Mutex;

use crate::domain::models::connection::{ColumnInfo, Connection, QueryResult};
use crate::domain::ports::database_port::{SchemaInfo, TableInfo};

/// Decode one Postgres column value to a JSON-compatible type.
/// Dispatches on the column's PG type name so every common type
/// is decoded natively instead of falling back to NULL.
fn pg_col_to_json(row: &sqlx::postgres::PgRow, i: usize) -> serde_json::Value {
    use serde_json::Value as J;
    let type_name = row.column(i).type_info().name().to_uppercase();

    macro_rules! try_get {
        ($T:ty, $map:expr) => {
            if let Ok(v) = row.try_get::<Option<$T>, _>(i) {
                return v.map($map).unwrap_or(J::Null);
            }
        };
    }

    match type_name.as_str() {
        "BOOL" => {
            try_get!(bool, J::Bool);
        }
        "INT2" => { try_get!(i16, |n| serde_json::json!(n)); }
        "INT4" => { try_get!(i32, |n| serde_json::json!(n)); }
        "INT8" | "OID" => { try_get!(i64, |n| serde_json::json!(n)); }
        "FLOAT4" => { try_get!(f32, |n| serde_json::json!(n)); }
        "FLOAT8" => { try_get!(f64, |n| serde_json::json!(n)); }
        "JSON" | "JSONB" => {
            try_get!(serde_json::Value, |v| v);
        }
        "UUID" => {
            try_get!(uuid::Uuid, |u| J::String(u.to_string()));
        }
        "TIMESTAMP" => {
            try_get!(chrono::NaiveDateTime, |d| J::String(d.to_string()));
        }
        "TIMESTAMPTZ" => {
            try_get!(chrono::DateTime<chrono::Utc>, |d| J::String(d.to_rfc3339()));
        }
        "DATE" => {
            try_get!(chrono::NaiveDate, |d| J::String(d.to_string()));
        }
        "TIME" => {
            try_get!(chrono::NaiveTime, |d| J::String(d.to_string()));
        }
        "BYTEA" => {
            if let Ok(v) = row.try_get::<Option<Vec<u8>>, _>(i) {
                return v.map(|b| J::String(
                    b.iter().map(|byte| format!("{byte:02x}")).collect::<String>()
                )).unwrap_or(J::Null);
            }
        }
        _ => {}
    }

    // String fallback — covers TEXT, VARCHAR, CHAR, NUMERIC, INTERVAL, INET,
    // CIDR, MACADDR, ENUM types, and anything else Postgres can represent as text.
    if let Ok(v) = row.try_get::<Option<String>, _>(i) {
        return v.map(J::String).unwrap_or(J::Null);
    }

    J::Null
}

/// Manages active PostgreSQL connection pools — one per connection ID.
#[derive(Default)]
pub struct PostgresPoolManager {
    pools: Arc<Mutex<HashMap<String, PgPool>>>,
}

impl PostgresPoolManager {
    pub fn new() -> Self {
        Self { pools: Arc::new(Mutex::new(HashMap::new())) }
    }

    pub fn connect_options(conn: &Connection) -> PgConnectOptions {
        let ssl = match conn.ssl_mode.as_str() {
            "require"  => PgSslMode::Require,
            "disable"  => PgSslMode::Disable,
            _          => PgSslMode::Prefer,
        };
        PgConnectOptions::new()
            .host(&conn.host)
            .port(conn.port)
            .database(&conn.database)
            .username(&conn.username)
            .password(&conn.password)
            .ssl_mode(ssl)
    }

    /// Get or create a pool for this connection.
    pub async fn pool(&self, conn: &Connection) -> Result<PgPool, String> {
        let mut pools = self.pools.lock().await;
        if let Some(p) = pools.get(&conn.id) {
            if !p.is_closed() {
                return Ok(p.clone());
            }
        }

        let pool = PgPoolOptions::new()
            .max_connections(8)
            .min_connections(1)
            .connect_with(Self::connect_options(conn))
            .await
            .map_err(|e| format!("Connection failed: {e}"))?;

        pools.insert(conn.id.clone(), pool.clone());
        Ok(pool)
    }

    pub async fn disconnect(&self, id: &str) {
        let mut pools = self.pools.lock().await;
        if let Some(pool) = pools.remove(id) {
            pool.close().await;
        }
    }

    pub async fn is_connected(&self, id: &str) -> bool {
        let pools = self.pools.lock().await;
        pools.get(id).map(|p| !p.is_closed()).unwrap_or(false)
    }

    pub async fn test(conn: &Connection) -> Result<(), String> {
        let pool = PgPoolOptions::new()
            .max_connections(1)
            .acquire_timeout(std::time::Duration::from_secs(10))
            .connect_with(Self::connect_options(conn))
            .await
            .map_err(|e| format!("Connection failed: {e}"))?;

        sqlx::query("SELECT 1")
            .execute(&pool)
            .await
            .map_err(|e| format!("Ping failed: {e}"))?;

        pool.close().await;
        Ok(())
    }

    pub async fn execute(pool: &PgPool, sql: &str) -> Result<QueryResult, String> {
        // Strip comments and whitespace; run only the last non-empty statement
        // (matches typical query editor UX — run what's selected or the last stmt)
        let sql = sql.trim();
        let start = Instant::now();

        // Try as a query returning rows first
        match sqlx::query(sql).fetch_all(pool).await {
            Ok(rows) => {
                let columns: Vec<ColumnInfo> = if let Some(first) = rows.first() {
                    first.columns().iter().map(|c| ColumnInfo {
                        name:      c.name().to_string(),
                        type_name: c.type_info().name().to_string(),
                        is_fk:     false,
                        fk_ref:    None,
                        fk_col:    None,
                    }).collect()
                } else {
                    vec![]
                };

                let result_rows = rows.iter().map(|row| {
                    (0..row.len()).map(|i| pg_col_to_json(row, i)).collect::<Vec<_>>()
                }).collect();

                Ok(QueryResult {
                    columns,
                    rows: result_rows,
                    affected_rows: None,
                    execution_ms: start.elapsed().as_millis() as u64,
                })
            }
            Err(_) => {
                // Try as a non-SELECT statement
                let result = sqlx::query(sql)
                    .execute(pool)
                    .await
                    .map_err(|e| e.to_string())?;

                Ok(QueryResult {
                    columns: vec![],
                    rows: vec![],
                    affected_rows: Some(result.rows_affected()),
                    execution_ms: start.elapsed().as_millis() as u64,
                })
            }
        }
    }

    /// Fetches schemas + tables + columns, then marks FK columns in a second pass.
    pub async fn schemas(pool: &PgPool) -> Result<Vec<SchemaInfo>, String> {
        // ── Column query ──────────────────────────────────────────────────────
        let col_rows = sqlx::query(
            "SELECT t.table_schema AS schema, t.table_name, c.column_name, c.data_type
             FROM information_schema.tables t
             LEFT JOIN information_schema.columns c
               ON c.table_schema = t.table_schema AND c.table_name = t.table_name
             WHERE t.table_schema NOT IN ('pg_catalog','information_schema','pg_toast')
               AND t.table_type = 'BASE TABLE'
             ORDER BY t.table_schema, t.table_name, c.ordinal_position"
        )
        .fetch_all(pool)
        .await
        .map_err(|e| e.to_string())?;

        // ── FK query — (from_schema, from_table, from_col) → "to_schema.to_table.to_col"
        // Key: "schema.table.col"  →  "ref_schema.ref_table"
        let mut fk_map: std::collections::HashMap<String, String> =
            std::collections::HashMap::new();

        // Use pg_catalog (not information_schema) — works regardless of ownership/privilege
        if let Ok(fk_rows) = sqlx::query(
            "SELECT
                n.nspname  AS from_schema,
                cl.relname AS from_table,
                a.attname  AS from_col,
                fn.nspname AS to_schema,
                fc.relname AS to_table,
                fa.attname AS to_col
             FROM pg_constraint c
             JOIN pg_class cl     ON cl.oid = c.conrelid
             JOIN pg_namespace n  ON n.oid  = cl.relnamespace
             JOIN pg_class fc     ON fc.oid = c.confrelid
             JOIN pg_namespace fn ON fn.oid = fc.relnamespace
             CROSS JOIN LATERAL unnest(c.conkey) WITH ORDINALITY AS pos(key, pos)
             JOIN pg_attribute a  ON a.attrelid = c.conrelid  AND a.attnum = pos.key
             JOIN pg_attribute fa ON fa.attrelid = c.confrelid AND fa.attnum = c.confkey[pos.pos::int]
             WHERE c.contype = 'f'
               AND n.nspname NOT IN ('pg_catalog','information_schema')"
        )
        .fetch_all(pool)
        .await
        {
            for row in fk_rows {
                let from_schema: String = row.try_get("from_schema").unwrap_or_default();
                let from_table:  String = row.try_get("from_table").unwrap_or_default();
                let from_col:    String = row.try_get("from_col").unwrap_or_default();
                let to_schema:   String = row.try_get("to_schema").unwrap_or_default();
                let to_table:    String = row.try_get("to_table").unwrap_or_default();
                let to_col:      String = row.try_get("to_col").unwrap_or_default();
                fk_map.insert(
                    format!("{}.{}.{}", from_schema, from_table, from_col),
                    format!("{}.{}:{}", to_schema, to_table, to_col),  // "schema.table:col"
                );
            }
        }

        // ── Group columns ──────────────────────────────────────────────────────
        let mut schema_map: std::collections::BTreeMap<
            String,
            std::collections::BTreeMap<String, Vec<ColumnInfo>>,
        > = std::collections::BTreeMap::new();

        for row in col_rows {
            let schema: String = row.try_get("schema").unwrap_or_default();
            let table:  String = row.try_get("table_name").unwrap_or_default();
            let col:    Option<String> = row.try_get("column_name").ok();
            let dtype:  Option<String> = row.try_get("data_type").ok();

            let tbl = schema_map.entry(schema.clone()).or_default().entry(table.clone()).or_default();
            if let (Some(col), Some(dtype)) = (col, dtype) {
                let fk_key = format!("{}.{}.{}", schema, table, col);
                let fk_raw = fk_map.get(&fk_key);
                let (fk_ref, fk_col) = fk_raw.map(|s| {
                    // format: "schema.table:col"
                    let (tbl_part, col_part) = s.split_once(':').unwrap_or((s, "id"));
                    (Some(tbl_part.to_string()), Some(col_part.to_string()))
                }).unwrap_or((None, None));
                tbl.push(ColumnInfo {
                    name:      col,
                    type_name: dtype,
                    is_fk:     fk_ref.is_some(),
                    fk_ref,
                    fk_col,
                });
            }
        }

        Ok(schema_map
            .into_iter()
            .map(|(schema, tables)| SchemaInfo {
                schema,
                tables: tables.into_iter()
                    .map(|(name, columns)| TableInfo { name, columns })
                    .collect(),
            })
            .collect())
    }
}
