# MCP Server for Crabeaver — Design

**Date:** 2026-06-03
**Status:** Approved (pending spec review)

## Summary

Crabeaver becomes an **MCP server**. It exposes its configured database
connections — introspection and query execution — as MCP tools over a local HTTP
endpoint. External agents (Claude Code, Cursor, Claude Desktop, Cline, Windsurf,
VS Code, opencode, and any other MCP client) connect to it and run queries
against the user's connections.

A new **MCP panel in the sidebar** controls the server: turn it on/off, copy the
endpoint URL and auth token, one-click "Set up" into detected MCP clients, choose
which connections are exposed (and which allow writes), and watch a live activity
log.

Safety is the spine of the design: server **off by default**, bearer-token auth,
**opt-in exposure per connection**, **opt-in writes per connection**, and write
detection via SQL AST parsing (not regex). No tool ever concatenates agent text
into SQL except `run_query`, which passes through the gate.

## Goals

- Expose Crabeaver connections to external MCP clients over local HTTP.
- One-click setup into common MCP clients; copy fallback for the rest.
- Read + write, with writes opt-in per connection and strong injection safety.
- A sidebar panel to control everything and observe live activity.
- User-authored context so the agent understands what the server and each
  connection are: a global server prompt + a per-connection note.

## Non-Goals

- In-app AI chat / MCP **client** (Crabeaver consuming an LLM). This is server-only.
- Per-engine connector changes. MCP is an app-level delivery mechanism, not a new
  database engine. No `src/connectors/` or `DatabaseDriver` changes.
- Remote / network exposure. Bind is `127.0.0.1` only.

## Decisions (from brainstorming)

| Decision | Choice |
|---|---|
| MCP role | Crabeaver is the **server** |
| Transport | Local **HTTP** (streamable HTTP / SSE), `127.0.0.1:PORT` |
| Power scope | **Read + write**, writes opt-in per connection |
| Endpoint auth | **Bearer token**, shown in sidebar, rotatable |
| Connection exposure | **Opt-in per connection** (two toggles: expose, allow-write) |
| Boot default | Server **off** until user turns it on |
| Setup | One-click "Set up" per detected client + universal copy fallback |
| Context | **Global server prompt** (`initialize.instructions`) + **per-connection note** (in `list_connections`) |

## Architecture

MCP server is an **inbound adapter** — like the existing Tauri commands, but over
HTTP. It obeys the layering in `AGENTS.md`: the HTTP/protocol plumbing lives in
`infrastructure/`, the tool logic + safety gate live in `application/`, and they
reuse the existing use cases. No new SQL is authored outside the engine modules.

```
infrastructure/mcp/
  server.rs      axum server on 127.0.0.1:PORT; start/stop with shutdown signal;
                 holds Arc<AppState> to reach use cases
  auth.rs        middleware: require `Authorization: Bearer <token>` → 401 otherwise
  tools.rs       MCP tool schemas (JSON Schema) + dispatch into application::mcp
  clients/       client-target registry (setup writers) — see "Setup"
        │ calls
application/mcp.rs   tool implementations + SAFETY GATE
        │ reuses        (exposed? is-write? write-allowed?) then delegates
application/{query, introspection, connections}   EXISTING use cases (reused)
domain/
  mcp.rs         pure types: McpServerConfig (incl. global_prompt), McpConnFlags
                 (expose, allow_write, note), McpActivityEntry. No HTTP, no sqlx.
commands/mcp.rs  thin Tauri glue for the sidebar to drive the server
```

**MCP protocol library:** use the official Rust SDK [`rmcp`] with its streamable
HTTP / axum integration. It implements `initialize`, `tools/list`, `tools/call`,
and SSE; we only write tool handlers and the auth layer. **Fallback** if `rmcp`
does not integrate cleanly with our axum/Tauri runtime: hand-roll the JSON-RPC
endpoints over axum (initialize / tools.list / tools.call) — a bounded, known
surface.

**Server lifecycle:** the running server (task handle + shutdown channel) is held
in `AppState`. `mcp_start` spawns the axum server on a tokio task; `mcp_stop`
fires the shutdown signal. State is **off at boot** regardless of last session.

## Tools

Every tool takes a `connection_id` that must refer to an **exposed** connection;
otherwise the agent gets an "unknown connection" error (the connection is simply
invisible to it).

| Tool | Does | Reuses |
|---|---|---|
| `list_connections` | lists only exposed connections (id, name, engine, database, `write_allowed`, `context`) | connections use case |
| `list_databases` | databases on a connection | `list_databases` |
| `list_schemas` | schemas | `get_schemas` |
| `describe_table` | columns, types, indexes, foreign keys for a table | `get_table_details` |
| `run_query` | runs SQL, returns rows (+ row count) | `execute_query` |

Introspection tools take identifiers (schema/table) but **do not build SQL from
them** — they call the existing introspection use cases, which already quote
identifiers. Only `run_query` accepts raw SQL, and it passes through the gate.

`run_query` applies the same auto-`LIMIT` behavior the app uses (default 200,
overridable per call up to a cap), so an agent cannot accidentally pull an entire
table.

## Safety Gate

Lives in `application/mcp.rs`, runs before any driver call:

1. **Exposure check** — is the connection exposed? If not → "unknown connection".
2. **Write classification** (`run_query` only) — parse the SQL with **`sqlparser`**
   (already a dependency). Read = `SELECT` / `EXPLAIN` / `SHOW` / `WITH … SELECT`.
   Everything else (`INSERT`/`UPDATE`/`DELETE`/`MERGE`/DDL/etc.) = write. A
   multi-statement query is read only if **every** statement is read.
3. **Write authorization** — if write detected and the connection's `allow_write`
   flag is off → reject: "writes not enabled for this connection".
4. **Read** is always allowed on an exposed connection.

Classification is by AST, not regex, so comment tricks and string-literal payloads
(`'; DROP …`) do not fool it — the parser sees the real statement kind. Combined
with reusing parameterized introspection use cases, the only raw-SQL surface is
`run_query`, fully covered by the gate.

If `sqlparser` cannot parse a statement for a given dialect, treat it as a **write**
(fail closed) so unknown/unsupported syntax never slips through as read-only.

## Context / Instructions

User-authored context so the agent understands what it is looking at. Two levels,
both editable from **the sidebar panel and the general Settings**:

- **Global server prompt** — free text. Sent verbatim as the MCP
  `initialize.instructions` field, so every client reads it before any tool call.
  Use it for cross-cutting context: what these databases are, schema conventions,
  house rules ("prefer read; confirm before destructive writes").
- **Per-connection note** — short free text per connection. Included as a
  `context` field on that connection's entry in `list_connections` (and surfaced
  in `describe_table` output for that connection). Use it for per-database
  specifics ("billing prod — do not mutate without confirming", "sandbox — safe to
  reset").

Both are optional. Empty global prompt → `instructions` omitted; empty note →
`context` omitted. Neither ever contains a password; they are user prose stored
with settings (global) and connection settings (per-connection).

The global prompt and per-connection notes are edited in two places that share the
same underlying values:

- **Sidebar MCP panel** — inline editors (global prompt at top; note beside each
  exposed connection's toggles).
- **Settings → MCP section** — a dedicated section to edit the global prompt and
  every connection's note in one form, plus server defaults (port).

## Endpoint Security

- Bind `127.0.0.1` only — no LAN/remote reachability.
- **Bearer token** generated on first server start, persisted, shown in the
  sidebar with copy + rotate. Every request requires
  `Authorization: Bearer <token>`; missing/wrong → `401`. Rotating invalidates old
  clients until they are re-set-up.
- Token format: `cbv_` + random (e.g. 32 bytes base62). Stored alongside MCP
  settings (not in the keychain — it is a local-loopback capability token, not a
  DB credential).

## Setup (Client Registry)

`infrastructure/mcp/clients/` — an extensible registry of client targets, mirroring
the plug-in philosophy of the connector registry. Adding a new client = one
descriptor.

Each target provides:

- `detect()` → is this client installed? (`which <cli>` or known config path exists)
- `install(url, token)` → **merge** an entry into the client's config, never
  overwriting existing servers / other config.
- A **generic JSON writer** handles the common `mcpServers` shape used by most
  clients (Cursor, Claude Desktop, Cline, Windsurf, VS Code, opencode). HTTP entry
  shape: `{ "type": "http", "url": "<url>", "headers": { "Authorization": "Bearer <token>" } }`.
- **Claude Code** is special: shell out `claude mcp add --transport http crabeaver
  <url> --header "Authorization: Bearer <token>"`.
- **Legacy stdio-only clients**: install an `mcp-remote` bridge command instead of a
  direct HTTP entry.
- **Copy fallback** (command or JSON snippet) is always available, even for
  undetected clients.

Known config locations (per OS, resolved in Rust):

| Client | Mechanism |
|---|---|
| Claude Code | `claude mcp add` CLI |
| Cursor | `~/.cursor/mcp.json` |
| Claude Desktop | `claude_desktop_config.json` (per-OS app-support path) |
| Cline | VS Code extension MCP settings file |
| Windsurf | `~/.codeium/windsurf/mcp_config.json` |
| VS Code | `.vscode/mcp.json` / user settings |
| opencode | opencode config (`~/.config/opencode/…`) |

Honesty rule: if a detected client cannot do HTTP transport, the target either
writes the `mcp-remote` bridge or downgrades to copy-only with a one-line note —
never silently writes a config the client will reject.

## Frontend — Sidebar MCP Panel

New icon in `ActivityBar` (server icon) opens an MCP panel in the sidebar
(`McpPanel.tsx`), following the existing panel pattern.

```
● MCP Server                 [On/Off]
  http://127.0.0.1:7300/mcp        [copy]
  token  cbv_8f3a…            [copy] [rotate]

Server prompt                       [edit]
  "DBs da empresa X. Prefira read…"

Setup
  ✓ Claude Code              [installed]
    Cursor                   [Set up] [copy]
    Claude Desktop           [Set up] [copy]
    …detected clients…

Connections
  [x] expose  [ ] write   local-dev   note: "sandbox"   [edit]
  [ ] expose  [ ] write   pg-prod     note: "billing"   [edit]

Activity (live)
  12:04  run_query   local-dev   84 rows
  12:03  describe_table  users
```

- Server on/off; port configurable; token copy/rotate; URL copy.
- **Global server prompt** inline editor at the top.
- Per-connection `expose` / `allow_write` toggles **and a context note**, persisted
  with connection settings.
- Setup list: detected clients with Set up / Installed / copy.
- Live activity log: a ring buffer of the last N tool calls, pushed to the frontend
  via a Tauri event, shown newest-first.

### Settings → MCP section

A dedicated section in the general Settings (`src/components/settings/`), peer to
the existing Connections/Themes sections, editing the **same** values as the
sidebar:

- Global server prompt (larger editor).
- Per-connection notes (all connections in one list).
- Server default port.

Both surfaces read/write through the same commands, so an edit in one reflects in
the other.

## Commands (Tauri glue — thin)

`commands/mcp.rs`, each ~1–3 lines delegating to `application`:

- `mcp_status` → `{ running, port, url, token, has_token, global_prompt }`
- `mcp_start` / `mcp_stop`
- `mcp_rotate_token`
- `mcp_set_port`
- `mcp_set_connection_flags(connection_id, expose, allow_write)`
- `mcp_set_global_prompt(text)` / read via `mcp_status`
- `mcp_set_connection_note(connection_id, note)`
- `mcp_list_clients` → detected client targets + install state
- `mcp_setup_client(client_id)` → run install
- `mcp_recent_activity` → recent log entries (also streamed via event)

## Persistence

- MCP settings (port, token, **global server prompt**, last-set flags) stored with
  the existing settings store; **`running` is not persisted** (off at boot).
- Per-connection `mcp_expose` / `mcp_allow_write` / **`mcp_note`** stored with
  connection settings (SQLite), following the existing connection-settings pattern.
  Passwords remain untouched and are never exposed to MCP.

## Error Handling

- Auth failure → `401`.
- Unexposed connection → tool error "unknown connection" (no leak that it exists).
- Write on a non-write connection → tool error "writes not enabled for this
  connection".
- Driver/query errors → surfaced to the agent as the tool error text (same mapping
  as `execute_query`).
- Unparseable SQL → treated as write (fail closed).
- Port already in use on start → command returns a clear error to the sidebar.

## Testing

- **Gate unit tests** (`application/mcp.rs`): read vs write classification across
  dialects (SELECT, WITH…SELECT, INSERT, UPDATE, DELETE, DDL, multi-statement
  mixes, comment/quote tricks); exposure enforcement; write-authorization
  enforcement; unparseable → write.
- **Auth tests**: missing/wrong token → 401; correct token → 200.
- **Tool integration tests**: against the in-memory SQLite driver — list/describe/
  run_query happy paths and rejection paths.
- **Disaster test** (`tests/disaster.rs`): assert an **unexposed** connection and a
  **non-write** connection cannot be mutated through MCP; assert passwords never
  appear in any MCP response.
- **Client install tests**: generic JSON writer merges without clobbering existing
  servers; Claude Code path builds the correct CLI invocation.

## Open Items (resolve during planning)

- Exact `rmcp` version/features and whether its axum server can share Tauri's tokio
  runtime cleanly; if not, fall back to hand-rolled JSON-RPC.
- Default port (proposed `7300`) and collision handling.
- Final list of v1 client targets vs. copy-only (start with Claude Code + the
  generic `mcpServers` writers; add the rest behind the same registry).

[`rmcp`]: https://github.com/modelcontextprotocol/rust-sdk
