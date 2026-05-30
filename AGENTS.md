# Working in Crabeaver — rules for agents

Crabeaver is a multi-engine database IDE. The whole point of its architecture is
that **a database engine is a plug-in**: adding Postgres, MySQL, DynamoDB, … is
implementing a trait and registering it — not editing call sites across the app.
Read this before changing anything, and keep it true.

If anything here conflicts with a folder-level `README.md`, the folder wins (it is
more specific). If you change an architectural rule, update this file.

## The one big idea: connectors are decoupled

Every database engine is reached through two ports:

- `DatabaseDriver` (`domain/ports/database_driver.rs`) — connect, execute,
  introspect, sessions/locks, cancel. One implementation per engine in
  `infrastructure/database/<engine>/`.
- `LanguageService` (`domain/ports/language_service.rs`) — validation (linting)
  and completion (intellisense). SQL engines share one dialect-parameterized
  implementation; a non-SQL engine would add its own.

Each connector declares `Capabilities` (`domain/capabilities.rs`). **The frontend
renders only what a connector declares**, so a connector never offers UI for an
operation its driver would reject. The frontend mirror lives in `src/connectors/`.

Dispatch is by the `driver` string on a connection: `Driver::parse` → registry →
`Arc<dyn DatabaseDriver>`. Nothing else branches on engine type.

## Layering (enforced by review — keep it clean)

```
commands/      Tauri glue. NO SQL, NO engine logic. Maps args → use case → String.
   │ calls
application/   Use cases: biometric gate, keychain, pick driver, orchestrate.
   │ uses           NO Tauri types. NO target-engine SQL.
domain/        Pure types + ports (traits). NO sqlx driver types, NO tauri,
   ▲ implemented by  NO engine crates. The vocabulary everything else speaks.
infrastructure/  Adapters. The ONLY place sqlx::postgres / sqlx::sqlite / future
                 AWS SDK / keychain / biometric / OS calls may appear.
```

Hard rules:
- `domain/` must compile without any engine crate. If you `use sqlx::postgres::…`
  in domain, you did it wrong.
- A `#[tauri::command]` body is ~1–3 lines: deserialize, call an `application`
  function, `.map_err(Into::into)`. No SQL strings in `commands/`.
- An engine's SQL lives in its `infrastructure/database/<engine>/` module, nowhere
  else.

## How to add a database connector

Worked example: adding MySQL (it is already modeled as `Driver::MySql` but returns
`Unsupported`; a new engine adds the variant too).

**Backend**
1. `domain/capabilities.rs`: ensure there is a `Driver` variant; cover it in
   `parse`, `as_str`, `sql_dialect`, `requires_password`. Add a `SqlDialect`
   variant if it is a new dialect.
2. `infrastructure/database/<engine>/mod.rs`: implement `DatabaseDriver`. Set
   `capabilities()` **honestly** — every `false` flag MUST make the matching
   method return `DriverError::Unsupported` (never panic, never silently no-op).
   Quote/parameterize all identifiers and values (see the injection rules below).
3. `infrastructure/database/registry.rs`: add a field, construct it in `new()`,
   add the `driver_for` arm, and add it to `all()`.
4. Language: if it is a SQL dialect, add the `parser_dialect` arm in
   `infrastructure/language/sql/validation.rs`. If it is non-SQL, implement a new
   `LanguageService` and add a `service_for` arm in `infrastructure/language/mod.rs`.
5. Tests: add `tests/<engine>_driver.rs` (use a temp/in-memory instance if the
   engine allows it; otherwise gate live-server tests behind `#[ignore]` and say
   so). Add any new safety-critical path to `tests/disaster.rs`.

**Frontend**
6. `src/connectors/<engine>.ts`: a `ConnectorDescriptor` mirroring the backend
   `Capabilities` exactly (verify against the `connector_capabilities` command).
7. `src/connectors/registry.ts`: add it to `CONNECTORS` and `BY_DRIVER`.
8. If the engine needs different connection fields, extend the form in
   `src/components/settings/ConnectionsSection.tsx` (it already branches on
   `connectionKind`).

You should not need to touch `commands/`, `application/`, `EditorTabs`, or
`SqlEditor` to add a connector. If you do, the abstraction has a leak — fix the
leak instead of threading a special case.

## Security rules (the disaster tests enforce these)

- **Passwords never reach the frontend.** Return `ConnectionView`, never
  `Connection`. Do not add a password-bearing field to any serialized type.
- **No identifier interpolation.** Bind values as parameters. For identifiers that
  cannot be parameters (some `PRAGMA`/`COUNT(*) FROM <ident>`), quote with the
  engine's escaping (see `quote_ident` in the SQLite driver). A table named
  `"; DROP …` must become an inert quoted identifier.
- **Hostile input must not panic.** Garbage driver strings, unsupported
  capabilities, NULL/blob/huge values, megabyte/deeply-nested SQL — all return a
  typed error or a bounded result. Add a `tests/disaster.rs` case for any new path.

## Tests are required

Every behavior change ships with a test. `cargo test`, `npm test`, and
`npm run build` (the real type check — see note below) must pass;
`cargo clippy --all-targets -- -D warnings` must be clean. CI
(`.github/workflows/ci.yml`) runs all of this.

> Type-check gotcha: the root `tsconfig.json` is a solution file (`files: []`), so
> `tsc --noEmit` checks **nothing**. The real frontend type check is
> `npm run build` (`tsc -b` follows the project references, then vite bundles).

- Rust unit tests live next to the code (`#[cfg(test)] mod tests`).
- Cross-cutting / engine integration tests live in `src-tauri/tests/`.
- Frontend tests are `*.test.ts(x)` next to the code (vitest).

## Style

- This codebase uses **deliberate manual column alignment** in Rust (aligned
  struct fields, `let` bindings). **Do not run `cargo fmt`** — it would collapse
  it. Match the surrounding alignment when you add code. (CI does not gate on
  rustfmt for this reason.)
- Match the file you are editing: comment density, naming, idiom.

## Dev commands

```bash
npm run tauri dev          # dev server + hot reload + watch Rust
npm run build              # frontend type check (tsc -b) + bundle  ← real check
npm run lint               # eslint
npm test                   # vitest
cd src-tauri && cargo test # Rust tests
cd src-tauri && cargo clippy --all-targets -- -D warnings
```
