# Crabeaver — Developer Notes

## Stack

- **Frontend**: React + TypeScript + Vite, Monaco Editor, TanStack Table, Tailwind
- **Backend**: Rust (Tauri v2), sqlx (SQLite + Postgres), security-framework (macOS keychain)
- **IPC**: Tauri `invoke()` — frontend calls Rust commands

## Dev Commands

```bash
npm run tauri dev      # start dev server + hot-reload frontend + watch Rust
cargo build            # Rust-only build check (from src-tauri/)
npm run build          # TS type check (tsc -b) + bundle — `tsc --noEmit` is a no-op here
cargo test             # run Rust unit tests (from src-tauri/)
```

## Debugging

### Frontend (browser DevTools)

DevTools open **automatically** on every `tauri dev` launch (debug builds only).

To toggle manually: press **F12** (dev builds only — no-op in release).

Use `console.log`, React DevTools, network tab etc. as normal.

### Backend (Rust)

Structured logging via `tracing`. Default level in dev: `debug`.

```bash
# Verbose output
RUST_LOG=debug npm run tauri dev

# Filter to specific module
RUST_LOG=crabeaver::commands::connections=trace npm run tauri dev

# Common levels: error | warn | info | debug | trace
```

Add log lines in Rust with:

```rust
tracing::info!("message {}", value);
tracing::debug!("connection pool hit for {id}");
tracing::warn!("slow query: {}ms", ms);
tracing::error!("failed: {e}");
```

Logs print to the terminal running `tauri dev`. Not visible in DevTools.

### Both at once — unified terminal stream

`src/debug.ts` is injected automatically in dev mode (`main.tsx`). It:
- Patches `console.log/warn/error/debug` → forwards to Rust `tracing` via `log_from_frontend`
- Wraps `invoke()` → logs every IPC call and its result/error
- Catches unhandled promise rejections and uncaught errors

Result: one terminal shows both Rust and frontend logs in order:

```
INFO frontend: → invoke(list_connections)
INFO frontend: ← invoke(list_connections) ok
DEBUG crabeaver::commands::connections: loaded 3 connections
```

DevTools still available via **F12** (dev only) — not auto-opened.

## Architecture

> **Adding/maintaining a database engine? Read [`AGENTS.md`](./AGENTS.md) first.**
> It has the layering rules and the "how to add a connector" checklist. Each
> backend layer and `src/connectors/` also has a folder-level `README.md`.

### Connectors (engine decoupling)

A database engine is a plug-in, reached through two ports:

- `DatabaseDriver` (`src-tauri/src/domain/ports/database_driver.rs`) — connect,
  execute, introspect, sessions/locks, cancel. One impl per engine in
  `infrastructure/database/<engine>/`. Postgres and SQLite ship today.
- `LanguageService` (`.../ports/language_service.rs`) — validation + completion,
  dialect-parameterized so each engine lints with its own rules.

Dispatch is by the connection's `driver` string: `Driver::parse` → `DriverRegistry`
→ `Arc<dyn DatabaseDriver>`. Each connector declares `Capabilities`
(`domain/capabilities.rs`); the frontend (`src/connectors/`) mirrors them and
renders only supported features. Layers: `commands` (thin Tauri glue) → `application`
(use cases) → `domain` (pure ports/types) ← `infrastructure` (engine adapters; the
only place `sqlx` driver types live).

### Passwords / Keychain

- Adapter in `src-tauri/src/infrastructure/keychain/` (engine-agnostic, keyed by connection id)
- macOS: `security` CLI (legacy `SecKeychainAddGenericPassword` semantics) — no per-app ACL, survives rebuilds
- Other platforms: `keyring` crate (Windows Credential Manager, libsecret)
- Passwords are **never** returned to the frontend — `ConnectionView` struct omits the field (a disaster test pins this)
- SQLite stores everything except passwords

### SQL Completion

Context detection in `src-tauri/src/infrastructure/language/sql/completion.rs`
(dialect-parameterized; called via `application::language`):
- `detect_context()` strips string literals, then paren content (depth > 0), then finds last clause keyword
- Returns `CompletionResult { items, suggestTables, suggestColumns }` — frontend uses flags to inject schema items
- Schema items scope to current statement (text after last `;`)

### Query Results / Pagination

- `LIMIT N` auto-appended to SELECT/WITH queries (default 200, per-tab configurable)
- Pagination via `LIMIT N OFFSET M` — triggered by scroll-to-bottom in result table
- Results cached in `localStorage` per tab file path, max 2MB

### Tab State

Tabs are files on disk (`get_queries_dir()`). Connection, database, query limit, and result cache are stored separately (settings + localStorage).

## Key Files

| File | Purpose |
|---|---|
| `src-tauri/src/domain/ports/database_driver.rs` | The `DatabaseDriver` trait every engine implements |
| `src-tauri/src/domain/capabilities.rs` | `Driver`, `SqlDialect`, `Capabilities` |
| `src-tauri/src/infrastructure/database/registry.rs` | Dispatch by driver string |
| `src-tauri/src/infrastructure/database/postgres/` · `sqlite/` | Engine drivers (all engine SQL lives here) |
| `src-tauri/src/infrastructure/language/sql/` | Dialect-parameterized validation + completion |
| `src-tauri/src/application/` | Use cases (connections, query, introspection, language) |
| `src-tauri/src/commands/` | Thin Tauri command adapters (no SQL) |
| `src/connectors/` | Frontend connector descriptors (mirror of backend capabilities) |
| `src/components/EditorTabs.tsx` | Main editor layout, run/results orchestration |
| `src/components/SqlEditor.tsx` | Monaco wrapper, schema-aware completion (dialect-routed) |
| `src/context/TabsContext.tsx` | Tab state management + persistence |
