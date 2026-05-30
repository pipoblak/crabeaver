//! SQL completion: detect the clause under the cursor and return the keywords,
//! functions, and snippets that fit, plus flags telling the frontend when to add
//! schema (table/column) items.
//!
//! Completion content is currently shared across SQL dialects (a Postgres-leaning
//! superset). Per-dialect tailoring (e.g. MySQL backtick quoting, dropping ILIKE)
//! is a future refinement; the seam exists because callers go through a
//! dialect-specific `SqlLanguageService`.

use crate::domain::models::language::{Completion, CompletionResult};

#[derive(Debug, Clone, PartialEq)]
enum SqlContext {
    Select,
    From,
    Join,
    Where,
    On,
    GroupBy,
    Having,
    OrderBy,
    InsertInto,
    Values,
    Set, // UPDATE SET
    CreateTable,
    AlterTable,
    DropTable,
    Update,
    DeleteFrom,
    With,
    SetOp,
    Unknown,
}

fn detect_context(sql: &str, cursor_offset: usize) -> SqlContext {
    let up_to_cursor = &sql[..cursor_offset.min(sql.len())];

    // Scope to the current statement only — find the last `;` before the cursor
    // so keywords from previous statements don't pollute context detection.
    let stmt_start = up_to_cursor.rfind(';').map(|p| p + 1).unwrap_or(0);
    let text = up_to_cursor[stmt_start..].to_uppercase();

    // Strip string literals to avoid false keyword matches inside quotes
    let mut clean = String::with_capacity(text.len());
    let mut in_single = false;
    let mut in_double = false;
    for ch in text.chars() {
        match ch {
            '\'' if !in_double => {
                in_single = !in_single;
                clean.push(' ');
            }
            '"' if !in_single => {
                in_double = !in_double;
                clean.push(' ');
            }
            _ if in_single || in_double => clean.push(' '),
            _ => clean.push(ch),
        }
    }

    // Strip paren content so inner subquery keywords (FROM, ORDER BY in OVER, etc.)
    // cannot override the outer query's context.
    let mut paren_clean = String::with_capacity(clean.len());
    let mut depth: i32 = 0;
    for ch in clean.chars() {
        match ch {
            '(' => {
                depth += 1;
                paren_clean.push('(');
            }
            ')' => {
                depth -= 1;
                if depth < 0 {
                    depth = 0;
                }
                paren_clean.push(')');
            }
            _ => {
                if depth > 0 {
                    paren_clean.push(' ');
                } else {
                    paren_clean.push(ch);
                }
            }
        }
    }
    let clean = paren_clean;

    // Find the latest-positioned context keyword.
    // Multi-word compounds first — they share end-position with their suffix words,
    // so they must be checked first (first match at same position wins).
    let markers: &[(&str, SqlContext)] = &[
        // Most-specific compound markers first
        ("ORDER BY", SqlContext::OrderBy),
        ("GROUP BY", SqlContext::GroupBy),
        ("INSERT INTO", SqlContext::InsertInto),
        ("DELETE FROM", SqlContext::DeleteFrom),
        ("CREATE TABLE", SqlContext::CreateTable),
        ("DROP TABLE", SqlContext::DropTable),
        ("ALTER TABLE", SqlContext::AlterTable),
        // CREATE INDEX ON must win over bare ' ON '
        ("CREATE UNIQUE INDEX ON", SqlContext::Unknown),
        ("CREATE UNIQUE INDEX", SqlContext::Unknown),
        ("CREATE INDEX ON", SqlContext::Unknown),
        ("CREATE INDEX", SqlContext::Unknown),
        // FOR UPDATE must win over bare UPDATE
        ("FOR UPDATE", SqlContext::Select),
        ("FOR SHARE", SqlContext::Select),
        // set operators need their own context
        ("UNION ALL", SqlContext::SetOp),
        ("UNION", SqlContext::SetOp),
        ("INTERSECT", SqlContext::SetOp),
        ("EXCEPT", SqlContext::SetOp),
        // ON CONFLICT must win over bare ' ON '
        ("ON CONFLICT", SqlContext::InsertInto),
        // Join variants
        ("FULL OUTER JOIN", SqlContext::Join),
        ("LEFT OUTER JOIN", SqlContext::Join),
        ("RIGHT OUTER JOIN", SqlContext::Join),
        ("LEFT JOIN", SqlContext::Join),
        ("RIGHT JOIN", SqlContext::Join),
        ("INNER JOIN", SqlContext::Join),
        ("CROSS JOIN", SqlContext::Join),
        ("NATURAL JOIN", SqlContext::Join),
        // Single-word keywords
        ("JOIN", SqlContext::Join),
        ("VALUES", SqlContext::Values),
        ("HAVING", SqlContext::Having),
        ("WHERE", SqlContext::Where),
        ("FROM", SqlContext::From),
        (" UPDATE ", SqlContext::Update),
        ("WITH", SqlContext::With),
        ("SELECT", SqlContext::Select),
        (" ON ", SqlContext::On),
        (" SET ", SqlContext::Set),
    ];

    let mut latest_pos: Option<usize> = None;
    let mut context = SqlContext::Unknown;

    for (marker, ctx) in markers {
        if let Some(pos) = clean.rfind(marker) {
            let end = pos + marker.len();
            if latest_pos.is_none_or(|p| end > p) {
                latest_pos = Some(end);
                context = ctx.clone();
            }
        }
    }

    context
}

fn kw(label: &str) -> Completion {
    Completion {
        label:         label.to_string(),
        kind:          "keyword".to_string(),
        insert_text:   label.to_string(),
        detail:        "keyword".to_string(),
        documentation: None,
    }
}

fn kw_s(label: &str) -> Completion {
    Completion {
        label:         label.to_string(),
        kind:          "structural".to_string(),
        insert_text:   label.to_string(),
        detail:        "keyword".to_string(),
        documentation: None,
    }
}

fn func(label: &str, insert: &str, doc: &str) -> Completion {
    Completion {
        label:         label.to_string(),
        kind:          "function".to_string(),
        insert_text:   insert.to_string(),
        detail:        "function".to_string(),
        documentation: Some(doc.to_string()),
    }
}

fn snip(label: &str, insert: &str, doc: &str) -> Completion {
    Completion {
        label:         label.to_string(),
        kind:          "snippet".to_string(),
        insert_text:   insert.to_string(),
        detail:        "snippet".to_string(),
        documentation: Some(doc.to_string()),
    }
}

fn completions_for(ctx: SqlContext) -> Vec<Completion> {
    match ctx {
        SqlContext::Select => vec![
            kw_s("FROM"),
            kw_s("WHERE"),
            kw_s("JOIN"),
            kw_s("LEFT JOIN"),
            kw_s("INNER JOIN"),
            kw_s("GROUP BY"),
            kw_s("ORDER BY"),
            kw_s("HAVING"),
            kw_s("LIMIT"),
            kw_s("OFFSET"),
            kw_s("UNION"),
            kw_s("UNION ALL"),
            kw("*"),
            kw("DISTINCT"),
            kw("ALL"),
            kw("TOP"),
            func("COUNT", "COUNT(${1:*})", "Count rows"),
            func("COUNT DISTINCT", "COUNT(DISTINCT ${1:col})", "Count distinct values"),
            func("SUM", "SUM(${1:col})", "Sum values"),
            func("AVG", "AVG(${1:col})", "Average value"),
            func("MIN", "MIN(${1:col})", "Minimum value"),
            func("MAX", "MAX(${1:col})", "Maximum value"),
            func("COALESCE", "COALESCE(${1:a}, ${2:b})", "First non-null value"),
            func("NULLIF", "NULLIF(${1:a}, ${2:b})", "Null if equal"),
            func("CAST", "CAST(${1:expr} AS ${2:type})", "Cast to type"),
            func("CASE", "CASE\n  WHEN ${1:cond} THEN ${2:val}\n  ELSE ${3:val}\nEND", "Conditional expression"),
            func("IIF", "IIF(${1:cond}, ${2:true}, ${3:false})", "Inline if"),
            func("ROW_NUMBER", "ROW_NUMBER() OVER (${1:PARTITION BY col ORDER BY col})", "Window: row number"),
            func("RANK", "RANK() OVER (${1:PARTITION BY col ORDER BY col})", "Window: rank"),
            func("DENSE_RANK", "DENSE_RANK() OVER (${1:ORDER BY col})", "Window: dense rank"),
            func("LAG", "LAG(${1:col}, ${2:1}) OVER (${3:ORDER BY col})", "Window: previous row"),
            func("LEAD", "LEAD(${1:col}, ${2:1}) OVER (${3:ORDER BY col})", "Window: next row"),
            func("FIRST_VALUE", "FIRST_VALUE(${1:col}) OVER (${2:ORDER BY col})", "Window: first value"),
            func("LAST_VALUE", "LAST_VALUE(${1:col}) OVER (${2:ORDER BY col})", "Window: last value"),
            func("NOW", "NOW()", "Current timestamp"),
            func("CURRENT_DATE", "CURRENT_DATE", "Current date"),
            func("EXTRACT", "EXTRACT(${1:YEAR} FROM ${2:col})", "Extract date part"),
            func("DATE_TRUNC", "DATE_TRUNC('${1:month}', ${2:col})", "Truncate to date part"),
            func("TO_CHAR", "TO_CHAR(${1:col}, '${2:format}')", "Format value"),
            func("UPPER", "UPPER(${1:col})", "Uppercase string"),
            func("LOWER", "LOWER(${1:col})", "Lowercase string"),
            func("TRIM", "TRIM(${1:col})", "Trim whitespace"),
            func("LENGTH", "LENGTH(${1:col})", "String length"),
            func("CONCAT", "CONCAT(${1:a}, ${2:b})", "Concatenate strings"),
            func("SUBSTRING", "SUBSTRING(${1:col} FROM ${2:1} FOR ${3:n})", "Substring"),
            func("REPLACE", "REPLACE(${1:col}, '${2:from}', '${3:to}')", "Replace in string"),
            func("ROUND", "ROUND(${1:col}, ${2:0})", "Round number"),
            func("ABS", "ABS(${1:col})", "Absolute value"),
            func("FLOOR", "FLOOR(${1:col})", "Floor value"),
            func("CEIL", "CEIL(${1:col})", "Ceiling value"),
            func("STRING_AGG", "STRING_AGG(${1:col}, '${2:,}')", "Aggregate strings with delimiter"),
            func("ARRAY_AGG", "ARRAY_AGG(${1:col} ORDER BY ${2:col})", "Aggregate into array"),
            func("JSONB_AGG", "JSONB_AGG(${1:col})", "Aggregate into JSONB array"),
            func("JSON_AGG", "JSON_AGG(${1:col})", "Aggregate into JSON array"),
            func("BOOL_AND", "BOOL_AND(${1:col})", "True if all values are true"),
            func("BOOL_OR", "BOOL_OR(${1:col})", "True if any value is true"),
            func("PERCENTILE_CONT", "PERCENTILE_CONT(${1:0.5}) WITHIN GROUP (ORDER BY ${2:col})", "Continuous percentile"),
            func("PERCENTILE_DISC", "PERCENTILE_DISC(${1:0.5}) WITHIN GROUP (ORDER BY ${2:col})", "Discrete percentile"),
        ],

        SqlContext::From | SqlContext::Join => vec![
            kw_s("WHERE"),
            kw_s("JOIN"),
            kw_s("LEFT JOIN"),
            kw_s("RIGHT JOIN"),
            kw_s("INNER JOIN"),
            kw_s("FULL OUTER JOIN"),
            kw_s("CROSS JOIN"),
            kw_s("GROUP BY"),
            kw_s("ORDER BY"),
            kw_s("HAVING"),
            kw_s("LIMIT"),
            kw("AS"),
            kw("LATERAL"),
            kw("UNNEST"),
            kw("LEFT LATERAL JOIN"),
            snip("subquery", "(SELECT ${1:*} FROM ${2:table}) AS ${3:sub}", "Inline subquery"),
        ],

        SqlContext::Where | SqlContext::On | SqlContext::Having => vec![
            kw("AND"),
            kw("OR"),
            kw("NOT"),
            kw("IS NULL"),
            kw("IS NOT NULL"),
            kw("IS TRUE"),
            kw("IS FALSE"),
            kw("BETWEEN"),
            kw("NOT BETWEEN"),
            kw("LIKE"),
            kw("NOT LIKE"),
            kw("ILIKE"),
            kw("NOT ILIKE"),
            kw("IN"),
            kw("NOT IN"),
            kw("EXISTS"),
            kw("NOT EXISTS"),
            kw("ANY"),
            kw("ALL"),
            kw("SIMILAR TO"),
            snip("BETWEEN range", "${1:col} BETWEEN ${2:low} AND ${3:high}", "Range check"),
            snip("IN list", "${1:col} IN (${2:val1}, ${3:val2})", "Value in list"),
            snip("IN subquery", "${1:col} IN (SELECT ${2:col} FROM ${3:table})", "Subquery membership"),
        ],

        SqlContext::OrderBy => vec![
            kw("ASC"),
            kw("DESC"),
            kw("NULLS FIRST"),
            kw("NULLS LAST"),
            kw("ASC NULLS FIRST"),
            kw("ASC NULLS LAST"),
            kw("DESC NULLS FIRST"),
            kw("DESC NULLS LAST"),
        ],

        SqlContext::GroupBy => vec![
            kw("HAVING"),
            kw("ROLLUP"),
            kw("CUBE"),
            snip("GROUPING SETS", "GROUPING SETS ((${1:col1}), (${2:col2}), ())", "Multiple grouping sets"),
        ],

        SqlContext::InsertInto => vec![
            snip("column list", "(${1:col1}, ${2:col2}) VALUES (${3:val1}, ${4:val2})", "Insert with columns"),
            kw("VALUES"),
            kw("SELECT"),
            kw("OVERRIDING SYSTEM VALUE"),
            kw("ON CONFLICT DO NOTHING"),
            snip("ON CONFLICT DO UPDATE", "ON CONFLICT (${1:col}) DO UPDATE SET ${2:col} = EXCLUDED.${2:col}", "Upsert"),
        ],

        SqlContext::Values => vec![
            snip("row", "(${1:val1}, ${2:val2})", "Value row"),
            kw("DEFAULT"),
            kw("NULL"),
            kw("NOW()"),
            kw("CURRENT_TIMESTAMP"),
        ],

        SqlContext::Set => vec![
            kw("WHERE"),
            kw("RETURNING"),
            snip("col = value", "${1:col} = ${2:value}", "Set column value"),
            snip("col = EXCLUDED.col", "${1:col} = EXCLUDED.${1:col}", "Set from excluded (upsert)"),
        ],

        SqlContext::CreateTable => vec![
            kw_s("IF NOT EXISTS"),
            snip("column list", "(${1:\n  id SERIAL PRIMARY KEY,\n  created_at TIMESTAMPTZ DEFAULT NOW()\n})", "Column definitions"),
            kw("LIKE"),
            kw("PARTITION BY RANGE"),
            kw("PARTITION BY LIST"),
            kw("PARTITION BY HASH"),
        ],

        SqlContext::AlterTable => vec![
            kw_s("ADD COLUMN"),
            kw_s("DROP COLUMN"),
            kw_s("RENAME TO"),
            kw_s("RENAME COLUMN"),
            kw_s("ALTER COLUMN"),
            kw("ADD CONSTRAINT"),
            kw("ADD PRIMARY KEY"),
            kw("ADD FOREIGN KEY"),
            kw("ADD UNIQUE"),
            kw("SET DEFAULT"),
            kw("DROP DEFAULT"),
            kw("SET NOT NULL"),
            kw("DROP NOT NULL"),
            kw("ENABLE TRIGGER"),
            kw("DISABLE TRIGGER"),
            kw("ATTACH PARTITION"),
            kw("DETACH PARTITION"),
        ],

        SqlContext::DropTable => vec![kw_s("IF EXISTS"), kw("CASCADE"), kw("RESTRICT")],

        SqlContext::Update => vec![kw_s("SET"), kw("AS")],

        SqlContext::DeleteFrom => vec![kw_s("WHERE"), kw("USING"), kw("RETURNING"), kw("*")],

        SqlContext::With => vec![
            snip("CTE", "${1:cte_name} AS (\n  SELECT ${2:*} FROM ${3:table}\n)", "Common Table Expression"),
            kw("RECURSIVE"),
        ],

        SqlContext::SetOp => vec![
            kw_s("SELECT"),
            snip("SELECT *", "SELECT ${1:*} FROM ${2:table}", "Next branch of set operation"),
        ],

        SqlContext::Unknown => statement_starters(),
    }
}

fn statement_starters() -> Vec<Completion> {
    vec![
        kw_s("SELECT"),
        kw_s("INSERT INTO"),
        kw_s("UPDATE"),
        kw_s("DELETE FROM"),
        kw_s("CREATE TABLE"),
        kw_s("DROP TABLE"),
        kw_s("ALTER TABLE"),
        kw_s("TRUNCATE"),
        kw_s("WITH"),
        kw_s("EXPLAIN"),
        kw_s("EXPLAIN ANALYZE"),
        kw("BEGIN"),
        kw("COMMIT"),
        kw("ROLLBACK"),
        kw("VACUUM"),
        kw("ANALYZE"),
    ]
}

/// Context-aware completions for the cursor position.
pub fn complete(sql: &str, cursor: usize) -> CompletionResult {
    let ctx = detect_context(sql, cursor);
    let (suggest_tables, suggest_columns) = match ctx {
        SqlContext::From | SqlContext::Join => (true, false),
        SqlContext::InsertInto
        | SqlContext::AlterTable
        | SqlContext::DropTable
        | SqlContext::Update
        | SqlContext::DeleteFrom => (true, false),
        SqlContext::Select
        | SqlContext::Where
        | SqlContext::On
        | SqlContext::Having
        | SqlContext::OrderBy
        | SqlContext::GroupBy
        | SqlContext::Set => (false, true),
        SqlContext::CreateTable
        | SqlContext::With
        | SqlContext::Values
        | SqlContext::SetOp
        | SqlContext::Unknown => (false, false),
    };
    CompletionResult { items: completions_for(ctx), suggest_tables, suggest_columns }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn select_context() {
        assert_eq!(detect_context("SELECT ", 7), SqlContext::Select);
    }

    #[test]
    fn from_context() {
        assert_eq!(detect_context("SELECT * FROM ", 14), SqlContext::From);
    }

    #[test]
    fn where_context() {
        assert_eq!(detect_context("SELECT * FROM t WHERE ", 22), SqlContext::Where);
    }

    #[test]
    fn join_context() {
        assert_eq!(detect_context("SELECT * FROM t LEFT JOIN ", 26), SqlContext::Join);
    }

    #[test]
    fn order_by_context() {
        assert_eq!(detect_context("SELECT * FROM t ORDER BY ", 25), SqlContext::OrderBy);
    }

    #[test]
    fn group_by_context() {
        assert_eq!(detect_context("SELECT * FROM t GROUP BY ", 25), SqlContext::GroupBy);
    }

    #[test]
    fn string_literal_ignored() {
        // WHERE inside a string must not affect context.
        assert_eq!(detect_context("SELECT 'from table' FROM t WHERE ", 33), SqlContext::Where);
    }

    #[test]
    fn select_returns_aggregate_functions() {
        let c = complete("SELECT ", 7);
        assert!(c.items.iter().any(|x| x.label == "COUNT"));
        assert!(c.items.iter().any(|x| x.label == "SUM"));
        assert!(c.items.iter().any(|x| x.label == "DISTINCT"));
    }

    #[test]
    fn where_returns_operators() {
        let c = complete("SELECT * FROM t WHERE ", 22);
        assert!(c.items.iter().any(|x| x.label == "IS NULL"));
        assert!(c.items.iter().any(|x| x.label == "BETWEEN"));
        assert!(c.items.iter().any(|x| x.label == "ILIKE"));
    }

    #[test]
    fn order_by_returns_asc_desc() {
        let c = complete("SELECT * FROM t ORDER BY id ", 28);
        assert!(c.items.iter().any(|x| x.label == "ASC"));
        assert!(c.items.iter().any(|x| x.label == "DESC"));
        assert!(c.items.iter().any(|x| x.label == "NULLS LAST"));
    }
}
