use serde::{Deserialize, Serialize};
use sqlx::Row;
use tauri::State;

use crate::commands::connections::get_connection_by_id_pub;
use crate::infrastructure::database::AppState;

// ── Output types ────────────────────────────────────────────────────────────

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ColumnDetail {
    pub ordinal:    i32,
    pub name:       String,
    pub data_type:  String,
    pub nullable:   bool,
    pub default_val: Option<String>,
    pub comment:    Option<String>,
    pub is_pk:      bool,
    pub is_unique:  bool,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConstraintDetail {
    pub name:       String,
    pub kind:       String,   // PRIMARY KEY, UNIQUE, CHECK, EXCLUDE
    pub columns:    Vec<String>,
    pub definition: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ForeignKeyDetail {
    pub name:        String,
    pub columns:     Vec<String>,
    pub ref_schema:  String,
    pub ref_table:   String,
    pub ref_columns: Vec<String>,
    pub on_delete:   String,
    pub on_update:   String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexDetail {
    pub name:       String,
    pub unique:     bool,
    pub columns:    Vec<String>,
    pub definition: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TableProperties {
    pub oid:        i64,
    pub owner:      String,
    pub tablespace: Option<String>,
    pub comment:    Option<String>,
    pub row_count:  Option<i64>,
    pub size_pretty: Option<String>,
    pub has_rls:    bool,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TableDetails {
    pub schema:      String,
    pub table:       String,
    pub properties:  TableProperties,
    pub columns:     Vec<ColumnDetail>,
    pub constraints: Vec<ConstraintDetail>,
    pub foreign_keys: Vec<ForeignKeyDetail>,
    pub indexes:     Vec<IndexDetail>,
    pub ddl:         String,
}

// ── Command ─────────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn get_table_details(
    state: State<'_, AppState>,
    connection_id: String,
    schema: String,
    table: String,
) -> Result<TableDetails, String> {
    let conn = get_connection_by_id_pub(&state, &connection_id).await?;
    let pool = state.pg_pools.pool(&conn).await?;

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
        ).bind(&schema).bind(&table).fetch_one(&pool),

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
        ).bind(&schema).bind(&table).fetch_all(&pool),

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
        ).bind(&schema).bind(&table).fetch_all(&pool),

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
        ).bind(&schema).bind(&table).fetch_all(&pool),

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
        ).bind(&schema).bind(&table).fetch_all(&pool),
    ).map_err(|e| e.to_string())?;

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

    let columns: Vec<ColumnDetail> = cols_rows.iter().map(|r| ColumnDetail {
        ordinal:     r.try_get::<i32, _>("ordinal_position").unwrap_or(0),
        name:        r.try_get("column_name").unwrap_or_default(),
        data_type:   r.try_get("data_type").unwrap_or_default(),
        nullable:    r.try_get("nullable").unwrap_or(true),
        default_val: r.try_get("column_default").ok().flatten(),
        comment:     r.try_get("comment").ok().flatten(),
        is_pk:       r.try_get("is_pk").unwrap_or(false),
        is_unique:   r.try_get("is_unique").unwrap_or(false),
    }).collect();

    let constraints: Vec<ConstraintDetail> = constr_rows.iter().map(|r| ConstraintDetail {
        name:       r.try_get("name").unwrap_or_default(),
        kind:       r.try_get("kind").unwrap_or_default(),
        columns:    r.try_get::<String, _>("columns").unwrap_or_default()
                     .split(", ").map(|s| s.to_string()).filter(|s| !s.is_empty()).collect(),
        definition: r.try_get("definition").unwrap_or_default(),
    }).collect();

    let foreign_keys: Vec<ForeignKeyDetail> = fk_rows.iter().map(|r| {
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
    }).collect();

    let indexes: Vec<IndexDetail> = idx_rows.iter().map(|r| IndexDetail {
        name:       r.try_get("name").unwrap_or_default(),
        unique:     r.try_get("unique").unwrap_or(false),
        columns:    r.try_get::<String, _>("columns").unwrap_or_default()
                     .split(", ").map(|s| s.to_string()).filter(|s| !s.is_empty()).collect(),
        definition: r.try_get("definition").unwrap_or_default(),
    }).collect();

    // ── Build DDL ─────────────────────────────────────────────────────────
    let col_defs: Vec<String> = columns.iter().map(|c| {
        let mut def = format!("  {} {}", c.name, c.data_type);
        if !c.nullable { def += " NOT NULL"; }
        if let Some(ref d) = c.default_val { def += &format!(" DEFAULT {}", d); }
        def
    }).collect();

    let constraint_defs: Vec<String> = constraints.iter()
        .map(|c| format!("  CONSTRAINT {} {}", c.name, c.definition))
        .collect();

    let fk_defs: Vec<String> = foreign_keys.iter().map(|fk| {
        let mut def = format!(
            "  CONSTRAINT {} FOREIGN KEY ({}) REFERENCES {}.{}({})",
            fk.name,
            fk.columns.join(", "),
            fk.ref_schema, fk.ref_table,
            fk.ref_columns.join(", "),
        );
        if fk.on_delete != "NO ACTION" { def += &format!(" ON DELETE {}", fk.on_delete); }
        if fk.on_update != "NO ACTION" { def += &format!(" ON UPDATE {}", fk.on_update); }
        def
    }).collect();

    let mut all_defs = col_defs;
    all_defs.extend(constraint_defs);
    all_defs.extend(fk_defs);

    let mut ddl = format!(
        "CREATE TABLE {}.{} (\n{}\n);",
        schema, table,
        all_defs.join(",\n")
    );

    // Append standalone indexes (skip those backing PK/UNIQUE — already in constraints above)
    let constraint_names: std::collections::HashSet<&str> =
        constraints.iter().map(|c| c.name.as_str()).collect();
    for idx in indexes.iter().filter(|i| !constraint_names.contains(i.name.as_str())) {
        ddl += &format!("\n\n{};", idx.definition);
    }

    Ok(TableDetails { schema, table, properties, columns, constraints, foreign_keys, indexes, ddl })
}
