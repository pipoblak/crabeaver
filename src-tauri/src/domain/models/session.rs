use serde::{Deserialize, Serialize};

/// A server-side connection/session. Modeled on Postgres `pg_stat_activity`;
/// engines without a session view (e.g. SQLite) report `Capabilities.sessions = false`
/// and never produce these.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Session {
    pub pid:              i32,
    pub usename:          Option<String>,
    pub datname:          Option<String>,
    pub application_name: Option<String>,
    pub state:            Option<String>,
    pub wait_event:       Option<String>,
    pub query_start:      Option<String>,
    pub query:            Option<String>,
    pub client_addr:      Option<String>,
    pub client_port:      Option<i32>,
    pub backend_type:     Option<String>,
}

/// A lock held or awaited by a session. Modeled on Postgres `pg_locks`; gated by
/// `Capabilities.locks`.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Lock {
    pub pid:              i32,
    pub locktype:         Option<String>,
    pub relation:         Option<String>,
    pub mode:             Option<String>,
    pub granted:          Option<bool>,
    pub usename:          Option<String>,
    pub datname:          Option<String>,
    pub application_name: Option<String>,
    pub state:            Option<String>,
    pub query:            Option<String>,
    pub query_start:      Option<String>,
    pub blocking_pids:    Option<String>,
}
