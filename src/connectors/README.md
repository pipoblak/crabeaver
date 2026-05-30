# src/connectors/

The frontend mirror of the backend connector model. The UI reads these descriptors
to **render only the features a connector supports** — Sessions/Locks tabs, the
connection-form shape, the editor's SQL dialect.

## What's here

- `types.ts` — `Capabilities`, `ConnectorDescriptor`, `DriverId`. Mirror of
  `domain/capabilities.rs`.
- `postgres.ts`, `sqlite.ts` — one descriptor per engine. Each must match its
  `DatabaseDriver::capabilities()` in src-tauri (verify with the
  `connector_capabilities` command).
- `registry.ts` — `CONNECTORS` (selectable engines), `descriptorFor(driver)` and
  `capabilitiesFor(driver)`. Both fall back to Postgres for unknown/missing
  drivers, preserving single-engine behavior.

## Who uses it

- `components/Sidebar.tsx` — gates the Tools (Sessions/Locks) section and shows a
  file path vs `host:port`.
- `components/SqlEditor.tsx` + `hooks/useSqlValidation.ts` — pass the connection's
  driver as the `dialect` so lint/completion use the right SQL rules.
- `components/settings/ConnectionsSection.tsx` — driver picker + `connectionKind`
  (`server` host/port/user/pass vs `file` path).

## Adding a connector (frontend half)

1. New `<engine>.ts` descriptor mirroring the backend capabilities exactly.
2. Add it to `CONNECTORS` and `BY_DRIVER` in `registry.ts`.
3. Extend `ConnectionsSection` only if it needs new connection fields.

Keep the capability flags honest — if the backend driver returns `Unsupported`
for an op, the descriptor must mark it `false`, or the UI will offer a button that
errors.
