use serde::{Deserialize, Serialize};

/// Full connection record — internal only, never serialized to the frontend.
/// The `driver` field selects which `DatabaseDriver` handles this connection.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Connection {
    pub id:         String,
    pub name:       String,
    pub driver:     String,
    pub host:       String,
    pub port:       u16,
    pub database:   String,
    pub username:   String,
    pub password:   String,
    pub ssl_mode:   String,
    pub created_at: String,
}

/// Safe view sent to the frontend — no password field. Keeping these as two
/// distinct types is the compile-time guarantee that a password can never be
/// serialized across the IPC boundary (see disaster tests).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionView {
    pub id:         String,
    pub name:       String,
    pub driver:     String,
    pub host:       String,
    pub port:       u16,
    pub database:   String,
    pub username:   String,
    pub ssl_mode:   String,
    pub created_at: String,
}
