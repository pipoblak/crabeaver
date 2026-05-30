use std::collections::HashSet;

use serde::{Deserialize, Serialize};

/// One squiggle in the editor. Field names are snake_case on the wire because the
/// frontend reads `end_column` directly — do not add `rename_all`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Diagnostic {
    pub line:       u32,
    pub column:     u32,
    pub end_column: u32,
    pub message:    String,
    pub severity:   String, // "error" | "warning"
}

/// One autocomplete entry. `insert_text` is snake_case on the wire (frontend reads
/// `c.insert_text`) — do not add `rename_all`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Completion {
    pub label:         String,
    pub kind:          String, // "keyword" | "structural" | "function" | "snippet"
    pub insert_text:   String,
    pub detail:        String,
    pub documentation: Option<String>,
}

/// Completion items plus flags telling the frontend whether to inject schema
/// (table / column) suggestions for the current context.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompletionResult {
    pub items:           Vec<Completion>,
    pub suggest_tables:  bool,
    pub suggest_columns: bool,
}

/// One statement to validate, with its 0-indexed start line in the full document.
#[derive(Debug, Deserialize)]
pub struct StatementInput {
    pub start_line: u32,
    pub sql:        String,
}

/// A table the editor knows about, used to flag references to unknown tables.
#[derive(Debug, Deserialize)]
pub struct SchemaTable {
    pub schema: String,
    pub name:   String,
}

/// Lowercased lookup sets for table-existence checks during validation. Built
/// from the live schema (`SchemaTable` list) and consulted by a language service's
/// batch validation. Internal — never crosses the IPC boundary.
#[derive(Default, Debug)]
pub struct SchemaIndex {
    /// "schema.table" — lowercased
    pub qualified: HashSet<String>,
    /// bare "table" across all schemas — lowercased
    pub bare: HashSet<String>,
}

impl SchemaIndex {
    pub fn from_tables(tables: &[SchemaTable]) -> Self {
        let mut idx = SchemaIndex::default();
        for t in tables {
            let s = t.schema.to_lowercase();
            let n = t.name.to_lowercase();
            idx.qualified.insert(format!("{s}.{n}"));
            idx.bare.insert(n);
        }
        idx
    }
}
