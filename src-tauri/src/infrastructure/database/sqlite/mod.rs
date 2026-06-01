use std::collections::{BTreeMap, HashMap};
use std::time::Instant;

use async_trait::async_trait;
use sqlx::sqlite::{SqliteConnectOptions, SqlitePool, SqlitePoolOptions, SqliteRow};
use sqlx::{Column, Row, TypeInfo, ValueRef};
use tokio::sync::Mutex;

use crate::domain::capabilities::{Capabilities, Driver, QueryLanguage, SqlDialect};
use crate::domain::error::DriverError;
use crate::domain::models::connection::Connection;
use crate::domain::models::query::{ColumnInfo, QueryResult};
use crate::domain::models::schema::{SchemaInfo, TableInfo};
use crate::domain::models::schema_details::{ObjectSummary, SchemaDetails};
use crate::domain::models::schema_size::SchemaSizes;
use crate::domain::models::session::{Lock, Session};
use crate::domain::models::table_details::{
    ColumnDetail, ConstraintDetail, ForeignKeyDetail, IndexDetail, TableDetails, TableProperties,
};
use crate::domain::ports::database_driver::DatabaseDriver;

/// SQLite has one implicit namespace. We report it under this schema name so the
/// frontend's schema → table tree has a root, like most SQL clients show SQLite.
const MAIN_SCHEMA: &str = "main";

fn conn_err(e: impl std::fmt::Display) -> DriverError {
    DriverError::Connection(format!("Connection failed: {e}"))
}
fn query_err(e: impl std::fmt::Display) -> DriverError {
    DriverError::Query(e.to_string())
}

/// Safely quote a SQL identifier (e.g. a table name) for the rare spots where it
/// cannot be a bound parameter — `COUNT(*) FROM <ident>`. Doubling embedded quotes
/// is the standard escape, so a hostile name like `x"; DROP TABLE y; --` becomes a
/// single quoted identifier, never executable SQL. See the disaster tests.
fn quote_ident(ident: &str) -> String {
    format!("\"{}\"", ident.replace('"', "\"\""))
}

/// Decode one SQLite cell to JSON using the value's *runtime* storage class, so
/// integers stay integers and reals keep their decimals.
fn sqlite_col_to_json(row: &SqliteRow, i: usize) -> serde_json::Value {
    use serde_json::Value as J;
    let raw = match row.try_get_raw(i) {
        Ok(r) => r,
        Err(_) => return J::Null,
    };
    if raw.is_null() {
        return J::Null;
    }
    match raw.type_info().name().to_uppercase().as_str() {
        "INTEGER" => row.try_get::<i64, _>(i).map(|n| serde_json::json!(n)).unwrap_or(J::Null),
        "REAL" => row.try_get::<f64, _>(i).map(|f| serde_json::json!(f)).unwrap_or(J::Null),
        "BLOB" => row
            .try_get::<Vec<u8>, _>(i)
            .map(|b| J::String(b.iter().map(|byte| format!("{byte:02x}")).collect::<String>()))
            .unwrap_or(J::Null),
        // TEXT and anything else: best-effort string.
        _ => row.try_get::<String, _>(i).map(J::String).unwrap_or(J::Null),
    }
}

/// SQLite implementation of `DatabaseDriver`. The connection's `database` field is
/// the path to the `.db` file; host/port/user/password/ssl are unused. Owns one
/// pool per `(connection id, file)`.
#[derive(Default)]
pub struct SqliteDriver {
    pools: Mutex<HashMap<(String, String), SqlitePool>>,
}

impl SqliteDriver {
    pub fn new() -> Self {
        Self::default()
    }

    fn connect_options(conn: &Connection) -> SqliteConnectOptions {
        // Connect to an existing database file; do not silently create one.
        SqliteConnectOptions::new()
            .filename(&conn.database)
            .create_if_missing(false)
    }

    async fn pool(&self, conn: &Connection) -> Result<SqlitePool, DriverError> {
        let key = (conn.id.clone(), conn.database.clone());

        // Fast path: existing live pool. Release the lock before the connect await
        // so a slow open never blocks pool() for other connections.
        {
            let pools = self.pools.lock().await;
            if let Some(p) = pools.get(&key)
                && !p.is_closed()
            {
                return Ok(p.clone());
            }
        }

        let pool = SqlitePoolOptions::new()
            .max_connections(4)
            .connect_with(Self::connect_options(conn))
            .await
            .map_err(conn_err)?;

        // Re-acquire and insert, honoring a race.
        let mut pools = self.pools.lock().await;
        if let Some(p) = pools.get(&key)
            && !p.is_closed()
        {
            return Ok(p.clone());
        }
        pools.insert(key, pool.clone());
        Ok(pool)
    }

    async fn schemas_impl(pool: &SqlitePool) -> Result<Vec<SchemaInfo>, DriverError> {
        // Columns for every user table. `pragma_table_info(m.name)` is correlated
        // with sqlite_master.name — a column reference, never string-injected.
        let col_rows = sqlx::query(
            "SELECT m.name AS table_name, p.name AS column_name, p.type AS data_type
             FROM sqlite_master m
             JOIN pragma_table_info(m.name) p
             WHERE m.type = 'table' AND m.name NOT LIKE 'sqlite_%'
             ORDER BY m.name, p.cid",
        )
        .fetch_all(pool)
        .await
        .map_err(query_err)?;

        // Foreign keys: (table, from_col) -> "main.ref_table:to_col"
        let mut fk_map: HashMap<String, String> = HashMap::new();
        if let Ok(fk_rows) = sqlx::query(
            "SELECT m.name AS table_name, f.\"table\" AS ref_table,
                    f.\"from\" AS from_col, f.\"to\" AS to_col
             FROM sqlite_master m
             JOIN pragma_foreign_key_list(m.name) f
             WHERE m.type = 'table' AND m.name NOT LIKE 'sqlite_%'",
        )
        .fetch_all(pool)
        .await
        {
            for row in fk_rows {
                let table: String = row.try_get("table_name").unwrap_or_default();
                let from_col: String = row.try_get("from_col").unwrap_or_default();
                let ref_table: String = row.try_get("ref_table").unwrap_or_default();
                let to_col: Option<String> = row.try_get("to_col").ok();
                let to_col = to_col.unwrap_or_else(|| "id".to_string());
                fk_map.insert(
                    format!("{}.{}", table, from_col),
                    format!("{}.{}:{}", MAIN_SCHEMA, ref_table, to_col),
                );
            }
        }

        let mut tables: BTreeMap<String, Vec<ColumnInfo>> = BTreeMap::new();
        for row in col_rows {
            let table: String = row.try_get("table_name").unwrap_or_default();
            let col: String = row.try_get("column_name").unwrap_or_default();
            let dtype: String = row.try_get("data_type").unwrap_or_default();
            let fk_raw = fk_map.get(&format!("{}.{}", table, col));
            let (fk_ref, fk_col) = fk_raw
                .map(|s| {
                    let (tbl_part, col_part) = s.split_once(':').unwrap_or((s, "id"));
                    (Some(tbl_part.to_string()), Some(col_part.to_string()))
                })
                .unwrap_or((None, None));
            tables.entry(table).or_default().push(ColumnInfo {
                name: col,
                type_name: dtype,
                is_fk: fk_ref.is_some(),
                fk_ref,
                fk_col,
            });
        }

        Ok(vec![SchemaInfo {
            schema: MAIN_SCHEMA.to_string(),
            tables: tables.into_iter().map(|(name, columns)| TableInfo { name, columns }).collect(),
        }])
    }

    /// Objects in the (single) SQLite schema. SQLite only has tables and views
    /// in `sqlite_master`; functions/sequences/matviews do not exist, so those
    /// groups are always empty. The schema arg is accepted for signature parity
    /// but SQLite has one implicit namespace.
    async fn schema_details_impl(pool: &SqlitePool, schema: &str) -> Result<SchemaDetails, DriverError> {
        let tables = sqlx::query(
            "SELECT name FROM sqlite_master
             WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
             ORDER BY name",
        )
        .fetch_all(pool)
        .await
        .map_err(query_err)?
        .iter()
        .map(|r| ObjectSummary { name: r.try_get::<String, _>("name").unwrap_or_default(), detail: None })
        .collect();

        let views = sqlx::query(
            "SELECT name FROM sqlite_master WHERE type = 'view' ORDER BY name",
        )
        .fetch_all(pool)
        .await
        .map_err(query_err)?
        .iter()
        .map(|r| ObjectSummary { name: r.try_get::<String, _>("name").unwrap_or_default(), detail: None })
        .collect();

        Ok(SchemaDetails {
            schema:             schema.to_string(),
            tables,
            views,
            materialized_views: Vec::new(),
            functions:          Vec::new(),
            sequences:          Vec::new(),
        })
    }

    async fn table_details_impl(
        pool:  &SqlitePool,
        table: &str,
    ) -> Result<TableDetails, DriverError> {
        // Columns. Bind the table name as a value in WHERE; pragma_table_info reads
        // the correlated column — no identifier interpolation.
        let col_rows = sqlx::query(
            "SELECT p.cid, p.name, p.type, p.\"notnull\", p.dflt_value, p.pk
             FROM sqlite_master m JOIN pragma_table_info(m.name) p
             WHERE m.name = ? ORDER BY p.cid",
        )
        .bind(table)
        .fetch_all(pool)
        .await
        .map_err(query_err)?;

        let columns: Vec<ColumnDetail> = col_rows
            .iter()
            .map(|r| {
                let pk: i64 = r.try_get("pk").unwrap_or(0);
                let notnull: i64 = r.try_get("notnull").unwrap_or(0);
                ColumnDetail {
                    ordinal:     r.try_get::<i64, _>("cid").unwrap_or(0) as i32,
                    name:        r.try_get("name").unwrap_or_default(),
                    data_type:   r.try_get("type").unwrap_or_default(),
                    nullable:    notnull == 0,
                    default_val: r.try_get("dflt_value").ok().flatten(),
                    comment:     None,
                    is_pk:       pk > 0,
                    is_unique:   false,
                }
            })
            .collect();

        // Foreign keys
        let fk_rows = sqlx::query(
            "SELECT f.id, f.seq, f.\"table\" AS ref_table, f.\"from\" AS from_col,
                    f.\"to\" AS to_col, f.on_update, f.on_delete
             FROM sqlite_master m JOIN pragma_foreign_key_list(m.name) f
             WHERE m.name = ? ORDER BY f.id, f.seq",
        )
        .bind(table)
        .fetch_all(pool)
        .await
        .map_err(query_err)?;

        // Group multi-column FKs by their id.
        let mut fk_groups: BTreeMap<i64, ForeignKeyDetail> = BTreeMap::new();
        for r in &fk_rows {
            let id: i64 = r.try_get("id").unwrap_or(0);
            let from_col: String = r.try_get("from_col").unwrap_or_default();
            let to_col: Option<String> = r.try_get("to_col").ok();
            let entry = fk_groups.entry(id).or_insert_with(|| ForeignKeyDetail {
                name:        format!("fk_{}_{}", table, id),
                columns:     vec![],
                ref_schema:  MAIN_SCHEMA.to_string(),
                ref_table:   r.try_get("ref_table").unwrap_or_default(),
                ref_columns: vec![],
                on_delete:   r.try_get("on_delete").unwrap_or_else(|_| "NO ACTION".into()),
                on_update:   r.try_get("on_update").unwrap_or_else(|_| "NO ACTION".into()),
            });
            entry.columns.push(from_col);
            if let Some(tc) = to_col {
                entry.ref_columns.push(tc);
            }
        }
        let foreign_keys: Vec<ForeignKeyDetail> = fk_groups.into_values().collect();

        // Indexes (name + columns + uniqueness + origin).
        let idx_rows = sqlx::query(
            "SELECT il.name AS index_name, il.\"unique\" AS is_unique, il.origin,
                    ii.name AS column_name, ii.seqno
             FROM sqlite_master m
             JOIN pragma_index_list(m.name) il
             JOIN pragma_index_info(il.name) ii
             WHERE m.name = ? ORDER BY il.name, ii.seqno",
        )
        .bind(table)
        .fetch_all(pool)
        .await
        .map_err(query_err)?;

        struct IdxAcc {
            unique:  bool,
            origin:  String,
            columns: Vec<String>,
        }
        let mut idx_map: BTreeMap<String, IdxAcc> = BTreeMap::new();
        for r in &idx_rows {
            let name: String = r.try_get("index_name").unwrap_or_default();
            let unique: i64 = r.try_get("is_unique").unwrap_or(0);
            let origin: String = r.try_get("origin").unwrap_or_default();
            let col: Option<String> = r.try_get("column_name").ok();
            let acc = idx_map.entry(name).or_insert_with(|| IdxAcc {
                unique: unique == 1,
                origin,
                columns: vec![],
            });
            if let Some(c) = col {
                acc.columns.push(c);
            }
        }

        // Index DDL text, looked up from sqlite_master where present.
        let ddl_rows = sqlx::query(
            "SELECT name, sql FROM sqlite_master
             WHERE type = 'index' AND tbl_name = ? AND sql IS NOT NULL",
        )
        .bind(table)
        .fetch_all(pool)
        .await
        .map_err(query_err)?;
        let mut idx_ddl: HashMap<String, String> = HashMap::new();
        for r in &ddl_rows {
            let name: String = r.try_get("name").unwrap_or_default();
            let sql: String = r.try_get("sql").unwrap_or_default();
            idx_ddl.insert(name, sql);
        }

        let indexes: Vec<IndexDetail> = idx_map
            .iter()
            .map(|(name, acc)| IndexDetail {
                name:       name.clone(),
                unique:     acc.unique,
                columns:    acc.columns.clone(),
                definition: idx_ddl.get(name).cloned().unwrap_or_default(),
            })
            .collect();

        // Constraints: PRIMARY KEY from pk columns; UNIQUE from unique indexes.
        let mut constraints: Vec<ConstraintDetail> = vec![];
        let pk_cols: Vec<String> = columns.iter().filter(|c| c.is_pk).map(|c| c.name.clone()).collect();
        if !pk_cols.is_empty() {
            constraints.push(ConstraintDetail {
                name:       format!("pk_{table}"),
                kind:       "PRIMARY KEY".into(),
                columns:    pk_cols,
                definition: String::new(),
            });
        }
        for (name, acc) in &idx_map {
            if acc.unique && acc.origin == "u" {
                constraints.push(ConstraintDetail {
                    name:       name.clone(),
                    kind:       "UNIQUE".into(),
                    columns:    acc.columns.clone(),
                    definition: String::new(),
                });
            }
        }

        // Table DDL: SQLite keeps the original CREATE TABLE text. Append index DDL.
        let table_sql: Option<String> =
            sqlx::query_scalar("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?")
                .bind(table)
                .fetch_optional(pool)
                .await
                .map_err(query_err)?
                .flatten();
        let mut ddl = table_sql.unwrap_or_default();
        if !ddl.is_empty() && !ddl.trim_end().ends_with(';') {
            ddl.push(';');
        }
        for r in &ddl_rows {
            let sql: String = r.try_get("sql").unwrap_or_default();
            if !sql.is_empty() {
                ddl.push_str("\n\n");
                ddl.push_str(&sql);
                ddl.push(';');
            }
        }

        // Row count via a safely-quoted identifier (cannot be a bound parameter).
        let row_count: Option<i64> =
            sqlx::query_scalar(&format!("SELECT COUNT(*) FROM {}", quote_ident(table)))
                .fetch_one(pool)
                .await
                .ok();

        let properties = TableProperties {
            oid:         0,
            owner:       String::new(),
            tablespace:  None,
            comment:     None,
            row_count,
            size_pretty: None,
            has_rls:     false,
        };

        Ok(TableDetails {
            schema: MAIN_SCHEMA.to_string(),
            table: table.to_string(),
            properties,
            columns,
            constraints,
            foreign_keys,
            indexes,
            ddl,
        })
    }
}

#[async_trait]
impl DatabaseDriver for SqliteDriver {
    fn capabilities(&self) -> Capabilities {
        Capabilities {
            driver:         Driver::Sqlite,
            query_language: QueryLanguage::Sql,
            sql_dialect:    Some(SqlDialect::Sqlite),
            schemas:        true,
            list_databases: true,
            table_details:  true,
            schema_details: true,
            // SQLite is an embedded file: no server-side sessions/locks views,
            // no remote query cancellation, and no cheap per-table size (would
            // need the optional dbstat virtual table).
            table_sizes:    false,
            sessions:       false,
            locks:          false,
            cancel:         false,
            transactions:   true,
        }
    }

    async fn connect(&self, conn: &Connection) -> Result<(), DriverError> {
        self.pool(conn).await.map(|_| ())
    }

    async fn disconnect(&self, id: &str) {
        let mut pools = self.pools.lock().await;
        let keys: Vec<(String, String)> = pools.keys().filter(|(cid, _)| cid == id).cloned().collect();
        for key in keys {
            if let Some(pool) = pools.remove(&key) {
                pool.close().await;
            }
        }
    }

    async fn is_connected(&self, id: &str) -> bool {
        let pools = self.pools.lock().await;
        pools.iter().any(|((cid, _), p)| cid == id && !p.is_closed())
    }

    async fn test(&self, conn: &Connection) -> Result<(), DriverError> {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(Self::connect_options(conn))
            .await
            .map_err(conn_err)?;
        sqlx::query("SELECT 1")
            .execute(&pool)
            .await
            .map_err(|e| DriverError::Connection(format!("Ping failed: {e}")))?;
        pool.close().await;
        Ok(())
    }

    async fn ping(&self, id: &str) -> bool {
        // Clone the cached pool out of the lock so we don't hold it across the await.
        let pool = {
            let pools = self.pools.lock().await;
            pools.iter().find(|((cid, _), p)| cid == id && !p.is_closed()).map(|(_, p)| p.clone())
        };
        match pool {
            Some(pool) => sqlx::query("SELECT 1").execute(&pool).await.is_ok(),
            None => false,
        }
    }

    async fn execute(&self, conn: &Connection, sql: &str) -> Result<QueryResult, DriverError> {
        let pool = self.pool(conn).await?;
        let sql = sql.trim();
        let start = Instant::now();

        match sqlx::query(sql).fetch_all(&pool).await {
            Ok(rows) => {
                let columns: Vec<ColumnInfo> = if let Some(first) = rows.first() {
                    first
                        .columns()
                        .iter()
                        .map(|c| ColumnInfo {
                            name:      c.name().to_string(),
                            type_name: c.type_info().name().to_string(),
                            is_fk:     false,
                            fk_ref:    None,
                            fk_col:    None,
                        })
                        .collect()
                } else {
                    vec![]
                };
                let result_rows = rows
                    .iter()
                    .map(|row| (0..row.len()).map(|i| sqlite_col_to_json(row, i)).collect::<Vec<_>>())
                    .collect();
                Ok(QueryResult {
                    columns,
                    rows: result_rows,
                    affected_rows: None,
                    execution_ms: start.elapsed().as_millis() as u64,
                })
            }
            Err(_) => {
                let result = sqlx::query(sql).execute(&pool).await.map_err(query_err)?;
                Ok(QueryResult {
                    columns: vec![],
                    rows: vec![],
                    affected_rows: Some(result.rows_affected()),
                    execution_ms: start.elapsed().as_millis() as u64,
                })
            }
        }
    }

    async fn cancel(&self, _conn: &Connection) -> Result<(), DriverError> {
        Err(DriverError::Unsupported("SQLite does not support query cancellation".into()))
    }

    async fn schemas(&self, conn: &Connection) -> Result<Vec<SchemaInfo>, DriverError> {
        let pool = self.pool(conn).await?;
        Self::schemas_impl(&pool).await
    }

    async fn list_databases(&self, conn: &Connection) -> Result<Vec<String>, DriverError> {
        let pool = self.pool(conn).await?;
        let rows = sqlx::query("SELECT name FROM pragma_database_list ORDER BY seq")
            .fetch_all(&pool)
            .await
            .map_err(query_err)?;
        Ok(rows.iter().map(|r| r.try_get::<String, _>("name").unwrap_or_default()).collect())
    }

    async fn table_details(
        &self,
        conn:    &Connection,
        _schema: &str,
        table:   &str,
    ) -> Result<TableDetails, DriverError> {
        let pool = self.pool(conn).await?;
        Self::table_details_impl(&pool, table).await
    }

    async fn schema_details(&self, conn: &Connection, schema: &str) -> Result<SchemaDetails, DriverError> {
        let pool = self.pool(conn).await?;
        Self::schema_details_impl(&pool, schema).await
    }

    async fn schema_sizes(&self, _conn: &Connection) -> Result<Vec<SchemaSizes>, DriverError> {
        Err(DriverError::Unsupported("SQLite does not expose per-table sizes".into()))
    }

    async fn sessions(&self, _conn: &Connection) -> Result<Vec<Session>, DriverError> {
        Err(DriverError::Unsupported("SQLite has no server sessions".into()))
    }

    async fn locks(&self, _conn: &Connection) -> Result<Vec<Lock>, DriverError> {
        Err(DriverError::Unsupported("SQLite has no lock view".into()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quote_ident_neutralizes_injection() {
        // The classic attack must become an inert quoted identifier.
        assert_eq!(quote_ident("users"), "\"users\"");
        assert_eq!(quote_ident("a\"; DROP TABLE t; --"), "\"a\"\"; DROP TABLE t; --\"");
        // Quotes are doubled, so the closing quote of the literal is never reached early.
        assert!(quote_ident("x\"y").starts_with('"'));
        assert!(quote_ident("x\"y").ends_with('"'));
    }

    #[test]
    fn capabilities_reflect_embedded_engine() {
        let c = SqliteDriver::new().capabilities();
        assert_eq!(c.driver, Driver::Sqlite);
        assert_eq!(c.sql_dialect, Some(SqlDialect::Sqlite));
        assert!(c.schemas && c.table_details && c.list_databases);
        // No server: these are off, so the trait methods must return Unsupported.
        assert!(!c.sessions && !c.locks && !c.cancel);
    }

    #[tokio::test]
    async fn ping_tracks_pool_lifecycle() {
        // An empty (zero-byte) file is a valid empty SQLite database.
        let path = std::env::temp_dir().join(format!("crabeaver_ping_{}.db", std::process::id()));
        std::fs::File::create(&path).unwrap();
        let conn = Connection {
            id:         "ping-test".into(),
            name:       "t".into(),
            driver:     "sqlite".into(),
            host:       String::new(),
            port:       0,
            database:   path.to_string_lossy().into_owned(),
            username:   String::new(),
            password:   String::new(),
            ssl_mode:   String::new(),
            created_at: String::new(),
        };
        let driver = SqliteDriver::new();

        // No cached pool → dead.
        assert!(!driver.ping(&conn.id).await);
        // Connected → SELECT 1 succeeds.
        driver.connect(&conn).await.unwrap();
        assert!(driver.ping(&conn.id).await);
        // Disconnected → dead again.
        driver.disconnect(&conn.id).await;
        assert!(!driver.ping(&conn.id).await);

        let _ = std::fs::remove_file(&path);
    }
}
