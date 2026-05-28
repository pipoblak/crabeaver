# Project Structure

```
db_ide/
├── Cargo.toml
├── docs/
│   ├── architecture.md     # Hexagonal architecture overview
│   └── structure.md        # This file
└── src/
    ├── main.rs             # Entry point — wires eframe, declares modules
    ├── app.rs              # App struct + eframe::App impl + top-level state
    │
    ├── ui/                 # Presentation layer (egui adapters)
    │   ├── mod.rs
    │   ├── panels/         # Full-region panels rendered by app.rs
    │   │   └── mod.rs
    │   └── components/     # Reusable widgets used inside panels
    │       └── mod.rs
    │
    ├── application/        # Use cases — coordinates domain + infra
    │   ├── mod.rs
    │   └── commands/       # One struct/fn per user action
    │       └── mod.rs
    │
    ├── domain/             # Core logic — pure, no external deps
    │   ├── mod.rs
    │   ├── models/         # Entities and value objects
    │   │   └── mod.rs
    │   └── ports/          # Traits (interfaces) for infra adapters
    │       └── mod.rs
    │
    └── infrastructure/     # Driven adapters — implements domain ports
        ├── mod.rs
        └── database/       # DB engine implementations
            └── mod.rs
```

## Naming conventions

| Kind            | Convention          | Example                    |
|-----------------|---------------------|----------------------------|
| Panels          | `<Name>Panel`       | `EditorPanel`, `SidebarPanel` |
| Components      | noun or noun+role   | `DataTable`, `ConnectionBadge` |
| Commands        | `<Action>Command`   | `RunQueryCommand`          |
| Domain models   | plain noun          | `Query`, `Connection`      |
| Ports (traits)  | `<Role>Port`        | `DatabasePort`             |
| Infra adapters  | `<Engine><Role>`    | `PostgresDatabase`         |
