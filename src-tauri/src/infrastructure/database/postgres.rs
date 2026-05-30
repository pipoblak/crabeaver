use std::collections::HashMap;
use std::time::Instant;

use async_trait::async_trait;
use sqlx::postgres::{PgConnectOptions, PgConnection, PgPool, PgPoolOptions, PgSslMode};
use sqlx::{Column, Row, TypeInfo};
use tokio::sync::Mutex;

use crate::domain::capabilities::{Capabilities, Driver, QueryLanguage, SqlDialect};
use crate::domain::error::DriverError;
use crate::domain::models::connection::Connection;
use crate::domain::models::query::{ColumnInfo, QueryResult};
use crate::domain::models::schema::{SchemaInfo, TableInfo};
use crate::domain::models::session::{Lock, Session};
use crate::domain::models::table_details::{
    ColumnDetail, ConstraintDetail, ForeignKeyDetail, IndexDetail, TableDetails, TableProperties,
};
use crate::domain::ports::database_driver::DatabaseDriver;

fn conn_err(e: impl std::fmt::Display) -> DriverError {
    DriverError::Connection(format!("Connection failed: {e}"))
}
fn query_err(e: impl std::fmt::Display) -> DriverError {
    DriverError::Query(e.to_string())
}

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
        "INT2" => {
            try_get!(i16, |n| serde_json::json!(n));
        }
        "INT4" => {
            try_get!(i32, |n| serde_json::json!(n));
        }
        "INT8" | "OID" => {
            try_get!(i64, |n| serde_json::json!(n));
        }
        "FLOAT4" => {
            try_get!(f32, |n| serde_json::json!(n));
        }
        "FLOAT8" => {
            try_get!(f64, |n| serde_json::json!(n));
        }
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
                return v
                    .map(|b| J::String(b.iter().map(|byte| format!("{byte:02x}")).collect::<String>()))
                    .unwrap_or(J::Null);
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

/// PostgreSQL implementation of `DatabaseDriver`.
///
/// Owns one pool per `(connection id, database)` so introspecting a different
/// database on the same server (the inspector's database dropdown) gets its own
/// pool instead of a throwaway connection. `active_pids` records the backend PID
/// of the connection a query is pinned to, so `cancel` always targets the right
/// backend.
#[derive(Default)]
pub struct PostgresDriver {
    pools:       Mutex<HashMap<(String, String), PgPool>>,
    active_pids: Mutex<HashMap<String, i32>>,
}

impl PostgresDriver {
    pub fn new() -> Self {
        Self::default()
    }

    fn connect_options(conn: &Connection) -> PgConnectOptions {
        let ssl = match conn.ssl_mode.as_str() {
            "require" => PgSslMode::Require,
            "disable" => PgSslMode::Disable,
            _ => PgSslMode::Prefer,
        };
        PgConnectOptions::new()
            .host(&conn.host)
            .port(conn.port)
            .database(&conn.database)
            .username(&conn.username)
            .password(&conn.password)
            .ssl_mode(ssl)
    }

    /// Get or create the pool for this connection's `(id, database)`.
    async fn pool(&self, conn: &Connection) -> Result<PgPool, DriverError> {
        let key = (conn.id.clone(), conn.database.clone());
        let mut pools = self.pools.lock().await;
        if let Some(p) = pools.get(&key)
            && !p.is_closed()
        {
            return Ok(p.clone());
        }

        let pool = PgPoolOptions::new()
            .max_connections(8)
            .min_connections(1)
            .connect_with(Self::connect_options(conn))
            .await
            .map_err(conn_err)?;

        pools.insert(key, pool.clone());
        Ok(pool)
    }

    /// Run one statement on a pinned connection. Tries it as a row-returning
    /// query first; on error, retries as a non-returning statement (so DDL/DML
    /// report an affected-row count). Matches the original editor UX exactly.
    async fn run(c: &mut PgConnection, sql: &str) -> Result<QueryResult, DriverError> {
        let sql = sql.trim();
        let start = Instant::now();

        match sqlx::query(sql).fetch_all(&mut *c).await {
            Ok(rows) => {
                let columns: Vec<ColumnInfo> = if let Some(first) = rows.first() {
                    first
                        .columns()
                        .iter()
                        .map(|col| ColumnInfo {
                            name:      col.name().to_string(),
                            type_name: col.type_info().name().to_string(),
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
                    .map(|row| (0..row.len()).map(|i| pg_col_to_json(row, i)).collect::<Vec<_>>())
                    .collect();

                Ok(QueryResult {
                    columns,
                    rows: result_rows,
                    affected_rows: None,
                    execution_ms: start.elapsed().as_millis() as u64,
                })
            }
            Err(_) => {
                let result = sqlx::query(sql).execute(&mut *c).await.map_err(query_err)?;
                Ok(QueryResult {
                    columns: vec![],
                    rows: vec![],
                    affected_rows: Some(result.rows_affected()),
                    execution_ms: start.elapsed().as_millis() as u64,
                })
            }
        }
    }

    /// Fetch schemas + tables + columns, marking FK columns in a second pass.
    async fn schemas_impl(pool: &PgPool) -> Result<Vec<SchemaInfo>, DriverError> {
        // ── Column query ──────────────────────────────────────────────────────
        let col_rows = sqlx::query(
            "SELECT t.table_schema AS schema, t.table_name, c.column_name, c.data_type
             FROM information_schema.tables t
             LEFT JOIN information_schema.columns c
               ON c.table_schema = t.table_schema AND c.table_name = t.table_name
             WHERE t.table_schema NOT IN ('pg_catalog','information_schema','pg_toast')
               AND t.table_type = 'BASE TABLE'
             ORDER BY t.table_schema, t.table_name, c.ordinal_position",
        )
        .fetch_all(pool)
        .await
        .map_err(query_err)?;

        // ── FK query — (from_schema, from_table, from_col) → "to_schema.to_table:to_col"
        let mut fk_map: HashMap<String, String> = HashMap::new();

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
               AND n.nspname NOT IN ('pg_catalog','information_schema')",
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
                    format!("{}.{}:{}", to_schema, to_table, to_col), // "schema.table:col"
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
                let (fk_ref, fk_col) = fk_raw
                    .map(|s| {
                        // format: "schema.table:col"
                        let (tbl_part, col_part) = s.split_once(':').unwrap_or((s, "id"));
                        (Some(tbl_part.to_string()), Some(col_part.to_string()))
                    })
                    .unwrap_or((None, None));
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
                tables: tables.into_iter().map(|(name, columns)| TableInfo { name, columns }).collect(),
            })
            .collect())
    }

    async fn list_databases_impl(pool: &PgPool) -> Result<Vec<String>, DriverError> {
        let rows = sqlx::query("SELECT datname FROM pg_database WHERE datistemplate = false ORDER BY datname")
            .fetch_all(pool)
            .await
            .map_err(query_err)?;
        Ok(rows
            .iter()
            .map(|r| r.try_get::<String, _>("datname").unwrap_or_default())
            .collect())
    }

    async fn sessions_impl(pool: &PgPool) -> Result<Vec<Session>, DriverError> {
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
             ORDER BY query_start DESC NULLS LAST",
        )
        .fetch_all(pool)
        .await
        .map_err(query_err)?;

        Ok(rows
            .iter()
            .map(|r| Session {
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
            })
            .collect())
    }

    async fn locks_impl(pool: &PgPool) -> Result<Vec<Lock>, DriverError> {
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
             ORDER BY l.granted ASC, l.pid ASC",
        )
        .fetch_all(pool)
        .await
        .map_err(query_err)?;

        Ok(rows
            .iter()
            .map(|r| Lock {
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
            })
            .collect())
    }

    async fn table_details_impl(
        pool:   &PgPool,
        schema: &str,
        table:  &str,
    ) -> Result<TableDetails, DriverError> {
        // Run all queries in parallel
        let (props_row, cols_rows, constr_rows, fk_rows, idx_rows) = tokio::try_join!(
            sqlx::query(
                "SELECT c.oid::bigint,
                        pg_get_userbyid(c.relowner) AS owner,
                        t.spcname                   AS tablespace,
                        obj_description(c.oid, 'pg_class') AS comment,
                        c.reltuples::bigint         AS row_count,
                        pg_size_pretty(pg_total_relation_size(c.oid)) AS size_pretty,
                        c.relrowsecurity            AS has_rls
                 FROM pg_class c
                 LEFT JOIN pg_tablespace t ON t.oid = c.reltablespace
                 JOIN pg_namespace n ON n.oid = c.relnamespace
                 WHERE n.nspname = $1 AND c.relname = $2"
            )
            .bind(schema)
            .bind(table)
            .fetch_one(pool),
            sqlx::query(
                "SELECT col.ordinal_position,
                        col.column_name,
                        col.udt_name AS data_type,
                        col.is_nullable = 'YES' AS nullable,
                        col.column_default,
                        pgd.description AS comment,
                        EXISTS (
                            SELECT 1 FROM information_schema.table_constraints tc
                            JOIN information_schema.key_column_usage kcu
                              ON kcu.constraint_name = tc.constraint_name
                              AND kcu.table_schema = tc.table_schema
                            WHERE tc.constraint_type = 'PRIMARY KEY'
                              AND tc.table_schema = col.table_schema
                              AND tc.table_name  = col.table_name
                              AND kcu.column_name = col.column_name
                        ) AS is_pk,
                        EXISTS (
                            SELECT 1 FROM information_schema.table_constraints tc
                            JOIN information_schema.key_column_usage kcu
                              ON kcu.constraint_name = tc.constraint_name
                              AND kcu.table_schema = tc.table_schema
                            WHERE tc.constraint_type = 'UNIQUE'
                              AND tc.table_schema = col.table_schema
                              AND tc.table_name  = col.table_name
                              AND kcu.column_name = col.column_name
                        ) AS is_unique
                 FROM information_schema.columns col
                 LEFT JOIN pg_catalog.pg_statio_all_tables st ON st.schemaname = col.table_schema AND st.relname = col.table_name
                 LEFT JOIN pg_catalog.pg_description pgd ON pgd.objoid = st.relid AND pgd.objsubid = col.ordinal_position
                 WHERE col.table_schema = $1 AND col.table_name = $2
                 ORDER BY col.ordinal_position"
            )
            .bind(schema)
            .bind(table)
            .fetch_all(pool),
            sqlx::query(
                "SELECT con.conname AS name,
                        CASE con.contype
                            WHEN 'p' THEN 'PRIMARY KEY'
                            WHEN 'u' THEN 'UNIQUE'
                            WHEN 'c' THEN 'CHECK'
                            WHEN 'x' THEN 'EXCLUDE'
                            ELSE con.contype::text
                        END AS kind,
                        array_to_string(
                            ARRAY(SELECT a.attname FROM pg_attribute a
                                  WHERE a.attrelid = con.conrelid AND a.attnum = ANY(con.conkey)),
                            ', '
                        ) AS columns,
                        pg_get_constraintdef(con.oid) AS definition
                 FROM pg_constraint con
                 JOIN pg_namespace n ON n.oid = con.connamespace
                 JOIN pg_class cl ON cl.oid = con.conrelid
                 WHERE n.nspname = $1 AND cl.relname = $2
                   AND con.contype IN ('p','u','c','x')
                 ORDER BY con.contype, con.conname"
            )
            .bind(schema)
            .bind(table)
            .fetch_all(pool),
            sqlx::query(
                "SELECT c.conname AS name,
                        array_agg(a.attname  ORDER BY pos.pos) AS columns,
                        fn.nspname  AS ref_schema,
                        fc.relname  AS ref_table,
                        array_agg(fa.attname ORDER BY pos.pos) AS ref_columns,
                        CASE c.confdeltype
                            WHEN 'a' THEN 'NO ACTION' WHEN 'r' THEN 'RESTRICT'
                            WHEN 'c' THEN 'CASCADE'   WHEN 'n' THEN 'SET NULL'
                            WHEN 'd' THEN 'SET DEFAULT' ELSE 'NO ACTION'
                        END AS on_delete,
                        CASE c.confupdtype
                            WHEN 'a' THEN 'NO ACTION' WHEN 'r' THEN 'RESTRICT'
                            WHEN 'c' THEN 'CASCADE'   WHEN 'n' THEN 'SET NULL'
                            WHEN 'd' THEN 'SET DEFAULT' ELSE 'NO ACTION'
                        END AS on_update
                 FROM pg_constraint c
                 JOIN pg_class cl   ON cl.oid = c.conrelid
                 JOIN pg_namespace n ON n.oid = cl.relnamespace
                 JOIN pg_class fc   ON fc.oid = c.confrelid
                 JOIN pg_namespace fn ON fn.oid = fc.relnamespace
                 CROSS JOIN LATERAL unnest(c.conkey) WITH ORDINALITY AS pos(key, pos)
                 JOIN pg_attribute a  ON a.attrelid = c.conrelid  AND a.attnum = pos.key
                 JOIN pg_attribute fa ON fa.attrelid = c.confrelid AND fa.attnum = c.confkey[pos.pos::int]
                 WHERE n.nspname = $1 AND cl.relname = $2 AND c.contype = 'f'
                 GROUP BY c.conname, fn.nspname, fc.relname, c.confdeltype, c.confupdtype"
            )
            .bind(schema)
            .bind(table)
            .fetch_all(pool),
            sqlx::query(
                "SELECT indexname AS name,
                        ix.indisunique AS unique,
                        array_to_string(
                            ARRAY(SELECT a.attname FROM pg_attribute a
                                  WHERE a.attrelid = ix.indrelid AND a.attnum = ANY(ix.indkey) AND a.attnum > 0),
                            ', '
                        ) AS columns,
                        indexdef AS definition
                 FROM pg_indexes pi
                 JOIN pg_class ic ON ic.relname = pi.indexname
                 JOIN pg_index ix ON ix.indexrelid = ic.oid
                 WHERE pi.schemaname = $1 AND pi.tablename = $2
                 ORDER BY indexname"
            )
            .bind(schema)
            .bind(table)
            .fetch_all(pool),
        )
        .map_err(query_err)?;

        // ── Map properties ────────────────────────────────────────────────────
        let properties = TableProperties {
            oid:         props_row.try_get::<i64, _>("oid").unwrap_or(0),
            owner:       props_row.try_get("owner").unwrap_or_default(),
            tablespace:  props_row.try_get("tablespace").ok(),
            comment:     props_row.try_get("comment").ok().flatten(),
            row_count:   props_row.try_get("row_count").ok(),
            size_pretty: props_row.try_get("size_pretty").ok(),
            has_rls:     props_row.try_get("has_rls").unwrap_or(false),
        };

        let columns: Vec<ColumnDetail> = cols_rows
            .iter()
            .map(|r| ColumnDetail {
                ordinal:     r.try_get::<i32, _>("ordinal_position").unwrap_or(0),
                name:        r.try_get("column_name").unwrap_or_default(),
                data_type:   r.try_get("data_type").unwrap_or_default(),
                nullable:    r.try_get("nullable").unwrap_or(true),
                default_val: r.try_get("column_default").ok().flatten(),
                comment:     r.try_get("comment").ok().flatten(),
                is_pk:       r.try_get("is_pk").unwrap_or(false),
                is_unique:   r.try_get("is_unique").unwrap_or(false),
            })
            .collect();

        let constraints: Vec<ConstraintDetail> = constr_rows
            .iter()
            .map(|r| ConstraintDetail {
                name:       r.try_get("name").unwrap_or_default(),
                kind:       r.try_get("kind").unwrap_or_default(),
                columns:    r
                    .try_get::<String, _>("columns")
                    .unwrap_or_default()
                    .split(", ")
                    .map(|s| s.to_string())
                    .filter(|s| !s.is_empty())
                    .collect(),
                definition: r.try_get("definition").unwrap_or_default(),
            })
            .collect();

        let foreign_keys: Vec<ForeignKeyDetail> = fk_rows
            .iter()
            .map(|r| {
                let cols: Vec<String> = r.try_get::<Vec<String>, _>("columns").unwrap_or_default();
                let refs: Vec<String> = r.try_get::<Vec<String>, _>("ref_columns").unwrap_or_default();
                ForeignKeyDetail {
                    name:        r.try_get("name").unwrap_or_default(),
                    columns:     cols,
                    ref_schema:  r.try_get("ref_schema").unwrap_or_default(),
                    ref_table:   r.try_get("ref_table").unwrap_or_default(),
                    ref_columns: refs,
                    on_delete:   r.try_get("on_delete").unwrap_or_else(|_| "NO ACTION".into()),
                    on_update:   r.try_get("on_update").unwrap_or_else(|_| "NO ACTION".into()),
                }
            })
            .collect();

        let indexes: Vec<IndexDetail> = idx_rows
            .iter()
            .map(|r| IndexDetail {
                name:       r.try_get("name").unwrap_or_default(),
                unique:     r.try_get("unique").unwrap_or(false),
                columns:    r
                    .try_get::<String, _>("columns")
                    .unwrap_or_default()
                    .split(", ")
                    .map(|s| s.to_string())
                    .filter(|s| !s.is_empty())
                    .collect(),
                definition: r.try_get("definition").unwrap_or_default(),
            })
            .collect();

        // ── Build DDL ─────────────────────────────────────────────────────────
        let col_defs: Vec<String> = columns
            .iter()
            .map(|c| {
                let mut def = format!("  {} {}", c.name, c.data_type);
                if !c.nullable {
                    def += " NOT NULL";
                }
                if let Some(ref d) = c.default_val {
                    def += &format!(" DEFAULT {}", d);
                }
                def
            })
            .collect();

        let constraint_defs: Vec<String> = constraints
            .iter()
            .map(|c| format!("  CONSTRAINT {} {}", c.name, c.definition))
            .collect();

        let fk_defs: Vec<String> = foreign_keys
            .iter()
            .map(|fk| {
                let mut def = format!(
                    "  CONSTRAINT {} FOREIGN KEY ({}) REFERENCES {}.{}({})",
                    fk.name,
                    fk.columns.join(", "),
                    fk.ref_schema,
                    fk.ref_table,
                    fk.ref_columns.join(", "),
                );
                if fk.on_delete != "NO ACTION" {
                    def += &format!(" ON DELETE {}", fk.on_delete);
                }
                if fk.on_update != "NO ACTION" {
                    def += &format!(" ON UPDATE {}", fk.on_update);
                }
                def
            })
            .collect();

        let mut all_defs = col_defs;
        all_defs.extend(constraint_defs);
        all_defs.extend(fk_defs);

        let mut ddl = format!("CREATE TABLE {}.{} (\n{}\n);", schema, table, all_defs.join(",\n"));

        // Append standalone indexes (skip those backing PK/UNIQUE — already in constraints above)
        let constraint_names: std::collections::HashSet<&str> =
            constraints.iter().map(|c| c.name.as_str()).collect();
        for idx in indexes.iter().filter(|i| !constraint_names.contains(i.name.as_str())) {
            ddl += &format!("\n\n{};", idx.definition);
        }

        Ok(TableDetails {
            schema: schema.to_string(),
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
impl DatabaseDriver for PostgresDriver {
    fn capabilities(&self) -> Capabilities {
        Capabilities {
            driver:         Driver::Postgres,
            query_language: QueryLanguage::Sql,
            sql_dialect:    Some(SqlDialect::Postgres),
            schemas:        true,
            list_databases: true,
            table_details:  true,
            sessions:       true,
            locks:          true,
            cancel:         true,
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
        self.active_pids.lock().await.remove(id);
    }

    async fn is_connected(&self, id: &str) -> bool {
        let pools = self.pools.lock().await;
        pools.iter().any(|((cid, _), p)| cid == id && !p.is_closed())
    }

    async fn test(&self, conn: &Connection) -> Result<(), DriverError> {
        let pool = PgPoolOptions::new()
            .max_connections(1)
            .acquire_timeout(std::time::Duration::from_secs(10))
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

    async fn execute(&self, conn: &Connection, sql: &str) -> Result<QueryResult, DriverError> {
        let pool = self.pool(conn).await?;

        // Pin the query to one acquired connection and record THAT connection's
        // backend pid, so `cancel` targets the backend actually running the query.
        let mut db_conn = pool.acquire().await.map_err(conn_err)?;
        let pid: i32 = sqlx::query_scalar("SELECT pg_backend_pid()")
            .fetch_one(db_conn.as_mut())
            .await
            .unwrap_or(0);
        self.active_pids.lock().await.insert(conn.id.clone(), pid);

        let result = Self::run(db_conn.as_mut(), sql).await;

        self.active_pids.lock().await.remove(&conn.id);
        result
    }

    async fn cancel(&self, conn: &Connection) -> Result<(), DriverError> {
        let pid = self.active_pids.lock().await.get(&conn.id).copied();
        let Some(pid) = pid else { return Ok(()) };

        let pool = self.pool(conn).await?;
        sqlx::query("SELECT pg_cancel_backend($1)")
            .bind(pid)
            .execute(&pool)
            .await
            .map_err(query_err)?;
        Ok(())
    }

    async fn schemas(&self, conn: &Connection) -> Result<Vec<SchemaInfo>, DriverError> {
        let pool = self.pool(conn).await?;
        Self::schemas_impl(&pool).await
    }

    async fn list_databases(&self, conn: &Connection) -> Result<Vec<String>, DriverError> {
        let pool = self.pool(conn).await?;
        Self::list_databases_impl(&pool).await
    }

    async fn table_details(
        &self,
        conn:   &Connection,
        schema: &str,
        table:  &str,
    ) -> Result<TableDetails, DriverError> {
        let pool = self.pool(conn).await?;
        Self::table_details_impl(&pool, schema, table).await
    }

    async fn sessions(&self, conn: &Connection) -> Result<Vec<Session>, DriverError> {
        let pool = self.pool(conn).await?;
        Self::sessions_impl(&pool).await
    }

    async fn locks(&self, conn: &Connection) -> Result<Vec<Lock>, DriverError> {
        let pool = self.pool(conn).await?;
        Self::locks_impl(&pool).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::ports::database_driver::DatabaseDriver;

    #[test]
    fn driver_identity_and_capabilities_are_consistent() {
        let d = PostgresDriver::new();
        let c = d.capabilities();
        assert_eq!(c.driver, Driver::Postgres);
        assert_eq!(c.query_language, QueryLanguage::Sql);
        assert_eq!(c.sql_dialect, Some(SqlDialect::Postgres));
        // Postgres supports the full feature set.
        assert!(c.schemas && c.list_databases && c.table_details);
        assert!(c.sessions && c.locks && c.cancel && c.transactions);
    }
}
