import Editor, { useMonaco } from '@monaco-editor/react'
import { useCallback, useEffect, useImperativeHandle, useRef, useState, forwardRef } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { useTheme } from '@/context/ThemeContext'
import { useConnections } from '@/context/ConnectionContext'
import { useSqlValidation } from '@/hooks/useSqlValidation'
import EditorGutter from '@/components/EditorGutter'
import type * as monaco_t from 'monaco-editor'

interface SqlCompletion {
  label: string
  kind: string
  insert_text: string
  detail: string
  documentation?: string
}

interface CompletionResult {
  items:          SqlCompletion[]
  suggestTables:  boolean
  suggestColumns: boolean
}

interface SchemaInfo  { schema: string; tables: TableInfo[] }
interface TableInfo   { name: string; columns: ColumnInfo[] }
interface ColumnInfo  { name: string; typeName: string; isFk?: boolean; fkRef?: string; fkCol?: string }

interface SchemaCache {
  schemas: string[]
  tables:  Array<{ schema: string; name: string }>
  columns: Record<string, Array<{ name: string; type: string; isFk: boolean; fkRef?: string; fkCol?: string }>>
  qualifiedColumns: Record<string, Array<{ name: string; type: string; isFk: boolean; fkRef?: string; fkCol?: string }>>
  fetchedAt: number
}

// Module-level in-memory cache (survives tab switches within a session)
const schemaCache = new Map<string, SchemaCache>()
// Tracks which schema-index version (by fetchedAt) is already primed in Rust,
// so tab switches / cache hits don't re-send the whole table list over IPC.
const primedVersions = new Map<string, number>()
const CACHE_TTL_MS  = 5  * 60 * 1000   // 5 min before background refresh
const LS_TTL_MS     = 30 * 60 * 1000   // 30 min before localStorage is stale

function lsKey(connectionId: string, database?: string) {
  return `cb:schema:${connectionId}:${database ?? ''}`
}

function loadFromStorage(connectionId: string, database?: string): SchemaCache | null {
  try {
    const raw = localStorage.getItem(lsKey(connectionId, database))
    if (!raw) return null
    const entry: SchemaCache = JSON.parse(raw)
    if (Date.now() - entry.fetchedAt > LS_TTL_MS) { localStorage.removeItem(lsKey(connectionId, database)); return null }
    return entry
  } catch { return null }
}

function saveToStorage(connectionId: string, database: string | undefined, entry: SchemaCache) {
  try { localStorage.setItem(lsKey(connectionId, database), JSON.stringify(entry)) } catch { /* quota */ }
}

async function fetchSchema(connectionId: string, database?: string): Promise<SchemaCache> {
  const schemaInfos = await invoke<SchemaInfo[]>('get_schemas', { connectionId, database: database ?? null })
  const schemas: string[] = []
  const tables: SchemaCache['tables'] = []
  const columns: SchemaCache['columns'] = {}
  const qualifiedColumns: SchemaCache['qualifiedColumns'] = {}
  for (const s of schemaInfos) {
    schemas.push(s.schema)
    for (const t of s.tables) {
      tables.push({ schema: s.schema, name: t.name })
      const cols = t.columns.map(c => ({ name: c.name, type: c.typeName, isFk: c.isFk ?? false, fkRef: c.fkRef, fkCol: c.fkCol }))
      columns[t.name] = cols
      qualifiedColumns[`${s.schema}.${t.name}`] = cols
    }
  }
  const entry: SchemaCache = { schemas, tables, columns, qualifiedColumns, fetchedAt: Date.now() }
  const key = `${connectionId}:${database ?? ''}`
  schemaCache.set(key, entry)
  saveToStorage(connectionId, database, entry)
  return entry
}

export interface SqlEditorRef {
  /** Returns the text of the statement under the cursor, or selected text if any. */
  getStatementAtCursor(): Promise<string | null>
}

interface Props {
  value: string
  onChange: (value: string) => void
  connectionId?: string
  database?: string
  onSchemaStatus?: (status: { tables: number; error?: string; fkColumns?: Set<string>; fkRefs?: Map<string, { table: string; col: string }> } | null) => void
  onRunQuery?: (sql: string, newTab: boolean) => void
}

function isDark(hex: string): boolean {
  const h = hex.replace('#', '')
  if (h.length < 6) return true
  const r = parseInt(h.slice(0, 2), 16)
  const g = parseInt(h.slice(2, 4), 16)
  const b = parseInt(h.slice(4, 6), 16)
  return (0.299 * r + 0.587 * g + 0.114 * b) < 140
}

const SqlEditor = forwardRef<SqlEditorRef, Props>(function SqlEditor(
  { value, onChange, connectionId, database, onSchemaStatus, onRunQuery }, ref) {
  const monaco = useMonaco()
  const { theme } = useTheme()
  const { markConnected } = useConnections()
  const dark = isDark(theme.bg)
  const [editorReady, setEditorReady] = useState(false)
  const [editorInstance, setEditorInstance] = useState<monaco_t.editor.IStandaloneCodeEditor | null>(null)
  const editorRef = useRef<monaco_t.editor.IStandaloneCodeEditor | null>(null)
  const isFirstLoad = useRef(true)
  // Non-null only once the Rust schema index for this key is primed — used both
  // as the lookup key sent to validate_sql_batch and as the re-validate trigger.
  const [primedKey, setPrimedKey] = useState<string | null>(null)
  const { validate, resetCache } = useSqlValidation(monaco, editorRef, editorReady, primedKey)
  const schemaCacheRef    = useRef<SchemaCache | null>(null)

  const monacoThemeName  = `crabeaver-${theme.name.replace(/[^a-z0-9]/gi, '-').toLowerCase()}`
  const onRunQueryRef    = useRef(onRunQuery)
  useEffect(() => { onRunQueryRef.current = onRunQuery }, [onRunQuery])

  // ── Run query keyboard shortcuts ─────────────────────────────────────────
  // Registered after Monaco is ready so `monaco` is non-null.
  // CtrlCmd = Cmd on macOS, Ctrl on Windows/Linux — cross-platform by design.
  useEffect(() => {
    if (!monaco || !editorReady) return
    const editor = editorRef.current
    if (!editor) return

    const runCurrent = (newTab: boolean) => {
      const cb = onRunQueryRef.current
      if (!cb) return
      const model = editor.getModel()
      if (!model) return
      const sel  = editor.getSelection()
      const selectedText = sel && !sel.isEmpty() ? model.getValueInRange(sel) : null
      if (selectedText?.trim()) { cb(selectedText.trim(), newTab); return }
      // Run statement containing cursor
      const pos    = editor.getPosition()
      const offset = pos ? model.getOffsetAt(pos) : 0
      const sql    = model.getValue()
      const before = sql.slice(0, offset)
      const after  = sql.slice(offset)
      const semiBack    = before.lastIndexOf(';')
      const semiForward = after.indexOf(';')
      const stmt = sql.slice(
        semiBack >= 0 ? semiBack + 1 : 0,
        semiForward >= 0 ? offset + semiForward + 1 : sql.length,
      ).trim()
      if (stmt) cb(stmt, newTab)
    }

    // addCommand returns a string ID, not a disposable — commands live with the editor instance
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter,       () => runCurrent(false))
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.Enter, () => runCurrent(true))
  }, [monaco, editorReady])

  // ── Schema fetch: stale-while-revalidate ──────────────────────────────────
  useEffect(() => {
    if (!connectionId) {
      schemaCacheRef.current = null
      setPrimedKey(null)
      onSchemaStatus?.(null)
      return
    }

    const cacheKey = `${connectionId}:${database ?? ''}`
    setPrimedKey(null) // clear stale key until the new index is primed

    const apply = (fresh: SchemaCache) => {
      schemaCacheRef.current = fresh
      const fkColumns = new Set<string>()
      const fkRefs    = new Map<string, { table: string; col: string }>()
      for (const t of fresh.tables) {
        for (const c of fresh.qualifiedColumns[`${t.schema}.${t.name}`] ?? []) {
          if (c.isFk && c.fkRef) {
            fkColumns.add(c.name)
            if (!fkRefs.has(c.name)) {  // first occurrence wins
              fkRefs.set(c.name, { table: c.fkRef, col: c.fkCol ?? 'id' })
            }
          }
        }
      }
      onSchemaStatus?.({ tables: fresh.tables.length, fkColumns, fkRefs })
      // Prime the Rust schema index only when this version isn't already primed —
      // avoids re-sending the full table list on tab switches / cache hits.
      if (primedVersions.get(cacheKey) === fresh.fetchedAt) {
        setPrimedKey(cacheKey)
      } else {
        invoke('set_schema_index', {
          key: cacheKey,
          tables: fresh.tables.map(t => ({ schema: t.schema, name: t.name })),
        })
          .then(() => { primedVersions.set(cacheKey, fresh.fetchedAt); setPrimedKey(cacheKey) })
          .catch(e => console.error('[set_schema_index]', e))
      }
      if (connectionId) markConnected(connectionId)
    }
    const fail = (e: unknown) => {
      console.error('[schema fetch]', e)
      onSchemaStatus?.({ tables: 0, error: String(e) })
    }

    const cached = schemaCache.get(cacheKey) ?? loadFromStorage(connectionId, database)
    if (cached) {
      schemaCache.set(cacheKey, cached) // warm in-memory cache too
      apply(cached)
      if (Date.now() - cached.fetchedAt > CACHE_TTL_MS) {
        fetchSchema(connectionId, database).then(apply).catch(fail)
      }
      return
    }

    onSchemaStatus?.(null)
    schemaCache.delete(cacheKey)
    fetchSchema(connectionId, database).then(apply).catch(e => {
      schemaCacheRef.current = null
      fail(e)
    })
  }, [connectionId, database])

  // Schema-aware table validation now runs in Rust (validate_sql_batch, AST walk).
  // The index is primed via set_schema_index in the schema-fetch effect above;
  // warnings arrive under the 'sql-validation' marker owner.

  // ── Theme ─────────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!monaco) return
    monaco.editor.defineTheme(monacoThemeName, {
      base: dark ? 'vs-dark' : 'vs',
      inherit: true,
      rules: (theme.tokenRules ?? []).map(r => ({
        token: r.token,
        foreground: r.foreground,
        fontStyle: r.fontStyle,
      })),
      colors: {
        'editor.background':                          theme.bg,
        'editor.foreground':                          theme.text,
        'editorLineNumber.foreground':                theme.textDim,
        'editorLineNumber.activeForeground':          theme.text,
        'editor.selectionBackground':                 dark ? '#264f78' : '#add6ff',
        'editor.lineHighlightBackground':             theme.hover,
        'editorCursor.foreground':                    theme.text,
        'editor.inactiveSelectionBackground':         theme.hover,
        'editorSuggestWidget.background':             theme.sidebarBg,
        'editorSuggestWidget.border':                 theme.border,
        'editorSuggestWidget.foreground':             theme.text,
        'editorSuggestWidget.selectedBackground':     dark ? '#1a3a5c' : '#0060c0',
        'editorSuggestWidget.selectedForeground':     '#ffffff',
        'editorSuggestWidget.highlightForeground':    theme.tabAccent,
        'editorWidget.background':                    theme.sidebarBg,
        'editorWidget.border':                        theme.border,
        'input.background':                           theme.bg,
        'input.foreground':                           theme.text,
        'input.border':                               theme.border,
        'focusBorder':                                theme.tabAccent,
        'scrollbar.shadow':                           '#00000000',
        'scrollbarSlider.background':                 dark ? '#42424280' : '#64646480',
        'scrollbarSlider.hoverBackground':            dark ? '#5a5a5a80' : '#87878780',
      },
    })
    monaco.editor.setTheme(monacoThemeName)
  }, [monaco, monacoThemeName, theme, dark])

  // ── Autocomplete provider ─────────────────────────────────────────────────
  useEffect(() => {
    if (!monaco) return

    const kindMap: Record<string, number> = {
      keyword:    monaco.languages.CompletionItemKind.Keyword,
      structural: monaco.languages.CompletionItemKind.Keyword,
      function:   monaco.languages.CompletionItemKind.Function,
      snippet:    monaco.languages.CompletionItemKind.Snippet,
    }

    const disposable = monaco.languages.registerCompletionItemProvider('sql', {
      triggerCharacters: [' ', '.', '('],

      provideCompletionItems: async (model, position) => {
        const word   = model.getWordUntilPosition(position)
        const offset = model.getOffsetAt(position)
        const sql    = model.getValue()
        const range  = {
          startLineNumber: position.lineNumber,
          endLineNumber:   position.lineNumber,
          startColumn:     word.startColumn,
          endColumn:       word.endColumn,
        }

        // Get keyword/function/snippet completions + schema flags from Rust
        const result = await invoke<CompletionResult>('get_sql_completions', {
          sql,
          cursorOffset: offset,
        }).catch(() => ({ items: [], suggestTables: false, suggestColumns: false } as CompletionResult))

        const suggestions: monaco_t.languages.CompletionItem[] = []

        // ── Schema completions — only where they make sense ────────────────
        const cache = schemaCacheRef.current
        if (cache) {
          // Scope everything to the current statement (text after last `;` before cursor).
          // This prevents previous statements' table refs and aliases from bleeding in.
          const fullUpToCursor = model.getValueInRange({
            startLineNumber: 1, startColumn: 1,
            endLineNumber: position.lineNumber, endColumn: position.column,
          })
          const stmtText = fullUpToCursor.slice(fullUpToCursor.lastIndexOf(';') + 1)

          // Paren-stripped current statement for depth-0 extraction
          const stmtDepth0 = (() => {
            let depth = 0, out = ''
            for (const ch of stmtText) {
              if (ch === '(') { depth++; out += ' ' }
              else if (ch === ')') { depth = Math.max(0, depth - 1); out += ' ' }
              else out += depth > 0 ? ' ' : ch
            }
            return out
          })()

          // Build alias map scoped to current statement
          const SQL_ALIAS_KW = new Set(['WHERE','ON','SET','GROUP','ORDER','HAVING','LIMIT',
            'INNER','LEFT','RIGHT','FULL','CROSS','NATURAL','JOIN','AS','LATERAL','USING',
            'SELECT','FROM','UPDATE','DELETE','INSERT','RETURNING','AND','OR','NOT'])
          const aliasMap = new Map<string, string>()
          const aliasRe = /\b(?:FROM|JOIN)\s+([a-zA-Z_]\w*(?:\.[a-zA-Z_]\w*)?)\s+(?:AS\s+)?([a-zA-Z_]\w*)\b/gi
          let ar: RegExpExecArray | null
          while ((ar = aliasRe.exec(stmtDepth0)) !== null) {
            const tableRef = ar[1], alias = ar[2]
            if (!SQL_ALIAS_KW.has(alias.toUpperCase())) {
              const dot = tableRef.indexOf('.')
              aliasMap.set(alias.toLowerCase(), (dot !== -1 ? tableRef.slice(dot + 1) : tableRef).toLowerCase())
            }
          }

          // Check for dot-completion (schema.table or alias.col or table.col)
          const lineUpToCursor = model.getValueInRange({
            startLineNumber: position.lineNumber, startColumn: 1,
            endLineNumber:   position.lineNumber, endColumn: position.column,
          })
          const dotMatch = lineUpToCursor.match(/(\w+)\.(\w*)$/)

          if (dotMatch) {
            const prefix   = dotMatch[1]
            const afterDot = dotMatch[2]
            const dotRange = { ...range, startColumn: position.column - afterDot.length }
            const pfxLow   = prefix.toLowerCase()

            const schemaMatch = cache.schemas.find(s => s.toLowerCase() === pfxLow)
            const tableMatch  = cache.tables.find(t =>
              t.name.toLowerCase() === pfxLow ||
              `${t.schema}.${t.name}`.toLowerCase() === pfxLow)
            const aliasTarget = aliasMap.get(pfxLow)
            const aliasTable  = aliasTarget
              ? cache.tables.find(t => t.name.toLowerCase() === aliasTarget)
              : undefined

            const serveColumns = (t: { schema: string; name: string }) => {
              const key = `${t.schema}.${t.name}`
              for (const col of cache.qualifiedColumns[key] ?? cache.columns[t.name] ?? []) {
                suggestions.push({
                  label: col.name, kind: monaco.languages.CompletionItemKind.Field,
                  insertText: col.name, detail: `${col.type} · ${key}`,
                  sortText: `2_${col.name}`, range: dotRange,
                })
              }
            }

            if (schemaMatch) {
              for (const t of cache.tables.filter(t => t.schema === schemaMatch)) {
                suggestions.push({
                  label: t.name, kind: monaco.languages.CompletionItemKind.Class,
                  insertText: t.name, detail: `table · ${schemaMatch}`,
                  sortText: `1_${t.name}`, range: dotRange,
                })
              }
            } else if (tableMatch) {
              serveColumns(tableMatch)
            } else if (aliasTable) {
              // ALIAS-1: alias.col → resolve to real table's columns
              serveColumns(aliasTable)
            }
            return { suggestions }
          }

          const stmtUpToCursor = stmtText

          // TABLE-1: include INTO/USING; LIMIT-1: skip numeric words
          const rightAfterTableKeyword =
            /\b(?:FROM|JOIN|UPDATE|TABLE|INTO|USING)\s+$/i.test(stmtUpToCursor) ||
            /,\s*$/.test(stmtUpToCursor)
          const wordIsNumeric = /^\d+$/.test(word.word)
          const wantTables = (!wordIsNumeric && word.word.length > 0) || rightAfterTableKeyword

          if (result.suggestTables && wantTables) {
            for (const s of cache.schemas) {
              suggestions.push({
                label: s, kind: monaco.languages.CompletionItemKind.Module,
                insertText: s, detail: 'schema', sortText: `0_${s}`, range,
              })
            }
            for (const t of cache.tables) {
              suggestions.push({
                label: t.name, kind: monaco.languages.CompletionItemKind.Class,
                insertText: t.name, detail: `table · ${t.schema}`,
                sortText: `1_${t.name}`, range,
              })
            }
          }

          // COLGATE-1: include AND/OR/NOT
          const rightAfterColKeyword =
            /\b(?:SELECT|WHERE|ON|HAVING|BY|SET|AND|OR|NOT)\s+$/i.test(stmtUpToCursor) ||
            /[,(]\s*$/.test(stmtUpToCursor)
          const wantColumns = (!wordIsNumeric && word.word.length > 0) || rightAfterColKeyword

          if (result.suggestColumns && wantColumns) {
            // REFRE-1/2: use depth-0 stripped SQL; guard SQL keyword captures
            const SKIP_KW = new Set(['SET','WHERE','RETURNING','DEFAULT','EXCLUDED','NOTHING','LATERAL','VALUES'])
            const refRe = /\b(?:FROM|JOIN|UPDATE)\s+([a-zA-Z_]\w*(?:\.[a-zA-Z_]\w*)?)/gi
            const referencedNames = new Set<string>()
            let rm: RegExpExecArray | null
            while ((rm = refRe.exec(stmtDepth0)) !== null) {
              const ref = rm[1]
              if (SKIP_KW.has(ref.toUpperCase())) continue
              const dot = ref.indexOf('.')
              referencedNames.add((dot !== -1 ? ref.slice(dot + 1) : ref).toLowerCase())
            }
            // Comma-separated: FROM t1, t2 (depth-0 only, stop at SQL keywords)
            const fromClauses = stmtDepth0.match(/\bFROM\s+(?:(?!\b(?:WHERE|JOIN|ON|GROUP|ORDER|HAVING|LIMIT|UNION|EXCEPT|INTERSECT)\b).)+/gi) ?? []
            const commaRe = /,\s*([a-zA-Z_]\w*(?:\.[a-zA-Z_]\w*)?)/g
            for (const clause of fromClauses) {
              let cm: RegExpExecArray | null
              while ((cm = commaRe.exec(clause)) !== null) {
                const ref = cm[1]
                if (SKIP_KW.has(ref.toUpperCase())) continue
                const dot = ref.indexOf('.')
                referencedNames.add((dot !== -1 ? ref.slice(dot + 1) : ref).toLowerCase())
              }
            }
            // Also expand aliases: if alias resolves to a table, include that table
            for (const [alias, target] of aliasMap) {
              if (referencedNames.has(alias)) referencedNames.add(target)
            }

            const colTables = referencedNames.size > 0
              ? cache.tables.filter(t => referencedNames.has(t.name.toLowerCase()))
              : cache.tables
            const seen = new Set<string>()
            for (const t of colTables) {
              const cols = cache.qualifiedColumns[`${t.schema}.${t.name}`]
                        ?? cache.columns[t.name] ?? []
              for (const col of cols) {
                if (seen.has(col.name)) continue
                seen.add(col.name)
                suggestions.push({
                  label: col.name, kind: monaco.languages.CompletionItemKind.Field,
                  insertText: col.name, detail: `${col.type} · ${t.schema}.${t.name}`,
                  sortText: `2_${col.name}`, range,
                })
              }
            }
          } // suggestColumns
        } // cache

        // ── Keyword / function / snippet completions ───────────────────────
        for (const c of result.items) {
          suggestions.push({
            label:      c.label,
            kind:       kindMap[c.kind] ?? monaco.languages.CompletionItemKind.Keyword,
            insertText: c.insert_text,
            insertTextRules: (c.kind === 'snippet' || c.insert_text.includes('${'))
              ? monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet
              : undefined,
            detail:        c.detail,
            documentation: c.documentation ? { value: c.documentation } : undefined,
            sortText:      c.kind === 'structural' ? `3_${c.label}` : `4_${c.label}`,
            range,
          })
        }

        return { suggestions }
      },
    })

    return () => disposable.dispose()
  }, [monaco])

  // ── Document highlight provider ───────────────────────────────────────────
  const SQL_KW = new Set([
    'SELECT','FROM','WHERE','JOIN','LEFT','RIGHT','INNER','OUTER','FULL','CROSS',
    'ON','GROUP','ORDER','BY','HAVING','LIMIT','OFFSET','INSERT','INTO','VALUES',
    'UPDATE','SET','DELETE','CREATE','DROP','ALTER','TRUNCATE','WITH','UNION',
    'ALL','DISTINCT','AS','AND','OR','NOT','IN','LIKE','ILIKE','IS','NULL',
    'BETWEEN','EXISTS','CASE','WHEN','THEN','ELSE','END','CAST','COALESCE',
    'ASC','DESC','PRIMARY','KEY','FOREIGN','REFERENCES','TABLE','INDEX','UNIQUE',
    'DEFAULT','CHECK','CONSTRAINT','RETURNING','TOP','LATERAL','MERGE','CALL',
    'EXPLAIN','INTERSECT','EXCEPT','OVER','PARTITION','NULLS','FIRST','LAST',
    'COUNT','SUM','AVG','MIN','MAX','ROW_NUMBER','RANK','DENSE_RANK','LAG','LEAD',
    'CURRENT_DATE','NOW','EXTRACT','DATE_TRUNC','UPPER','LOWER','TRIM','LENGTH',
    'CONCAT','SUBSTRING','REPLACE','ROUND','ABS','FLOOR','CEIL','RETURNING',
    'DO','NOTHING','CONFLICT','EXCLUDED','INTEGER','TEXT','BOOLEAN','TIMESTAMP',
    'DATE','FLOAT','DECIMAL','SERIAL','UUID','JSONB','JSON','VARCHAR','CHAR',
  ])

  useEffect(() => {
    if (!monaco) return
    const disposable = monaco.languages.registerDocumentHighlightProvider('sql', {
      provideDocumentHighlights: (model, position) => {
        const word = model.getWordAtPosition(position)
        if (!word || SQL_KW.has(word.word.toUpperCase())) return []
        const text    = model.getValue()
        const escaped = word.word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        const regex   = new RegExp(`\\b${escaped}\\b`, 'gi')
        const results: monaco_t.languages.DocumentHighlight[] = []
        let match
        while ((match = regex.exec(text)) !== null) {
          const start = model.getPositionAt(match.index)
          const end   = model.getPositionAt(match.index + match[0].length)
          results.push({
            range: new monaco.Range(start.lineNumber, start.column, end.lineNumber, end.column),
            kind:  monaco.languages.DocumentHighlightKind.Text,
          })
        }
        return results
      },
    })
    return () => disposable.dispose()
  }, [monaco])

  // ── Folding range provider ────────────────────────────────────────────────
  useEffect(() => {
    if (!monaco) return
    const disposable = monaco.languages.registerFoldingRangeProvider('sql', {
      provideFoldingRanges: async (model) => {
        const api = stmtWorkerRef.current
        if (!api) return []
        const lines = model.getValue().split('\n')
        const stmts = await api.splitStatements(lines)
        return stmts
          .filter(s => s.lineCount > 1)
          .map(s => ({
            start: s.start + 1,
            end:   s.start + s.lineCount,
            kind:  monaco.languages.FoldingRangeKind.Region,
          }))
      },
    })
    return () => disposable.dispose()
  }, [monaco])

  // ── Validation ────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!editorReady) return
    const isReset = isFirstLoad.current
    isFirstLoad.current = false
    if (isReset) {
      // Defer initial validation so the editor has time to render and getVisibleRanges works
      const raf = requestAnimationFrame(() => validate(value, true))
      return () => cancelAnimationFrame(raf)
    }
    validate(value, false)
  }, [value, editorReady, validate])

  // ── SQL worker (statement splitting) ─────────────────────────────────────
  const stmtWorkerRef = useRef<import('../workers/sqlWorker').SqlWorkerApi | null>(null)
  const stmtRawWorker = useRef<Worker | null>(null)
  useEffect(() => {
    let mounted = true
    import('comlink').then(({ wrap }) => {
      if (!mounted) return
      const w = new Worker(new URL('../workers/sqlWorker.ts', import.meta.url), { type: 'module' })
      stmtRawWorker.current = w
      stmtWorkerRef.current = wrap<import('../workers/sqlWorker').SqlWorkerApi>(w)
    })
    return () => {
      mounted = false
      stmtRawWorker.current?.terminate()
      stmtWorkerRef.current = null
    }
  }, [])

  // ── Expose imperative API ─────────────────────────────────────────────────
  useImperativeHandle(ref, () => ({
    async getStatementAtCursor() {
      const editor = editorRef.current
      if (!editor) return null

      // Return selected text if any
      const selection = editor.getSelection()
      if (selection && !selection.isEmpty()) {
        return editor.getModel()?.getValueInRange(selection) ?? null
      }

      // Find the statement at the cursor position
      const worker = stmtWorkerRef.current
      if (!worker) return editor.getValue() // fallback

      const lines    = editor.getValue().split('\n')
      const pos      = editor.getPosition()
      const cursorLine = pos ? pos.lineNumber : 1 // 1-indexed

      const stmts = await worker.splitStatements(lines)
      // stmts use 0-indexed start; find the one that contains cursorLine (1-indexed)
      const stmt = stmts.find(s =>
        s.start + 1 <= cursorLine && cursorLine <= s.start + s.lineCount
      )
      return stmt?.text.trim() ?? null
    },
  }), [])

  // ── Suggest override CSS ──────────────────────────────────────────────────
  useEffect(() => {
    const id = 'crabeaver-suggest-override'
    let el = document.getElementById(id)
    if (!el) {
      el = document.createElement('style')
      el.id = id
      document.head.appendChild(el)
    }
    el.textContent = `
      .suggest-widget .monaco-list-row.focused .suggest-label .highlight,
      .suggest-widget .monaco-list-row.selected .suggest-label .highlight,
      .suggest-widget .monaco-list-row.focused .suggest-label span[style],
      .suggest-widget .monaco-list-row.selected .suggest-label span[style] {
        color: inherit !important;
        font-weight: bold !important;
        text-decoration: underline !important;
      }
      .sql-occurrence {
        background: rgba(128,128,128,0.2) !important;
        border-radius: 2px;
      }
      .sql-error-line {
        background: rgba(255, 80, 80, 0.08) !important;
        border-left: 2px solid rgba(255, 80, 80, 0.6) !important;
      }
      .sql-warning-line {
        background: rgba(255, 200, 80, 0.07) !important;
        border-left: 2px solid rgba(255, 200, 80, 0.5) !important;
      }
    `
    return () => { el?.remove() }
  }, [])

  return (
    <div className="absolute inset-0 flex" style={{ userSelect: 'text' }}>
      {editorInstance && monaco && (
        <EditorGutter
          editor={editorInstance}
          monaco={monaco}
          workerApi={stmtWorkerRef.current}
          value={value}
        />
      )}
      <div style={{ flex: 1, position: 'relative', height: '100%', overflow: 'hidden' }}>
        <Editor
          language="sql"
          theme={monacoThemeName}
          value={value}
          onChange={v => onChange(v ?? '')}
          onMount={editor => {
            editorRef.current = editor
            setEditorInstance(editor)
            resetCache()
            isFirstLoad.current = true
            setEditorReady(true)
            requestAnimationFrame(() => editor.layout())

            // Re-trigger suggestions on every content change — typing AND deletion.
            // Only trigger suggestions on specific characters that open new contexts.
            // Firing on every keystroke keeps the popup open after the word is complete.
            editor.onDidChangeModelContent(e => {
              const lastChange = e.changes[e.changes.length - 1]
              if (!lastChange) return
              const lastChar = lastChange.text.slice(-1)
              if (['.', ' ', '(', ',', '\n'].includes(lastChar)) {
                editor.trigger('content', 'editor.action.triggerSuggest', {})
              }
            })

          }}
          options={{
            fontSize: 14,
            fontFamily: "'Cascadia Code', 'JetBrains Mono', Consolas, monospace",
            fontLigatures: true,
            lineHeight: 0,
            minimap: { enabled: true, scale: 1, showSlider: 'mouseover' },
            glyphMargin: false,
            folding: true,
            showFoldingControls: 'never',
            lineNumbers: 'off',
            lineDecorationsWidth: 12,
            occurrencesHighlight: 'singleFile',
            selectionHighlight: false,
            scrollBeyondLastLine: false,
            wordWrap: 'off',
            tabSize: 2,
            renderLineHighlight: 'line',
            smoothScrolling: true,
            cursorSmoothCaretAnimation: 'on',
            cursorBlinking: 'smooth',
            quickSuggestions: { other: true, comments: false, strings: false },
            wordBasedSuggestions: 'off',
            suggestOnTriggerCharacters: true,
            parameterHints: { enabled: true },
            formatOnPaste: true,
            autoClosingBrackets: 'always',
            autoClosingQuotes: 'always',
            padding: { top: 12, bottom: 0 },
            scrollbar: { verticalScrollbarSize: 8, horizontalScrollbarSize: 8 },
          }}
        />
      </div>
    </div>
  )
})

export default SqlEditor
