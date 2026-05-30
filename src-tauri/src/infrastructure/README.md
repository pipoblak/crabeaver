# infrastructure/

Adapters to the outside world. **This is the only layer allowed to import engine
crates** (`sqlx::postgres`, `sqlx::sqlite`, a future AWS SDK), the OS keychain, and
the biometric helper. Everything here implements a `domain` port or is a
self-contained OS adapter.

## What's here

- `database/` — `DatabaseDriver` implementations (one per engine) + the
  `DriverRegistry` that dispatches by `Driver`. See `database/README.md`.
- `language/` — `LanguageService` implementations (dialect-parameterized SQL).
  See `language/README.md`.
- `keychain/` — password storage (macOS `security` CLI; `keyring` elsewhere).
  Engine-agnostic, keyed by connection id. Passwords never touch the app's SQLite
  store and never reach the frontend.
- `biometric/` — Touch ID gate (compiles + caches a tiny Swift helper on macOS;
  no-op elsewhere).
- `database/mod.rs` — `AppState`: the SQLite settings pool, the `DriverRegistry`,
  the biometric cache/lock, and the schema-index store. Engine query state
  (pools, in-flight query ids) lives *inside the drivers*, not here.

## Rules

- Implement a `domain` port; don't invent parallel APIs.
- A driver owns its pools and any per-query state (e.g. the pid used by `cancel`).
- Quote/parameterize all identifiers and values (see the SQLite driver's
  `quote_ident` and the disaster tests).
