//! Use-case layer. Orchestrates domain ports + infrastructure (drivers, keychain,
//! biometric) for each command. Contains no Tauri types and no engine-specific SQL —
//! that lives in `infrastructure/`. Commands are thin adapters over these functions.

pub mod connections;
pub mod introspection;
pub mod language;
pub mod mcp;
pub mod query;
