use serde::{Deserialize, Serialize};

/// Full description of a single table: columns, constraints, FKs, indexes,
/// properties, and reconstructed DDL. Produced by `DatabaseDriver::table_details`.
/// Postgres fills every field; leaner engines (SQLite) populate what they can and
/// leave the rest empty/default.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ColumnDetail {
    pub ordinal:     i32,
    pub name:        String,
    pub data_type:   String,
    pub nullable:    bool,
    pub default_val: Option<String>,
    pub comment:     Option<String>,
    pub is_pk:       bool,
    pub is_unique:   bool,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConstraintDetail {
    pub name:       String,
    pub kind:       String, // PRIMARY KEY, UNIQUE, CHECK, EXCLUDE
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
    pub oid:         i64,
    pub owner:       String,
    pub tablespace:  Option<String>,
    pub comment:     Option<String>,
    pub row_count:   Option<i64>,
    pub size_pretty: Option<String>,
    pub has_rls:     bool,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TableDetails {
    pub schema:       String,
    pub table:        String,
    pub properties:   TableProperties,
    pub columns:      Vec<ColumnDetail>,
    pub constraints:  Vec<ConstraintDetail>,
    pub foreign_keys: Vec<ForeignKeyDetail>,
    pub indexes:      Vec<IndexDetail>,
    pub ddl:          String,
}
