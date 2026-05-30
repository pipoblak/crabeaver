# Crabeaver — Developer Notes

## Stack

- **Frontend**: React + TypeScript + Vite, Monaco Editor, TanStack Table, Tailwind
- **Backend**: Rust (Tauri v2), sqlx (SQLite + Postgres), security-framework (macOS keychain)
- **IPC**: Tauri `invoke()` — frontend calls Rust commands

## Dev Commands

```bash
npm run tauri dev      # start dev server + hot-reload frontend + watch Rust
cargo build            # Rust-only build check (from src-tauri/)
npx tsc --noEmit       # TypeScript type check
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

### Passwords / Keychain

- macOS: `security-framework` legacy API (`SecKeychainAddGenericPassword`) — no per-app ACL, survives rebuilds
- Other platforms: `keyring` crate (Windows Credential Manager, libsecret)
- Passwords are **never** returned to the frontend — `ConnectionView` struct omits the field
- SQLite stores everything except passwords

### SQL Completion

Context detection in `src-tauri/src/commands/sql_completion.rs`:
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
| `src-tauri/src/commands/connections.rs` | DB connection CRUD + keychain |
| `src-tauri/src/commands/sql_completion.rs` | SQL autocomplete context detection |
| `src-tauri/src/infrastructure/database/postgres.rs` | Postgres pool manager + query execution |
| `src/components/EditorTabs.tsx` | Main editor layout, run/results orchestration |
| `src/components/ResultsPane.tsx` | Results table (TanStack Table), pagination |
| `src/components/SqlEditor.tsx` | Monaco wrapper, schema-aware completion |
| `src/context/TabsContext.tsx` | Tab state management + persistence |
