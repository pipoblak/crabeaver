import Editor, { useMonaco } from '@monaco-editor/react'
import { useEffect, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { useTheme } from '@/context/ThemeContext'
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

interface Props {
  value: string
  onChange: (value: string) => void
}


// Determine if a hex color is dark based on luminance
function isDark(hex: string): boolean {
  const h = hex.replace('#', '')
  if (h.length < 6) return true
  const r = parseInt(h.slice(0, 2), 16)
  const g = parseInt(h.slice(2, 4), 16)
  const b = parseInt(h.slice(4, 6), 16)
  return (0.299 * r + 0.587 * g + 0.114 * b) < 140
}

export default function SqlEditor({ value, onChange }: Props) {
  const monaco = useMonaco()
  const { theme } = useTheme()
  const dark = isDark(theme.bg)
  const [editorReady, setEditorReady] = useState(false)
  const [editorInstance, setEditorInstance] = useState<monaco_t.editor.IStandaloneCodeEditor | null>(null)
  const editorRef = useRef<monaco_t.editor.IStandaloneCodeEditor | null>(null)
  const isFirstLoad = useRef(true)
  const { validate, resetCache } = useSqlValidation(monaco, editorRef, editorReady)

  const monacoThemeName = `crabeaver-${theme.name.replace(/[^a-z0-9]/gi, '-').toLowerCase()}`

  // Force highlight color in selected suggest row via CSS injection
  // (selectedHighlightForeground token is ignored by Monaco internals)
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

      /* Custom fold toggle glyph classes (kept for compat, not used) */
    `
    return () => { el?.remove() }
  }, [])

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
        'editorSuggestWidget.background':                     theme.sidebarBg,
        'editorSuggestWidget.border':                         theme.border,
        'editorSuggestWidget.foreground':                     theme.text,
        'editorSuggestWidget.selectedBackground':             dark ? '#1a3a5c' : '#0060c0',
        'editorSuggestWidget.selectedForeground':             '#ffffff',
        'editorSuggestWidget.highlightForeground':            theme.tabAccent,
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

  // SQL context-aware autocomplete — computed in Rust
  useEffect(() => {
    if (!monaco) return

    const kindMap: Record<string, number> = {
      keyword: monaco.languages.CompletionItemKind.Keyword,
      function: monaco.languages.CompletionItemKind.Function,
      snippet: monaco.languages.CompletionItemKind.Snippet,
    }

    const disposable = monaco.languages.registerCompletionItemProvider('sql', {
      provideCompletionItems: async (model, position) => {
        const word = model.getWordUntilPosition(position)
        const offset = model.getOffsetAt(position)
        const sql = model.getValue()
        const range = {
          startLineNumber: position.lineNumber,
          endLineNumber: position.lineNumber,
          startColumn: word.startColumn,
          endColumn: word.endColumn,
        }

        const completions = await invoke<SqlCompletion[]>('get_sql_completions', {
          sql,
          cursorOffset: offset,
        })

        return {
          suggestions: completions.map(c => ({
            label: c.label,
            kind: kindMap[c.kind] ?? monaco.languages.CompletionItemKind.Keyword,
            insertText: c.insert_text,
            insertTextRules: c.kind === 'snippet' || c.insert_text.includes('${')
              ? monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet
              : undefined,
            detail: c.detail,
            documentation: c.documentation,
            range,
          })),
        }
      },
    })

    return () => disposable.dispose()
  }, [monaco])

  // DocumentHighlightProvider — returns [] for SQL keywords, occurrences for identifiers
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

  // Folding ranges — each multi-line statement is collapsible
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
            start: s.start + 1,               // 1-indexed
            end:   s.start + s.lineCount,
            kind:  monaco.languages.FoldingRangeKind.Region,
          }))
      },
    })
    return () => disposable.dispose()
  }, [monaco])

  // Trigger validation when value changes or editor first mounts
  useEffect(() => {
    if (!editorReady) return
    const isReset = isFirstLoad.current
    isFirstLoad.current = false
    validate(value, isReset)
  }, [value, editorReady, validate])

  // Shared worker for statement splitting (reused across cursor moves)
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

  // Scope + fold handled by EditorGutter component

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
      <div style={{ flex: 1, position: 'relative' }}>
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
}
