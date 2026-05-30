# infrastructure/language/

Language services: linting (validation) and intellisense (completion), decoupled
per query language so each engine lints with its own rules.

## What's here

- `sql/` — `SqlLanguageService`, parameterized by `SqlDialect`. `validation.rs`
  parses with the engine's sqlparser dialect (Postgres/MySQL/SQLite/Generic);
  `completion.rs` detects the clause under the cursor and returns keywords/
  functions/snippets. The dialect genuinely changes behavior (e.g. MySQL accepts
  backtick identifiers, Postgres doesn't — there's a test for exactly that).
- `mod.rs` — `service_for(driver)`: the pluggable factory. Returns `None` for an
  engine whose query language has no service yet (a future non-SQL engine).

## Extending

- New SQL dialect: add a `parser_dialect` arm in `sql/validation.rs`. Completion
  content is shared today; tailor it per dialect inside `completion.rs` if needed.
- Non-SQL engine (e.g. PartiQL/DynamoDB): add a sibling module implementing
  `LanguageService` and a `service_for` arm. The frontend gates the editor on
  `QueryLanguage`, so it won't call a SQL service for a non-SQL engine.

Services are pure and stateless — safe to construct on demand and to run across
rayon workers. The schema index they consult lives in `AppState`, primed by
`set_schema_index`.
