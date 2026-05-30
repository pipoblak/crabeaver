use crate::domain::models::language::{CompletionResult, Diagnostic, SchemaIndex, StatementInput};

/// Linting + completion for one query language/dialect. Implemented per dialect in
/// `infrastructure/language/`. Pure and synchronous — no I/O, so it parallelizes
/// freely (the batch path runs across rayon workers).
///
/// A non-SQL engine (e.g. DynamoDB / PartiQL) would provide its own implementation;
/// the SQL implementation is dialect-parameterized so Postgres, MySQL, and SQLite
/// each parse and complete with their own rules.
pub trait LanguageService: Send + Sync {
    /// Validate a whole document, locating per-statement errors by line.
    fn validate(&self, sql: &str) -> Vec<Diagnostic>;

    /// Validate pre-split statements, optionally flagging references to tables
    /// absent from `schema`. Used for the incremental/parallel editor path.
    fn validate_batch(
        &self,
        statements: &[StatementInput],
        schema:     Option<&SchemaIndex>,
    ) -> Vec<Diagnostic>;

    /// Context-aware completions for the cursor position (byte offset into `sql`).
    fn complete(&self, sql: &str, cursor: usize) -> CompletionResult;
}
