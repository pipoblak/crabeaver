//! SQL `LanguageService`: a dialect-parameterized validator + completer. One
//! instance per `SqlDialect`; validation parses with that dialect's rules so
//! Postgres, MySQL, and SQLite each lint correctly.

mod completion;
mod validation;

use crate::domain::capabilities::SqlDialect;
use crate::domain::models::language::{CompletionResult, Diagnostic, SchemaIndex, StatementInput};
use crate::domain::ports::language_service::LanguageService;

pub struct SqlLanguageService {
    dialect: SqlDialect,
}

impl SqlLanguageService {
    pub fn new(dialect: SqlDialect) -> Self {
        Self { dialect }
    }
}

impl LanguageService for SqlLanguageService {
    fn validate(&self, sql: &str) -> Vec<Diagnostic> {
        validation::validate(sql, self.dialect)
    }

    fn validate_batch(
        &self,
        statements: &[StatementInput],
        schema:     Option<&SchemaIndex>,
    ) -> Vec<Diagnostic> {
        validation::validate_batch(statements, schema, self.dialect)
    }

    fn complete(&self, sql: &str, cursor: usize) -> CompletionResult {
        completion::complete(sql, cursor)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dialect_routing_actually_changes_validation() {
        // Backtick-quoted identifiers are valid MySQL but not Postgres. If the
        // service didn't route by dialect, both would behave identically.
        let sql = "SELECT `id` FROM `users`";
        let mysql = SqlLanguageService::new(SqlDialect::MySql);
        let postgres = SqlLanguageService::new(SqlDialect::Postgres);
        assert!(mysql.validate(sql).is_empty(), "MySQL should accept backticks");
        assert!(!postgres.validate(sql).is_empty(), "Postgres should reject backticks");
    }
}
