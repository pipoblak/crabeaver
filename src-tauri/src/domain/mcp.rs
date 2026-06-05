use serde::{Deserialize, Serialize};

/// Per-connection MCP exposure flags + user note.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct McpConnFlags {
    pub expose: bool,
    pub allow_write: bool,
    /// Free-text context shown to the agent in `list_connections` / `describe_table`.
    #[serde(default)]
    pub note: String,
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
    /// Free-text context sent to every client as `initialize.instructions`.
    pub global_prompt: String,
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
