use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct SqlCompletion {
    pub label: String,
    pub kind: String,        // "keyword" | "function" | "snippet"
    pub insert_text: String,
    pub detail: String,
    pub documentation: Option<String>,
}

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
    Set,        // UPDATE SET
    Unknown,
}

fn detect_context(sql: &str, cursor_offset: usize) -> SqlContext {
    let text = sql[..cursor_offset.min(sql.len())].to_uppercase();

    // Strip string literals to avoid false keyword matches inside quotes
    let mut clean = String::with_capacity(text.len());
    let mut in_single = false;
    let mut in_double = false;
    for ch in text.chars() {
        match ch {
            '\'' if !in_double => { in_single = !in_single; clean.push(' '); }
            '"' if !in_single => { in_double = !in_double; clean.push(' '); }
            _ if in_single || in_double => clean.push(' '),
            _ => clean.push(ch),
        }
    }

    // Find the latest-positioned context keyword
    let markers: &[(&str, SqlContext)] = &[
        ("ORDER BY",   SqlContext::OrderBy),
        ("GROUP BY",   SqlContext::GroupBy),
        ("INSERT INTO", SqlContext::InsertInto),
        ("FULL OUTER JOIN", SqlContext::Join),
        ("LEFT OUTER JOIN", SqlContext::Join),
        ("RIGHT OUTER JOIN", SqlContext::Join),
        ("LEFT JOIN",  SqlContext::Join),
        ("RIGHT JOIN", SqlContext::Join),
        ("INNER JOIN", SqlContext::Join),
        ("CROSS JOIN", SqlContext::Join),
        ("JOIN",       SqlContext::Join),
        ("VALUES",     SqlContext::Values),
        ("HAVING",     SqlContext::Having),
        ("WHERE",      SqlContext::Where),
        ("FROM",       SqlContext::From),
        ("SELECT",     SqlContext::Select),
        (" ON ",       SqlContext::On),
        (" SET ",      SqlContext::Set),
    ];

    let mut latest_pos: Option<usize> = None;
    let mut context = SqlContext::Unknown;

    for (marker, ctx) in markers {
        if let Some(pos) = clean.rfind(marker) {
            let end = pos + marker.len();
            if latest_pos.map_or(true, |p| end > p) {
                latest_pos = Some(end);
                context = ctx.clone();
            }
        }
    }

    context
}

fn kw(label: &str) -> SqlCompletion {
    SqlCompletion {
        label: label.to_string(),
        kind: "keyword".to_string(),
        insert_text: label.to_string(),
        detail: "keyword".to_string(),
        documentation: None,
    }
}

fn func(label: &str, insert: &str, doc: &str) -> SqlCompletion {
    SqlCompletion {
        label: label.to_string(),
        kind: "function".to_string(),
        insert_text: insert.to_string(),
        detail: "function".to_string(),
        documentation: Some(doc.to_string()),
    }
}

fn snip(label: &str, insert: &str, doc: &str) -> SqlCompletion {
    SqlCompletion {
        label: label.to_string(),
        kind: "snippet".to_string(),
        insert_text: insert.to_string(),
        detail: "snippet".to_string(),
        documentation: Some(doc.to_string()),
    }
}

fn completions_for(ctx: SqlContext) -> Vec<SqlCompletion> {
    match ctx {
        SqlContext::Select => vec![
            kw("*"),
            kw("DISTINCT"),
            kw("ALL"),
            kw("TOP"),
            func("COUNT",    "COUNT(${1:*})",               "Count rows"),
            func("COUNT DISTINCT", "COUNT(DISTINCT ${1:col})", "Count distinct values"),
            func("SUM",      "SUM(${1:col})",               "Sum values"),
            func("AVG",      "AVG(${1:col})",               "Average value"),
            func("MIN",      "MIN(${1:col})",               "Minimum value"),
            func("MAX",      "MAX(${1:col})",               "Maximum value"),
            func("COALESCE", "COALESCE(${1:a}, ${2:b})",   "First non-null value"),
            func("NULLIF",   "NULLIF(${1:a}, ${2:b})",     "Null if equal"),
            func("CAST",     "CAST(${1:expr} AS ${2:type})", "Cast to type"),
            func("CASE",     "CASE\n  WHEN ${1:cond} THEN ${2:val}\n  ELSE ${3:val}\nEND", "Conditional expression"),
            func("IIF",      "IIF(${1:cond}, ${2:true}, ${3:false})", "Inline if"),
            func("ROW_NUMBER",  "ROW_NUMBER() OVER (${1:PARTITION BY col ORDER BY col})", "Window: row number"),
            func("RANK",        "RANK() OVER (${1:PARTITION BY col ORDER BY col})", "Window: rank"),
            func("DENSE_RANK",  "DENSE_RANK() OVER (${1:ORDER BY col})", "Window: dense rank"),
            func("LAG",         "LAG(${1:col}, ${2:1}) OVER (${3:ORDER BY col})", "Window: previous row"),
            func("LEAD",        "LEAD(${1:col}, ${2:1}) OVER (${3:ORDER BY col})", "Window: next row"),
            func("FIRST_VALUE", "FIRST_VALUE(${1:col}) OVER (${2:ORDER BY col})", "Window: first value"),
            func("LAST_VALUE",  "LAST_VALUE(${1:col}) OVER (${2:ORDER BY col})", "Window: last value"),
            func("NOW",      "NOW()",                       "Current timestamp"),
            func("CURRENT_DATE", "CURRENT_DATE",           "Current date"),
            func("EXTRACT",  "EXTRACT(${1:YEAR} FROM ${2:col})", "Extract date part"),
            func("DATE_TRUNC", "DATE_TRUNC('${1:month}', ${2:col})", "Truncate to date part"),
            func("TO_CHAR",  "TO_CHAR(${1:col}, '${2:format}')", "Format value"),
            func("UPPER",    "UPPER(${1:col})",             "Uppercase string"),
            func("LOWER",    "LOWER(${1:col})",             "Lowercase string"),
            func("TRIM",     "TRIM(${1:col})",              "Trim whitespace"),
            func("LENGTH",   "LENGTH(${1:col})",            "String length"),
            func("CONCAT",   "CONCAT(${1:a}, ${2:b})",     "Concatenate strings"),
            func("SUBSTRING", "SUBSTRING(${1:col} FROM ${2:1} FOR ${3:n})", "Substring"),
            func("REPLACE",  "REPLACE(${1:col}, '${2:from}', '${3:to}')", "Replace in string"),
            func("ROUND",    "ROUND(${1:col}, ${2:0})",    "Round number"),
            func("ABS",      "ABS(${1:col})",              "Absolute value"),
            func("FLOOR",    "FLOOR(${1:col})",            "Floor value"),
            func("CEIL",     "CEIL(${1:col})",             "Ceiling value"),
        ],

        SqlContext::From | SqlContext::Join => vec![
            kw("JOIN"),
            kw("LEFT JOIN"),
            kw("RIGHT JOIN"),
            kw("INNER JOIN"),
            kw("FULL OUTER JOIN"),
            kw("CROSS JOIN"),
            kw("LEFT LATERAL JOIN"),
            kw("LATERAL"),
            kw("UNNEST"),
            kw("AS"),
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
            snip("IN list",       "${1:col} IN (${2:val1}, ${3:val2})",     "Value in list"),
            snip("IN subquery",   "${1:col} IN (SELECT ${2:col} FROM ${3:table})", "Subquery membership"),
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

        SqlContext::Set => vec![
            kw("WHERE"),
            kw("RETURNING"),
            snip("col = value", "${1:col} = ${2:value}", "Set column value"),
            snip("col = EXCLUDED.col", "${1:col} = EXCLUDED.${1:col}", "Set from excluded (upsert)"),
        ],

        SqlContext::Unknown => all_keywords(),

        _ => all_keywords(),
    }
}

fn all_keywords() -> Vec<SqlCompletion> {
    vec![
        kw("SELECT"), kw("FROM"), kw("WHERE"), kw("JOIN"), kw("LEFT JOIN"),
        kw("RIGHT JOIN"), kw("INNER JOIN"), kw("FULL OUTER JOIN"), kw("ON"),
        kw("GROUP BY"), kw("ORDER BY"), kw("HAVING"), kw("LIMIT"), kw("OFFSET"),
        kw("INSERT INTO"), kw("VALUES"), kw("UPDATE"), kw("SET"), kw("DELETE FROM"),
        kw("CREATE TABLE"), kw("DROP TABLE"), kw("ALTER TABLE"), kw("TRUNCATE"),
        kw("WITH"), kw("UNION"), kw("UNION ALL"), kw("INTERSECT"), kw("EXCEPT"),
        kw("DISTINCT"), kw("AS"), kw("AND"), kw("OR"), kw("NOT"),
        kw("IS NULL"), kw("IS NOT NULL"), kw("IN"), kw("LIKE"), kw("BETWEEN"),
        kw("EXISTS"), kw("ASC"), kw("DESC"), kw("RETURNING"),
    ]
}

#[tauri::command]
pub fn get_sql_completions(sql: String, cursor_offset: u32) -> Vec<SqlCompletion> {
    let ctx = detect_context(&sql, cursor_offset as usize);
    completions_for(ctx)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn select_context() {
        let ctx = detect_context("SELECT ", 7);
        assert_eq!(ctx, SqlContext::Select);
    }

    #[test]
    fn from_context() {
        let ctx = detect_context("SELECT * FROM ", 14);
        assert_eq!(ctx, SqlContext::From);
    }

    #[test]
    fn where_context() {
        let ctx = detect_context("SELECT * FROM t WHERE ", 22);
        assert_eq!(ctx, SqlContext::Where);
    }

    #[test]
    fn join_context() {
        let ctx = detect_context("SELECT * FROM t LEFT JOIN ", 26);
        assert_eq!(ctx, SqlContext::Join);
    }

    #[test]
    fn order_by_context() {
        let ctx = detect_context("SELECT * FROM t ORDER BY ", 25);
        assert_eq!(ctx, SqlContext::OrderBy);
    }

    #[test]
    fn group_by_context() {
        let ctx = detect_context("SELECT * FROM t GROUP BY ", 25);
        assert_eq!(ctx, SqlContext::GroupBy);
    }

    #[test]
    fn string_literal_ignored() {
        // WHERE inside string must not affect context
        let ctx = detect_context("SELECT 'from table' FROM t WHERE ", 33);
        assert_eq!(ctx, SqlContext::Where);
    }

    #[test]
    fn select_returns_aggregate_functions() {
        let completions = get_sql_completions("SELECT ".into(), 7);
        assert!(completions.iter().any(|c| c.label == "COUNT"));
        assert!(completions.iter().any(|c| c.label == "SUM"));
        assert!(completions.iter().any(|c| c.label == "DISTINCT"));
    }

    #[test]
    fn where_returns_operators() {
        let completions = get_sql_completions("SELECT * FROM t WHERE ".into(), 22);
        assert!(completions.iter().any(|c| c.label == "IS NULL"));
        assert!(completions.iter().any(|c| c.label == "BETWEEN"));
        assert!(completions.iter().any(|c| c.label == "ILIKE"));
    }

    #[test]
    fn order_by_returns_asc_desc() {
        let completions = get_sql_completions("SELECT * FROM t ORDER BY id ".into(), 28);
        assert!(completions.iter().any(|c| c.label == "ASC"));
        assert!(completions.iter().any(|c| c.label == "DESC"));
        assert!(completions.iter().any(|c| c.label == "NULLS LAST"));
    }
}
