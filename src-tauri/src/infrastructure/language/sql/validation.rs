//! SQL validation: parse each statement with the engine's dialect, and (when a
//! schema index is supplied) flag references to tables that don't exist. Pure and
//! parallel-friendly — the batch path fans out across rayon workers.

use std::collections::HashSet;
use std::ops::ControlFlow;

use rayon::prelude::*;
use sqlparser::ast::{ObjectName, Query, TableFactor, Visit, Visitor};
use sqlparser::dialect::{Dialect, GenericDialect, MySqlDialect, PostgreSqlDialect, SQLiteDialect};
use sqlparser::parser::{Parser, ParserError};

use crate::domain::capabilities::SqlDialect;
use crate::domain::models::language::{Diagnostic, SchemaIndex, StatementInput};

/// Map our dialect enum to a concrete sqlparser dialect. Constructed per call
/// (the structs are zero-sized) so it never needs to cross thread boundaries.
pub(super) fn parser_dialect(d: SqlDialect) -> Box<dyn Dialect> {
    match d {
        SqlDialect::Postgres => Box::new(PostgreSqlDialect {}),
        SqlDialect::MySql    => Box::new(MySqlDialect {}),
        SqlDialect::Sqlite   => Box::new(SQLiteDialect {}),
        SqlDialect::Generic  => Box::new(GenericDialect {}),
    }
}

const STMT_KEYWORDS: &[&str] = &[
    "SELECT", "INSERT", "UPDATE", "DELETE", "CREATE", "DROP", "ALTER", "TRUNCATE", "WITH", "MERGE",
    "CALL", "EXPLAIN",
];

fn looks_like_statement_start(line: &str) -> bool {
    let upper = line.trim_start().to_uppercase();
    STMT_KEYWORDS.iter().any(|kw| upper.starts_with(kw))
}

/// Validate a whole document. Fast-paths the common all-valid case, then locates
/// per-statement errors by their start line.
pub fn validate(sql: &str, dialect: SqlDialect) -> Vec<Diagnostic> {
    if sql.trim().is_empty() {
        return vec![];
    }

    let dialect = parser_dialect(dialect);

    // Fast path
    if Parser::parse_sql(dialect.as_ref(), sql).is_ok() {
        return vec![];
    }

    // Scan lines to find statement start positions (0-indexed)
    let lines: Vec<&str> = sql.lines().collect();
    let mut stmt_starts: Vec<usize> = Vec::new();
    for (i, line) in lines.iter().enumerate() {
        if looks_like_statement_start(line) {
            stmt_starts.push(i);
        }
    }

    // No statement boundaries detected — report whole-SQL error on line 1
    if stmt_starts.is_empty() {
        return if let Err(e) = Parser::parse_sql(dialect.as_ref(), sql.trim()) {
            vec![diagnostic_from_error(e)]
        } else {
            vec![]
        };
    }

    // Sentinel
    stmt_starts.push(lines.len());

    let mut diagnostics: Vec<Diagnostic> = Vec::new();

    for window in stmt_starts.windows(2) {
        let start = window[0]; // 0-indexed line of statement start
        let end = window[1];
        let stmt_lines = &lines[start..end];
        let stmt = stmt_lines.join("\n");
        if stmt.trim().is_empty() {
            continue;
        }

        // Strip trailing semicolon for parsing
        let stmt_clean = stmt.trim().trim_end_matches(';').trim();
        if stmt_clean.is_empty() {
            continue;
        }

        if let Err(e) = Parser::parse_sql(dialect.as_ref(), stmt_clean) {
            let mut d = diagnostic_from_error(e);
            d.line += start as u32;
            diagnostics.push(d);
        }
    }

    diagnostics
}

/// Validate pre-split statements in parallel. When `schema` is present, table
/// references absent from it are flagged as warnings.
pub fn validate_batch(
    statements: &[StatementInput],
    schema:     Option<&SchemaIndex>,
    dialect:    SqlDialect,
) -> Vec<Diagnostic> {
    statements
        .par_iter()
        .flat_map(|stmt| {
            let trimmed = stmt.sql.trim().trim_end_matches(';').trim().to_string();
            if trimmed.is_empty() {
                return vec![];
            }

            // Constructed inside the closure so nothing non-Sync crosses workers.
            let dialect = parser_dialect(dialect);
            match Parser::parse_sql(dialect.as_ref(), &trimmed) {
                Ok(ast) => match schema {
                    Some(idx) => {
                        let mut checker = TableChecker {
                            idx,
                            ctes: HashSet::new(),
                            start_line: stmt.start_line,
                            diags: Vec::new(),
                        };
                        let _ = ast.visit(&mut checker);
                        checker.diags
                    }
                    None => vec![],
                },
                Err(e) => {
                    let mut d = diagnostic_from_error(e);
                    // start_line is 0-indexed → add to 1-indexed d.line
                    d.line += stmt.start_line;
                    vec![d]
                }
            }
        })
        .collect()
}

/// Walks parsed statements, flagging table references not present in the index.
/// CTE names and table-valued functions are excluded to avoid false positives.
struct TableChecker<'a> {
    idx:        &'a SchemaIndex,
    ctes:       HashSet<String>,
    start_line: u32,
    diags:      Vec<Diagnostic>,
}

impl Visitor for TableChecker<'_> {
    type Break = ();

    fn pre_visit_query(&mut self, query: &Query) -> ControlFlow<()> {
        if let Some(with) = &query.with {
            for cte in &with.cte_tables {
                self.ctes.insert(cte.alias.name.value.to_lowercase());
            }
        }
        ControlFlow::Continue(())
    }

    fn pre_visit_table_factor(&mut self, tf: &TableFactor) -> ControlFlow<()> {
        if let TableFactor::Table { name, args, .. } = tf {
            // `args.is_some()` ⇒ table-valued function (unnest, generate_series, …) — skip.
            if args.is_none() {
                self.check_relation(name);
            }
        }
        ControlFlow::Continue(())
    }
}

impl TableChecker<'_> {
    fn check_relation(&mut self, name: &ObjectName) {
        let parts = &name.0;
        if parts.is_empty() {
            return;
        }

        let table = parts[parts.len() - 1].value.to_lowercase();
        // CTE reference — always valid.
        if self.ctes.contains(&table) {
            return;
        }

        let (found, display) = if parts.len() == 1 {
            (self.idx.bare.contains(&table), table.clone())
        } else {
            let schema = parts[parts.len() - 2].value.to_lowercase();
            let display = format!("{}.{}", parts[parts.len() - 2].value, parts[parts.len() - 1].value);
            (self.idx.qualified.contains(&format!("{schema}.{table}")), display)
        };

        if found {
            return;
        }

        let last = &parts[parts.len() - 1];
        let line = self.start_line + last.span.start.line as u32;
        let col = last.span.start.column as u32;
        let len = last.value.chars().count() as u32;
        self.diags.push(Diagnostic {
            line,
            column: col,
            end_column: col + len.max(1),
            message: format!("Table \"{display}\" not found in schema"),
            severity: "warning".into(),
        });
    }
}

fn diagnostic_from_error(error: ParserError) -> Diagnostic {
    match error {
        ParserError::TokenizerError(msg) => {
            let (line, col) = extract_location(&msg).unwrap_or((1, 1));
            Diagnostic {
                line,
                column: col,
                end_column: col + 1,
                message: clean_message(&msg),
                severity: "error".into(),
            }
        }
        ParserError::ParserError(msg) => {
            let (line, col) = extract_location(&msg).unwrap_or((1, 1));
            Diagnostic {
                line,
                column: col,
                end_column: col + 1,
                message: clean_message(&msg),
                severity: "error".into(),
            }
        }
        ParserError::RecursionLimitExceeded => Diagnostic {
            line: 1,
            column: 1,
            end_column: 2,
            message: "Query is too deeply nested".into(),
            severity: "error".into(),
        },
    }
}

fn extract_location(msg: &str) -> Option<(u32, u32)> {
    // sqlparser emits: "... at Line: 2, Column: 5" (case-insensitive)
    let upper = msg.to_uppercase();
    let line = extract_number_after(&upper, "LINE: ").or_else(|| extract_number_after(&upper, "LINE "))?;
    let col = extract_number_after(&upper, "COLUMN: ")
        .or_else(|| extract_number_after(&upper, "COL: "))
        .or_else(|| extract_number_after(&upper, "COL "))
        .unwrap_or(1);
    Some((line, col))
}

fn extract_number_after(s: &str, key: &str) -> Option<u32> {
    let idx = s.find(key)?;
    let rest = &s[idx + key.len()..];
    let num: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
    num.parse().ok()
}

fn clean_message(msg: &str) -> String {
    let msg = msg
        .trim_start_matches("sql parser error: ")
        .trim_start_matches("tokenizer error: ");

    // Strip location suffix " at Line: X, Column: Y" for display
    let msg = if let Some(i) = msg.find(" at Line:") { &msg[..i] } else { msg };

    // Extract the "found: TOKEN" part for reuse
    let found = extract_found_token(msg);

    // Match common patterns → friendly messages
    let lower = msg.to_lowercase();

    if lower.contains("expected: end of statement") {
        return match &found {
            Some(t) => format!("Unexpected '{}' — extra token or missing operator", t),
            None => "Unexpected token — check for extra words or missing operators".into(),
        };
    }

    if lower.contains("expected an expression") {
        return match &found {
            Some(t) if t == "eof" => "Incomplete query — unexpected end of input".into(),
            Some(t) => format!("Expected an expression, got '{}'", t),
            None => "Expected an expression here".into(),
        };
    }

    if lower.contains("expected: select or a subquery") {
        return "Expected SELECT, INSERT, UPDATE or DELETE statement".into();
    }

    if lower.contains("expected: from") || lower.contains("expected: ,, found:") {
        return match &found {
            Some(t) => format!("Syntax error near '{}' — check your query structure", t),
            None => "Syntax error — check your query structure".into(),
        };
    }

    if lower.contains("expected: )") {
        return "Missing closing parenthesis ')'".into();
    }

    if lower.contains("expected: (") {
        return "Missing opening parenthesis '('".into();
    }

    if lower.contains("unterminated string literal") || lower.contains("unterminated quoted") {
        return "Unterminated string literal — missing closing quote".into();
    }

    if lower.contains("unexpected eof") || (lower.contains("found: eof") && lower.contains("expected")) {
        return "Incomplete query — unexpected end of input".into();
    }

    if lower.contains("expected:")
        && let Some(expected) = extract_expected_token(msg)
    {
        return match &found {
            Some(f) => format!("Expected '{}', got '{}'", expected, f),
            None => format!("Expected '{}'", expected),
        };
    }

    // Fallback: strip noise, capitalize
    let mut chars = msg.chars();
    match chars.next() {
        None => String::new(),
        Some(c) => c.to_uppercase().collect::<String>() + chars.as_str(),
    }
}

fn extract_found_token(msg: &str) -> Option<String> {
    let lower = msg.to_lowercase();
    let key = "found: ";
    let idx = lower.find(key)?;
    let rest = &msg[idx + key.len()..];
    // Take until comma, 'at', or end
    let token = rest.split([',', '\n']).next()?.trim();
    let token = token.split(" at ").next()?.trim();
    Some(token.to_lowercase())
}

fn extract_expected_token(msg: &str) -> Option<String> {
    let lower = msg.to_lowercase();
    let key = "expected: ";
    let idx = lower.find(key)?;
    let rest = &msg[idx + key.len()..];
    let token = rest.split([',', '\n']).next()?.trim();
    let token = token.split(" found").next()?.trim();
    Some(token.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::models::language::SchemaTable;

    const PG: SqlDialect = SqlDialect::Postgres;

    fn check_tables(sql: &str, tables: &[(&str, &str)]) -> Vec<Diagnostic> {
        let owned: Vec<SchemaTable> = tables
            .iter()
            .map(|(s, n)| SchemaTable { schema: s.to_string(), name: n.to_string() })
            .collect();
        let idx = SchemaIndex::from_tables(&owned);
        let stmts = [StatementInput { start_line: 0, sql: sql.to_string() }];
        validate_batch(&stmts, Some(&idx), PG)
    }

    #[test]
    fn valid_select_returns_empty() {
        assert!(validate("SELECT * FROM users WHERE id = 1", PG).is_empty());
    }

    #[test]
    fn valid_complex_query_returns_empty() {
        let sql = "SELECT u.id, COUNT(o.id) FROM users u LEFT JOIN orders o ON u.id = o.user_id GROUP BY u.id ORDER BY 2 DESC";
        assert!(validate(sql, PG).is_empty());
    }

    #[test]
    fn empty_sql_returns_empty() {
        assert!(validate("", PG).is_empty());
        assert!(validate("   ", PG).is_empty());
    }

    #[test]
    fn invalid_sql_returns_diagnostic() {
        let diags = validate("SELECT FROM WHERE", PG);
        assert!(!diags.is_empty());
        assert_eq!(diags[0].severity, "error");
    }

    #[test]
    fn unclosed_paren_returns_error() {
        assert!(!validate("SELECT (1 + 2 FROM t", PG).is_empty());
    }

    #[test]
    fn multiple_statements_valid() {
        assert!(validate("SELECT 1; SELECT 2;", PG).is_empty());
    }

    #[test]
    fn extract_location_parses_sqlparser_format() {
        let msg = "Expected an expression, found: EOF at Line: 2, Column: 5";
        assert_eq!(extract_location(msg), Some((2, 5)));
    }

    #[test]
    fn extra_token_after_where_is_error() {
        let diags = validate("SELECT * FROM banking.sell WHERE a = a a", PG);
        assert!(!diags.is_empty(), "should report error for trailing token");
    }

    #[test]
    fn error_location_is_not_last_line() {
        // "SELECT (1+" is an error — location should be line 1, not the last line.
        let diags = validate("SELECT (1+", PG);
        if !diags.is_empty() {
            assert_eq!(diags[0].line, 1, "Error should be on line 1");
        }
    }

    #[test]
    fn known_table_no_warning() {
        assert!(check_tables("SELECT * FROM users", &[("public", "users")]).is_empty());
    }

    #[test]
    fn unknown_table_warns() {
        let d = check_tables("SELECT * FROM bankking", &[("public", "banking")]);
        assert_eq!(d.len(), 1);
        assert_eq!(d[0].severity, "warning");
        assert!(d[0].message.contains("bankking"));
    }

    #[test]
    fn qualified_table_checked() {
        assert!(check_tables("SELECT * FROM banking.sell", &[("banking", "sell")]).is_empty());
        assert_eq!(check_tables("SELECT * FROM banking.nope", &[("banking", "sell")]).len(), 1);
    }

    #[test]
    fn cte_not_flagged() {
        let sql = "WITH t AS (SELECT 1) SELECT * FROM t";
        assert!(check_tables(sql, &[("public", "users")]).is_empty());
    }

    #[test]
    fn table_function_not_flagged() {
        assert!(check_tables("SELECT * FROM generate_series(1, 10)", &[("public", "users")]).is_empty());
    }

    #[test]
    fn alias_not_flagged() {
        assert!(check_tables("SELECT u.id FROM users u", &[("public", "users")]).is_empty());
    }

    #[test]
    fn join_unknown_table_warns() {
        let d = check_tables(
            "SELECT * FROM users u JOIN nope n ON n.id = u.id",
            &[("public", "users")],
        );
        assert_eq!(d.len(), 1);
        assert!(d[0].message.contains("nope"));
    }
}
