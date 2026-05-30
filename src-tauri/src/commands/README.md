# commands/

Tauri `#[tauri::command]` adapters — the IPC surface the frontend calls via
`invoke`. **Thin glue only: no SQL, no engine logic.** Each command deserializes
its args, calls one `application` use case, and flattens `DriverError` to the
`String` the IPC boundary expects (`.map_err(Into::into)`).

## What's here

- `connections.rs` — connection CRUD, lifecycle, query execute/cancel, and
  Postgres-style sessions/locks/databases (all delegate to `application`).
- `table_details.rs` — table inspector.
- `connectors.rs` — `connector_capabilities(driver)`: lets the frontend verify the
  capability flags it mirrors in `src/connectors/`.
- `sql_validation.rs` / `sql_completion.rs` — linting + intellisense; take an
  optional `dialect` (the connection's driver string).
- `biometric.rs` — Touch ID command wrappers + opt-in.
- `queries.rs` (query files on disk), `settings.rs`, `marketplace.rs` (themes) —
  connector-agnostic features.

## Rules

- Register new commands in `lib.rs`'s `invoke_handler!`.
- Command arg names are snake_case in Rust; the frontend sends camelCase and Tauri
  converts (`connectionId` → `connection_id`).
- If you're writing SQL or `match`ing on engine here, stop — that belongs in
  `infrastructure`/`application`.
