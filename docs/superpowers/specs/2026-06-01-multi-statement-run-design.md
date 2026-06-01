# Multi-Statement Run — Design

**Date:** 2026-06-01
**Status:** Approved

## Problem

Today **Run** (`⌘↵`, the toolbar button, and a non-empty selection) executes a single
statement: `SqlEditor.getStatementAtCursor()` returns the selected text or the statement
under the cursor, and `EditorTabs.runQuery` runs exactly one query. If a user selects
several `;`-separated statements and runs, only one query is sent (the whole blob),
which most engines reject. Users expect a multi-statement selection to run each
statement as its own query.

## Scope

In scope (decided):
- **Trigger:** ONLY a selection containing ≥2 statements splits and runs each. A
  selection with 0–1 statements, or no selection (cursor statement), runs exactly as
  today — unchanged.
- **Results:** one result tab per statement (`Result N`).
- **Execution:** all statements run **in parallel**; no statement blocks another.
- **Errors:** keep going — each result tab independently shows its data or its error.

Out of scope:
- Whole-file "run all" (cursor/no-selection behavior is untouched).
- Transaction wrapping of the batch (each statement is an independent query).
- Sequential / dependent-DDL execution modes.
- Deepening `cancel_query` semantics (it stays connection-scoped, as today).

## Architecture

### 1. `src/lib/splitSql.ts` — statement splitter (new, pure)

```ts
export function splitSqlStatements(sql: string): string[]
```

Splits on top-level `;`, ignoring `;` that appears inside:
- single-quoted strings `'...'` (with `''` escape handling),
- double-quoted identifiers `"..."`,
- line comments `-- ... \n`,
- block comments `/* ... */`.

Returns each segment trimmed, with empty/whitespace-only segments dropped. A trailing
`;` does not produce a trailing empty statement. A single statement returns `[oneStmt]`.

Pure and synchronous (selection text is small — no worker needed). Unit-tested.

### 2. `SqlEditor` — `getRunTargets()`

Add to `SqlEditorRef`:

```ts
getRunTargets(): Promise<string[]>
```

- If the editor has a non-empty selection → return `splitSqlStatements(selectionText)`.
- Otherwise → return `[<statement at cursor>]` using the existing cursor-statement
  logic already in `getStatementAtCursor` (selection-less path).
- Returns `[]` when there's nothing runnable.

`getStatementAtCursor` stays for any other caller; `getRunTargets` is the new entry
point `runQuery` uses.

### 3. `EditorTabs` — orchestrate

Extract the current per-query body of `runQuery` into:

```ts
executeInResultTab(editorTab, resultTabId, rawSql): Promise<void>
```

This holds what `runQuery` does today for one query: mark the result tab `running`,
register the elapsed start, run via `trackedQuery` (so each statement appears in the
activity monitor), and on settle write `data`/`error` and call `endTask`.

`runQuery(inNewResultTab)` becomes:

1. `targets = await sqlEditorRef.current?.getRunTargets()`, filtered to non-empty.
2. `0` → return.
3. `1` → today's behavior: `ensureResultTab({ forceNew: inNewResultTab })` then
   `executeInResultTab(tab, resultTabId, targets[0])`.
4. `≥2` → for each statement create a **new** result tab
   (`ensureResultTab({ forceNew: true })`) and call `executeInResultTab` for each
   **without awaiting in series** — launch them all so they run in parallel. Focus the
   last statement's result tab.

Each `executeInResultTab` applies `applyLimit` to its statement (already SELECT/WITH-only)
exactly as the single path does today.

### 4. Elapsed timer — support N concurrent

Today `runQuery` uses a single `elapsedTimer` interval bound to one `resultTabId`. With
parallel runs there are multiple running tabs. Refactor to a **ref-counted** single
interval:

- A `runningCount` ref tracks how many result tabs are currently running.
- `executeInResultTab` stores its tab's `startMs` in the `elapsed` map, increments
  `runningCount`, and starts the interval if it isn't already running.
- The interval ticks every 50 ms by re-emitting the `elapsed` map (forces a re-render so
  `Date.now() - startMs` readouts update for every running tab).
- On settle, `executeInResultTab` decrements `runningCount`; when it reaches 0 the
  interval is cleared.

`startMs` values are per-tab and constant; the interval only drives re-render.

## Data Flow (≥2 statements)

```
selection → getRunTargets() → [s1, s2, s3]
  for each sᵢ:  new result tab Rᵢ  →  executeInResultTab(tab, Rᵢ, sᵢ)
                                         applyLimit(sᵢ) → trackedQuery → Rᵢ.data | Rᵢ.error
  (all launched together → parallel; focus R₃)
```

## Error Handling

- Per result tab. A statement that throws sets only its own tab's `error`; siblings are
  unaffected (keep-going).
- A reused `executeInResultTab` keeps the existing success/error `setResultMap` branches,
  so each path still clears `running` and calls `endTask` (no leaked task, no stuck
  spinner).

## Testing

`src/lib/splitSql.test.ts` (vitest):
- `select 1; select 2` → 2 statements.
- trailing `;` (`select 1;`) → 1 statement, no empty tail.
- `;` inside a string literal (`select ';'` , `select 'a;b'`) → 1 statement.
- `;` inside double-quoted identifier (`select "a;b"`) → 1 statement.
- `;` inside a line comment (`select 1 -- ;\n ; select 2`) → 2 statements.
- `;` inside a block comment (`select 1 /* ; */ ; select 2`) → 2 statements.
- whitespace-only / empty segments dropped (`; ; select 1;`) → 1 statement.
- single statement, no `;` → `[oneStmt]`.
- empty / whitespace input → `[]`.

## Files

New:
- `src/lib/splitSql.ts`
- `src/lib/splitSql.test.ts`

Changed:
- `src/components/SqlEditor.tsx` — add `getRunTargets` to `SqlEditorRef` + impl.
- `src/components/EditorTabs.tsx` — extract `executeInResultTab`; rewrite `runQuery`
  orchestration; ref-counted elapsed interval.
