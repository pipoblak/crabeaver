# Architecture — Hexagonal (Ports & Adapters)

## Overview

db_ide follows hexagonal architecture. The domain is the center — it has zero knowledge of UI or databases. Everything external plugs in through ports (traits).

```
┌─────────────────────────────────────────────────────┐
│                        UI                           │
│              (egui panels & components)             │
└──────────────────────┬──────────────────────────────┘
                       │ calls
┌──────────────────────▼──────────────────────────────┐
│                  Application                        │
│              (commands / use cases)                 │
└──────────┬───────────────────────────┬──────────────┘
           │ reads models              │ calls ports
┌──────────▼──────────┐   ┌───────────▼──────────────┐
│       Domain        │   │      Infrastructure       │
│  models  │  ports   │   │   (implements ports)      │
│  (pure)  │ (traits) │   │   DB drivers, FS, etc.    │
└──────────────────────┘   └──────────────────────────┘
```

## Dependency Rule

> Inner layers never import outer layers.

| Layer          | May import        | May NOT import              |
|----------------|-------------------|-----------------------------|
| `domain`       | nothing external  | `application`, `ui`, `infra`|
| `application`  | `domain`          | `ui`, `infrastructure`      |
| `infrastructure` | `domain`        | `application`, `ui`         |
| `ui`           | `application`, `domain::models` | `infrastructure` |

## Layers

### `domain/`
Pure Rust. No async runtimes, no DB crates, no egui. Contains:
- **`models/`** — entities: `Connection`, `Query`, `QueryResult`, `Schema`, `Table`, `Column`
- **`ports/`** — traits the application needs fulfilled: `DatabasePort`, `SchemaPort`

### `application/`
Orchestrates domain logic. Holds use cases as plain structs or functions. Depends only on `domain`.
- **`commands/`** — `ConnectCommand`, `RunQueryCommand`, `FetchSchemaCommand`

### `infrastructure/`
Implements domain ports using real external crates (sqlx, tokio, etc.).
- **`database/`** — one file per DB engine: `postgres.rs`, `mysql.rs`, `sqlite.rs`

### `ui/`
egui/eframe only. Reads domain models for display; triggers application commands on user action.
- **`panels/`** — full-screen regions: `SidebarPanel`, `EditorPanel`, `ResultsPanel`
- **`components/`** — small reusable widgets: `ConnectionBadge`, `QueryTab`, `DataTable`

## Adding a new database engine

1. Add crate to `Cargo.toml`
2. Create `src/infrastructure/database/engine_name.rs`
3. Implement `DatabasePort` and `SchemaPort` from `domain::ports`
4. Wire into `App` state in `app.rs`

No changes needed in `domain`, `application`, or `ui`.
