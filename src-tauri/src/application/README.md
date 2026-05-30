# application/

Use cases — the orchestration between `commands` (Tauri glue) and the
`domain` ports / `infrastructure` adapters. **No `tauri` types here, and no
target-engine SQL.** Functions take `&AppState` and plain args.

## What's here

- `connections.rs` — connection CRUD against the local store; the biometric +
  keychain gate that turns a stored row into a usable `Connection`
  (`load_connection`); test/connect/disconnect. Engine dispatch via
  `state.drivers`.
- `query.rs` — execute / cancel: load the connection, pick its driver, delegate.
- `introspection.rs` — schemas / list_databases / table_details / sessions /
  locks, all via the driver (which returns `Unsupported` for anything its
  capabilities deny).
- `language.rs` — route validate/complete to the dialect service by driver string
  (defaulting to Postgres when absent), and own the schema-index store access.

## Rules

- This is where "pick the driver for this connection" happens (`driver_for_str`),
  and the only place the biometric gate runs. Keep it engine-agnostic: branch on
  `Capabilities`/`Driver` helpers, never on hardcoded engine assumptions.
- A `command` should be a thin wrapper over one function here.
