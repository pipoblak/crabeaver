# infrastructure/database/

Database drivers + dispatch.

## What's here

- `registry.rs` — `DriverRegistry`: holds one long-lived `Arc<dyn DatabaseDriver>`
  per engine and resolves it from a `Driver` or a driver string. Also
  `disconnect_all`/`is_connected_any` for engine-agnostic call sites.
- `postgres/` — `PostgresDriver`. All Postgres SQL (execute, schemas,
  list_databases, table_details, sessions, locks, cancel) lives here. Owns pools
  keyed by `(connection id, database)` and the in-flight backend pid that `cancel`
  targets (a query is pinned to one acquired connection so the pid always matches).
- `sqlite/` — `SqliteDriver`. Pragma-based introspection correlated with
  `sqlite_master` (so table names are never string-injected); runtime-storage-class
  value decoding; DDL pulled from `sqlite_master`. `sessions`/`locks`/`cancel` are
  capability-`false` and return `Unsupported`.
- `mod.rs` — `AppState`.

## Adding an engine

1. New module here implementing `DatabaseDriver`; honest `capabilities()`.
2. `registry.rs`: field + `new()` + `driver_for` arm + `all()`.
3. `tests/<engine>_driver.rs`.

`capabilities()` is a contract: a `false` flag MUST make that method return
`DriverError::Unsupported`. The disaster tests assert this.
