use serde::{Deserialize, Serialize};

/// Per-connection MCP exposure flags.
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq)]
pub struct McpConnFlags {
    pub expose: bool,
    pub allow_write: bool,
}

/// Classification of a `run_query` request.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SqlKind {
    Read,
    Write,
}

/// Server status reported to the sidebar.
#[derive(Debug, Clone, Serialize)]
pub struct McpStatus {
    pub running: bool,
    pub port: u16,
    pub url: String,
    pub has_token: bool,
    /// Whether the server auto-starts on app launch (opt-in, persisted).
    pub autostart: bool,
}

/// One entry in the live activity log (ring buffer).
#[derive(Debug, Clone, Serialize)]
pub struct McpActivityEntry {
    /// Epoch millis (stamped by the caller).
    pub at: i64,
    pub tool: String,
    pub connection: String,
    pub summary: String,
}
