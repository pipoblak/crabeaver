# domain/

The pure core: the vocabulary every other layer speaks. **No I/O, no `tauri`, no
engine crates** (no `sqlx::postgres`/`sqlx::sqlite` types). If a change here needs
an engine crate, it belongs in `infrastructure/` instead.

## What's here

- `capabilities.rs` — `Driver` (engine enum + `parse`/`as_str`/`sql_dialect`/
  `requires_password`), `SqlDialect`, `QueryLanguage`, and `Capabilities` (what a
  connector supports). The single place engine identity is modeled.
- `error.rs` — `DriverError`, whose variants carry *intent* (`Unsupported`,
  `Connection`, `Query`, `NotFound`, `Auth`, `Config`) while `Display` returns the
  message verbatim. `From<DriverError> for String` flattens it at the command edge.
- `models/` — engine-agnostic data: `connection` (`Connection` with password /
  `ConnectionView` without — the IPC-safe type), `query`, `schema`, `session`,
  `table_details`, `language` (diagnostics, completions, schema index).
- `ports/` — the traits infrastructure implements: `database_driver::DatabaseDriver`
  and `language_service::LanguageService`.

## Rules

- Adding a field to a serialized model? Mind the wire contract — several types are
  snake_case (`Diagnostic`, `Completion`) because the frontend reads those names;
  others are `camelCase`. Don't add `rename_all` blindly.
- Never give a frontend-bound type a password (see `ConnectionView`).
- New engine ⇒ add a `Driver` variant here and cover every `match` on it.
