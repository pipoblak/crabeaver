# Connector Decoupling — Design Spec

**Date:** 2026-05-29
**Status:** Approved
**Branch:** `worktree-connector-decoupling`

## Problem

Crabeaver is hardwired to a single database engine (Postgres) and a single query
language (SQL). The codebase *looks* decoupled — there is a `domain/ports/database_port.rs`
with a `DatabasePort` trait and an `infrastructure/database/` adapter folder — but the
seams are **decorative**:

- `DatabasePort` is dead code: never implemented, never called.
- `PostgresPoolManager` exposes inherent associated functions (`test`, `execute`,
  `schemas`) that commands call **directly**.
- `AppState.pg_pools: PostgresPoolManager` is a concrete Postgres field.
- `Connection.driver` is stored in SQLite but **nothing dispatches on it**.
- `commands/connections.rs` and `commands/table_details.rs` embed raw Postgres
  catalog SQL (`pg_stat_activity`, `pg_locks`, `pg_class`, `pg_backend_pid()`…).
- `sql_validation.rs` / `sql_completion.rs` hardcode `GenericDialect` and a
  Postgres-flavored keyword/function set.
- The frontend `SqlEditor` is hardwired to Monaco `language="sql"` with an inline
  Postgres keyword set.

Goal: make adding a connector (mysql, dynamo, …) a matter of **implementing a trait
and registering it** — with the UI adapting to capabilities each connector declares.
Postgres behavior must stay identical. SQLite is added as a second, genuinely
different, **CI-testable** engine to prove the seams are load-bearing.

## Decisions (locked)

1. **Second connector: SQLite.** Real feature (open `.db` files), needs no external
   server, already bundled by sqlx → every integration and disaster test runs in CI.
   MySQL/Dynamo become "implement the trait + register" with reference docs.
2. **Capability-driven abstraction.** Each connector declares `Capabilities`
   (query language, schemas, sessions, locks, table-details, cancel, transactions).
   The frontend renders only what the active connection supports. NoSQL engines
   (Dynamo/PartiQL) are a documented, unimplemented seam — modeled, not built.
3. **Fix + test + document.** Real bugs / unsafe code found during the refactor are
   fixed, each covered by a regression/disaster test, and noted in the PR.

## Backend architecture (Rust) — real hexagonal

```
domain/                  pure: no engine crates, no Tauri, no sqlx driver types
  models/                Connection, ConnectionView, QueryResult, ColumnInfo,
                         SchemaInfo, TableInfo, TableDetails, Session, Lock,
                         Diagnostic, Completion/CompletionResult
  capabilities.rs        Driver(enum), QueryLanguage(enum), Capabilities
  ports/
    database_driver.rs   trait DatabaseDriver  (async): capabilities, test, connect,
                           disconnect, is_connected, execute, schemas, list_databases,
                           table_details, sessions, locks, cancel
    language_service.rs  trait LanguageService: validate, complete
  error.rs               DriverError { Unsupported, Connection, Query, NotFound, … }

infrastructure/          adapters: the ONLY place engine crates are imported
  database/
    registry.rs          DriverRegistry: Driver -> Arc<dyn DatabaseDriver>
    postgres/            PostgresDriver impl DatabaseDriver (pool mgr, decode,
                           introspection, sessions, locks, table_details)
    sqlite/              SqliteDriver impl DatabaseDriver (sqlite_master/pragma;
                           sessions/locks -> Unsupported)
  language/
    registry.rs          LanguageRegistry: QueryLanguage -> Arc<dyn LanguageService>
    sql/                 SqlLanguageService(dialect): validate + complete; dialect
                           selects sqlparser dialect + keyword/function set
  keychain/              password storage (moved out of commands/connections.rs)
  biometric/             Touch ID helper (moved out of commands/)

application/             use cases: orchestration, testable without Tauri
  connections.rs         CRUD, connect/disconnect, biometric gate, pid tracking
  query.rs               execute + cancel via registry.driver_for(conn.driver)
  introspection.rs       schemas, list_databases, table_details
  language.rs            validate/complete via LanguageRegistry

commands/                thin #[tauri::command] adapters — NO SQL, NO engine logic
```

**Dispatch:** `Driver::from_str(&conn.driver)?` → `registry.driver_for(driver)` →
`Arc<dyn DatabaseDriver>`. Operations an engine lacks return
`DriverError::Unsupported`, gated by `capabilities()` so the UI never calls them.

**Layering rules (enforced by docs + review):**
- `domain/` imports no `sqlx` driver type, no `tauri`, no engine crate.
- `infrastructure/` is the only place `sqlx::postgres`, `sqlx::sqlite`, AWS SDK, etc. appear.
- `commands/` contains no SQL and no engine branching — only arg-mapping + a use-case call.

## Frontend architecture (TS) — capability-driven

```
src/connectors/
  types.ts               ConnectorDescriptor, Capabilities (mirror of backend)
  registry.ts            driver -> descriptor; helpers (capabilitiesFor, descriptorFor)
  postgres.ts            descriptor: label, defaultPort 5432, monacoLanguage 'sql',
                           caps {schemas, sessions, locks, tableDetails}, languageClient
  sqlite.ts              descriptor: file-path connection, monacoLanguage 'sql',
                           caps {schemas:true, sessions:false, locks:false, tableDetails:true}
src/language/
  client.ts              validate(driver, …) / complete(driver, …) → routes to backend
```

- `SqlEditor` becomes descriptor-driven: Monaco language id, completion + validation
  providers come from the descriptor's `languageClient`. Keyword sets leave the component.
- Session / Lock / TableDetails tabs and their sidebar actions render only when
  `capabilitiesFor(driver).<cap>` is true.

Postgres renders exactly as today; the gating is a no-op for it.

## Testing strategy

**Rust unit (no DB):** language services per dialect; Driver/QueryLanguage parsing;
registry dispatch; capability flags; keychain (where mockable); error mapping; decode helpers.

**Rust integration (`src-tauri/tests/`):** SQLite end-to-end against temp `.db` —
execute (SELECT + DML), schemas, table_details, list_databases; cancel → Unsupported;
registry returns the right driver per `driver` string.

**Disaster tests — "things that must never happen":**
- Password never crosses to the frontend (`ConnectionView` serialized → assert no `password`).
- Identifier injection: schema/table names containing `"`, `;`, `DROP` are quoted /
  parameterized, never interpolated into a query string.
- Unknown / empty / garbage `driver` string → typed error, no panic.
- Unsupported capability invoked (sessions on SQLite) → `Unsupported`, no panic.
- Connect timeout / pool exhaustion → error, not hang/panic.
- Decode of huge / NULL-heavy / many-column / binary rows → no panic, no truncation surprise.
- Megabyte SQL and deeply nested parens → bounded (recursion limit), no stack overflow.
- Concurrent biometric gate → a single prompt (lock + cache logic).
- Query-pid map cleared after error (no leak).
- localStorage quota exceeded (frontend) → graceful, no throw.
- Statement splitter on pathological input (no `;`, comment-only, megabyte single line).

**Frontend (vitest):** capability gating; language-client dialect routing; tabs reducer
(existing); worker splitter edge cases; schema-cache TTL/quota.

## Tooling & agent rules

- **eslint flat config** (`eslint.config.js`) — fixes the currently-broken `npm run lint`.
- `cargo clippy -D warnings` and `cargo fmt --check` gates.
- **CI** `.github/workflows/ci.yml`: rustfmt · clippy · cargo test · tsc · eslint · vitest.
- **`AGENTS.md`** (root): layering rules, "how to add a connector" checklist, test bar.
- **Per-folder `README.md`** in each backend layer and key frontend folder.
- Root `CLAUDE.md` updated to point at the new architecture.

## Sequencing — every phase compiles and stays green

0. Baseline + CI + eslint + docs skeleton
1. Domain models + `DatabaseDriver`/`LanguageService` ports + capabilities
2. `PostgresDriver` behind the trait + registry + `AppState` swap; thin commands — behavior identical
3. `SqlLanguageService` (dialect param); route validate/complete through registry
4. `SqliteDriver` + register + integration tests
5. Frontend descriptors + capability gating + `QueryEditor`
6. Disaster suite; fix bugs found (each with a test)
7. Per-folder docs + `AGENTS.md` + final full green pass

## Non-goals

- Implementing MySQL or DynamoDB drivers (only seams + reference docs).
- A NoSQL query editor UI (PartiQL) — modeled in capabilities, not built.
- Changing the visual design / theming system.
