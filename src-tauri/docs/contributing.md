# Contributing

## Where does my code go?

| What you're adding            | Where                                    |
|-------------------------------|------------------------------------------|
| New UI panel                  | `src/ui/panels/<name>.rs`               |
| New reusable widget           | `src/ui/components/<name>.rs`           |
| New user action / use case    | `src/application/commands/<name>.rs`    |
| New entity or value object    | `src/domain/models/<name>.rs`           |
| New external interface trait  | `src/domain/ports/<name>.rs`            |
| New DB engine support         | `src/infrastructure/database/<engine>.rs`|

## Rules

1. **Domain stays pure.** No crate imports in `domain/` except `std`.
2. **UI never touches infra.** `ui` imports `application` and `domain::models` only.
3. **One concern per file.** Split early rather than grow large files.
4. **Ports before adapters.** Define the trait in `domain::ports` before implementing it in `infrastructure`.

## Running

```sh
cargo run          # dev build
cargo build --release  # release build
cargo check        # fast type check without compiling
```
