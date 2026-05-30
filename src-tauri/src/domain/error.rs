use std::fmt;

/// Engine-agnostic error returned by every `DatabaseDriver`.
///
/// The variant carries intent (so callers and tests can match on *why* a call
/// failed — e.g. `Unsupported` vs `Connection`), while `Display` returns the
/// inner message verbatim so user-facing strings are preserved exactly as the
/// adapter produced them.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DriverError {
    /// The engine does not support this capability (e.g. SQLite has no sessions).
    /// Should never reach the user when the frontend respects `Capabilities`.
    Unsupported(String),
    /// Could not connect / pool acquisition failed / ping failed.
    Connection(String),
    /// Query failed to parse, plan, or execute on the server.
    Query(String),
    /// A referenced entity (connection, table, …) does not exist.
    NotFound(String),
    /// Authentication / keychain / biometric failure.
    Auth(String),
    /// Malformed configuration (bad driver string, missing field, …).
    Config(String),
}

impl DriverError {
    /// True when the failure is "this engine can't do that", used by the UI and
    /// disaster tests to assert capability gating works.
    pub fn is_unsupported(&self) -> bool {
        matches!(self, DriverError::Unsupported(_))
    }
}

impl fmt::Display for DriverError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            DriverError::Unsupported(m)
            | DriverError::Connection(m)
            | DriverError::Query(m)
            | DriverError::NotFound(m)
            | DriverError::Auth(m)
            | DriverError::Config(m) => write!(f, "{m}"),
        }
    }
}

impl std::error::Error for DriverError {}

/// Tauri commands return `Result<T, String>`; this lets `?`/`.into()` flatten a
/// `DriverError` into that string boundary without losing the message.
impl From<DriverError> for String {
    fn from(e: DriverError) -> String {
        e.to_string()
    }
}
