CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS themes (
    name TEXT PRIMARY KEY,
    data TEXT NOT NULL  -- full Theme JSON blob
);

CREATE TABLE IF NOT EXISTS connections (
    id            TEXT PRIMARY KEY,
    name          TEXT NOT NULL,
    driver        TEXT NOT NULL,
    host          TEXT,
    port          INTEGER,
    database_name TEXT,
    username      TEXT,
    created_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS query_history (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    query          TEXT NOT NULL,
    connection_id  TEXT,
    executed_at    TEXT NOT NULL,
    duration_ms    INTEGER,
    success        INTEGER NOT NULL DEFAULT 1
);
