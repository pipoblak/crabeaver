use rayon::prelude::*;
use serde::{Deserialize, Serialize};
use sqlparser::dialect::GenericDialect;
use sqlparser::parser::{Parser, ParserError};

#[derive(Debug, Serialize, Deserialize)]
pub struct SqlDiagnostic {
    pub line: u32,
    pub column: u32,
    pub end_column: u32,
    pub message: String,
    pub severity: String, // "error" | "warning"
}

const STMT_KEYWORDS: &[&str] = &[
    "SELECT", "INSERT", "UPDATE", "DELETE", "CREATE", "DROP",
    "ALTER", "TRUNCATE", "WITH", "MERGE", "CALL", "EXPLAIN",
];

fn looks_like_statement_start(line: &str) -> bool {
    let upper = line.trim_start().to_uppercase();
    STMT_KEYWORDS.iter().any(|kw| upper.starts_with(kw))
}

#[tauri::command]
pub fn validate_sql(sql: String) -> Vec<SqlDiagnostic> {
    if sql.trim().is_empty() { return vec![]; }

    let dialect = GenericDialect {};

    // Fast path
    if Parser::parse_sql(&dialect, &sql).is_ok() { return vec![]; }

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
        return if let Err(e) = Parser::parse_sql(&dialect, sql.trim()) {
            vec![diagnostic_from_error(sql.trim(), e)]
        } else {
            vec![]
        };
    }

    // Sentinel
    stmt_starts.push(lines.len());

    let mut diagnostics: Vec<SqlDiagnostic> = Vec::new();

    for window in stmt_starts.windows(2) {
        let start = window[0]; // 0-indexed line of statement start
        let end   = window[1];
        let stmt_lines = &lines[start..end];
        let stmt = stmt_lines.join("\n");
        if stmt.trim().is_empty() { continue; }

        // Strip trailing semicolon for parsing
        let stmt_clean = stmt.trim().trim_end_matches(';').trim();
        if stmt_clean.is_empty() { continue; }

        // Check if previous statement ended with ';' — if not, this is a warning
        let prev_ended_with_semi = start == 0 || {
            // Look at the line just before this statement start
            (0..start).rev()
                .find(|&i| !lines[i].trim().is_empty())
                .map(|i| lines[i].trim_end().ends_with(';'))
                .unwrap_or(true)
        };

        let _ = prev_ended_with_semi; // no semicolon warnings
        if let Err(e) = Parser::parse_sql(&dialect, stmt_clean) {
            let mut d = diagnostic_from_error(stmt_clean, e);
            d.line = start as u32 + d.line;
            diagnostics.push(d);
        }
    }

    diagnostics
}

#[derive(Debug, Deserialize)]
pub struct StatementInput {
    pub start_line: u32,
    pub sql: String,
}

/// Validate many statements in one IPC call — rayon parallelises across CPU cores.
/// start_line is 0-indexed; returned diagnostics have 1-indexed line in the whole file.
#[tauri::command]
pub fn validate_sql_batch(statements: Vec<StatementInput>) -> Vec<SqlDiagnostic> {
    statements
        .into_par_iter()
        .flat_map(|stmt| {
            let trimmed = stmt.sql.trim().trim_end_matches(';').trim().to_string();
            if trimmed.is_empty() { return vec![]; }

            let dialect = GenericDialect {};
            match Parser::parse_sql(&dialect, &trimmed) {
                Ok(_) => vec![],
                Err(e) => {
                    let mut d = diagnostic_from_error(&trimmed, e);
                    // start_line is 0-indexed → add to 1-indexed d.line
                    d.line = stmt.start_line + d.line;
                    vec![d]
                }
            }
        })
        .collect()
}

fn diagnostic_from_error(sql: &str, error: ParserError) -> SqlDiagnostic {
    match error {
        ParserError::TokenizerError(msg) => {
            let (line, col) = extract_location(&msg).unwrap_or((1, 1));
            SqlDiagnostic {
                line, column: col, end_column: col + 1,
                message: clean_message(&msg),
                severity: "error".into(),
            }
        }
        ParserError::ParserError(msg) => {
            let (line, col) = extract_location(&msg).unwrap_or((1, 1));
            SqlDiagnostic {
                line,
                column: col,
                end_column: col + 1,
                message: clean_message(&msg),
                severity: "error".into(),
            }
        }
        ParserError::RecursionLimitExceeded => SqlDiagnostic {
            line: 1, column: 1, end_column: 2,
            message: "Query is too deeply nested".into(),
            severity: "error".into(),
        },
    }
}

fn extract_location(msg: &str) -> Option<(u32, u32)> {
    // sqlparser emits: "... at Line: 2, Column: 5" (case-insensitive)
    let upper = msg.to_uppercase();
    let line = extract_number_after(&upper, "LINE: ")
        .or_else(|| extract_number_after(&upper, "LINE "))?;
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
            None    => "Unexpected token — check for extra words or missing operators".into(),
        };
    }

    if lower.contains("expected an expression") {
        return match &found {
            Some(t) if t == "eof" => "Incomplete query — unexpected end of input".into(),
            Some(t) => format!("Expected an expression, got '{}'", t),
            None    => "Expected an expression here".into(),
        };
    }

    if lower.contains("expected: select or a subquery") {
        return "Expected SELECT, INSERT, UPDATE or DELETE statement".into();
    }

    if lower.contains("expected: from") || lower.contains("expected: ,, found:") {
        return match &found {
            Some(t) => format!("Syntax error near '{}' — check your query structure", t),
            None    => "Syntax error — check your query structure".into(),
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

    if lower.contains("expected:") {
        if let Some(expected) = extract_expected_token(msg) {
            return match &found {
                Some(f) => format!("Expected '{}', got '{}'", expected, f),
                None    => format!("Expected '{}'", expected),
            };
        }
    }

    // Fallback: strip noise, capitalize
    let mut chars = msg.chars();
    match chars.next() {
        None    => String::new(),
        Some(c) => c.to_uppercase().collect::<String>() + chars.as_str(),
    }
}

fn extract_found_token(msg: &str) -> Option<String> {
    let lower = msg.to_lowercase();
    let key = "found: ";
    let idx = lower.find(key)?;
    let rest = &msg[idx + key.len()..];
    // Take until comma, 'at', or end
    let token = rest.split(|c| c == ',' || c == '\n').next()?.trim();
    let token = token.split(" at ").next()?.trim();
    Some(token.to_lowercase())
}

fn extract_expected_token(msg: &str) -> Option<String> {
    let lower = msg.to_lowercase();
    let key = "expected: ";
    let idx = lower.find(key)?;
    let rest = &msg[idx + key.len()..];
    let token = rest.split(|c| c == ',' || c == '\n').next()?.trim();
    let token = token.split(" found").next()?.trim();
    Some(token.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn valid_select_returns_empty() {
        assert!(validate_sql("SELECT * FROM users WHERE id = 1".into()).is_empty());
    }

    #[test]
    fn valid_complex_query_returns_empty() {
        let sql = "SELECT u.id, COUNT(o.id) FROM users u LEFT JOIN orders o ON u.id = o.user_id GROUP BY u.id ORDER BY 2 DESC";
        assert!(validate_sql(sql.into()).is_empty());
    }

    #[test]
    fn empty_sql_returns_empty() {
        assert!(validate_sql("".into()).is_empty());
        assert!(validate_sql("   ".into()).is_empty());
    }

    #[test]
    fn invalid_sql_returns_diagnostic() {
        let diags = validate_sql("SELECT FROM WHERE".into());
        assert!(!diags.is_empty());
        assert_eq!(diags[0].severity, "error");
    }

    #[test]
    fn unclosed_paren_returns_error() {
        let diags = validate_sql("SELECT (1 + 2 FROM t".into());
        assert!(!diags.is_empty());
    }

    #[test]
    fn multiple_statements_valid() {
        let diags = validate_sql("SELECT 1; SELECT 2;".into());
        assert!(diags.is_empty());
    }

    #[test]
    fn extract_location_parses_sqlparser_format() {
        // sqlparser emits: "Expected ..., found: X at Line: 2, Column: 5"
        let msg = "Expected an expression, found: EOF at Line: 2, Column: 5";
        let loc = super::extract_location(msg);
        assert_eq!(loc, Some((2, 5)));
    }

    #[test]
    fn extra_token_after_where_is_error() {
        // "a = a a" — extra trailing `a` should be invalid
        let diags = validate_sql("SELECT * FROM banking.sell WHERE a = a a".into());
        eprintln!("diags: {:?}", diags);
        assert!(!diags.is_empty(), "should report error for trailing token");
    }

    #[test]
    fn error_location_is_not_last_line() {
        // "SELECT (1+" is an error — location should be line 1, not last line
        let diags = validate_sql("SELECT (1+".into());
        if !diags.is_empty() {
            assert_eq!(diags[0].line, 1, "Error should be on line 1, not last line");
        }
    }
}
