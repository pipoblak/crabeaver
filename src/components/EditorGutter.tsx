import { useEffect, useRef, useState, useCallback } from 'react'
import type * as monaco_t from 'monaco-editor'
import type { SqlWorkerApi, Statement } from '@/workers/sqlWorker'

interface Props {
  editor: monaco_t.editor.IStandaloneCodeEditor
  monaco: typeof monaco_t
  workerApi: SqlWorkerApi | null
  value: string
}

const STMT_KEYWORDS = /^(SELECT|INSERT|UPDATE|DELETE|CREATE|DROP|ALTER|TRUNCATE|WITH|MERGE|CALL|EXPLAIN)\b/i

const GUTTER_W   = 60
const FOLD_W     = 16
const NUM_W      = 28
const SCOPE_W    = 14
const SCOPE_COLOR = 'var(--text-dim, #858585)'
const SCOPE_OPACITY = 0.3

export default function EditorGutter({ editor, monaco, workerApi, value }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [scrollTop, setScrollTop]      = useState(0)
  const [lineHeight, setLineHeight]    = useState(19)
  const [stmts, setStmts]              = useState<Statement[]>([])
  const [totalLines, setTotalLines]    = useState(1)
  const [collapsedLines, setCollapsed] = useState(new Set<number>())
  const [hoveredLine, setHoveredLine]  = useState<number | null>(null)
  const [cursorLine, setCursorLine]    = useState(1)
  const [height, setHeight]            = useState(600)

  const [layoutVersion, setLayoutVersion] = useState(0)

  useEffect(() => {
    const d1 = editor.onDidScrollChange(e => setScrollTop(e.scrollTop))
    const d2 = editor.onDidLayoutChange(() => setLayoutVersion(v => v + 1))
    setLineHeight(editor.getOption(monaco.editor.EditorOption.lineHeight))
    return () => { d1.dispose(); d2.dispose() }
  }, [editor, monaco])

  useEffect(() => {
    if (!workerApi) return
    const lines = value.split('\n')
    setTotalLines(lines.length)
    workerApi.splitStatements(lines).then(setStmts)
  }, [value, workerApi])

  useEffect(() => {
    const update = () => {
      const fc = editor.getContribution<any>('editor.contrib.folding')
      fc?.getFoldingModel?.().then((fm: any) => {
        if (!fm) return
        const collapsed = new Set<number>()
        stmts.forEach(s => {
          if (s.lineCount > 1) {
            const r = fm.getRegionAtLine?.(s.start + 1)
            if (r?.isCollapsed) collapsed.add(s.start + 1)
          }
        })
        setCollapsed(collapsed)
      })
    }
    update()
    const d = editor.onDidChangeHiddenAreas(update)
    return () => d.dispose()
  }, [editor, stmts])

  useEffect(() => {
    const d = editor.onDidChangeCursorPosition(e => setCursorLine(e.position.lineNumber))
    return () => d.dispose()
  }, [editor])

  useEffect(() => {
    const obs = new ResizeObserver(entries => setHeight(entries[0].contentRect.height))
    if (containerRef.current) obs.observe(containerRef.current)
    return () => obs.disconnect()
  }, [])

  const toggleFold = useCallback(async (lineNumber: number) => {
    const fc = editor.getContribution<any>('editor.contrib.folding')
    const fm = await fc?.getFoldingModel?.()
    const region = fm?.getRegionAtLine?.(lineNumber)
    editor.setPosition({ lineNumber, column: 1 })
    if (region?.isCollapsed) {
      editor.trigger('gutter', 'editor.unfold', { selectionLines: [lineNumber] })
    } else {
      editor.trigger('gutter', 'editor.fold', { selectionLines: [lineNumber] })
    }
  }, [editor])

  const selectLine = useCallback((lineNumber: number) => {
    const model = editor.getModel()
    if (!model) return
    const lineLength = model.getLineLength(lineNumber)
    editor.setSelection(new monaco.Selection(lineNumber, 1, lineNumber, lineLength + 1))
    editor.focus()
  }, [editor, monaco])

  // Build lookup maps
  const stmtByStart = new Map<number, Statement>()
  const lineToStmt  = new Map<number, Statement>()
  stmts.forEach(s => {
    const start = s.start + 1
    stmtByStart.set(start, s)
    for (let l = start; l <= start + s.lineCount - 1; l++) lineToStmt.set(l, s)
  })

  // Use Monaco's actual line positions — accounts for find widget, folded lines, padding
  const firstVisible = Math.max(1, Math.floor(scrollTop / lineHeight))
  const lastVisible  = Math.min(totalLines, Math.ceil((scrollTop + height) / lineHeight) + 2)

  // Suppress unused warning
  void layoutVersion

  const lines = []
  for (let ln = firstVisible; ln <= lastVisible; ln++) {
    const top = editor.getTopForLineNumber(ln) - scrollTop
    const stmt  = stmtByStart.get(ln)
    const inStmt = lineToStmt.get(ln)
    const isFoldable = stmt && stmt.lineCount > 1
    const collapsed  = collapsedLines.has(ln)

    // Only show scope for actual SQL statements (starts with keyword)
    const isSqlStmt = inStmt ? STMT_KEYWORDS.test(inStmt.text.trimStart()) : false
    const isActiveStmt = isSqlStmt && lineToStmt.get(cursorLine) === inStmt
    const barColor   = isActiveStmt ? 'var(--tab-accent)' : SCOPE_COLOR
    const barOpacity = isActiveStmt ? 0.55 : SCOPE_OPACITY
    let scopeStyle: React.CSSProperties = {}
    if (isSqlStmt && inStmt && inStmt.lineCount > 1) {
      const start = inStmt.start + 1
      const end   = start + inStmt.lineCount - 1
      const isFirst = ln === start
      const isLast  = ln === end

      scopeStyle = {
        borderLeft:   `1px solid ${barColor}`,
        borderTop:    isFirst ? `1px solid ${barColor}` : 'none',
        borderBottom: isLast  ? `1px solid ${barColor}` : 'none',
        opacity:      barOpacity,
        borderRadius: isFirst && isLast ? 2 : isFirst ? '2px 2px 0 0' : isLast ? '0 0 2px 2px' : 0,
        margin:       isFirst ? '6px 2px 0' : isLast ? '0 2px 6px' : '0 2px',
        alignSelf: 'stretch',
      }
    } else if (isSqlStmt && inStmt && inStmt.lineCount === 1) {
      scopeStyle = {
        borderLeft: `1px solid ${barColor}`,
        opacity:    barOpacity,
        margin: '4px 2px',
        alignSelf: 'stretch',
      }
    }

    lines.push(
      <div
        key={ln}
        onMouseEnter={() => setHoveredLine(ln)}
        onMouseLeave={() => setHoveredLine(null)}
        style={{
          position: 'absolute',
          top,
          height: lineHeight,
          width: '100%',
          display: 'flex',
          alignItems: 'center',
          boxSizing: 'border-box',
        }}
      >
        {/* Fold toggle */}
        <div style={{ width: FOLD_W, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, paddingLeft: 4 }}>
          {isFoldable && (
            lineToStmt.get(hoveredLine ?? -1) === lineToStmt.get(ln) ||
            lineToStmt.get(cursorLine) === lineToStmt.get(ln)
          ) && (
            <span
              style={{ fontSize: 11, fontWeight: 700, cursor: 'pointer', color: 'var(--text-dim)', lineHeight: 1 }}
              onMouseEnter={e => (e.currentTarget as HTMLElement).style.color = 'var(--tab-accent)'}
              onMouseLeave={e => (e.currentTarget as HTMLElement).style.color = 'var(--text-dim)'}
              onClick={() => toggleFold(ln)}
            >
              {collapsed ? '+' : '−'}
            </span>
          )}
        </div>

        {/* Line number */}
        <div
          style={{
            width: NUM_W,
            textAlign: 'right',
            paddingRight: 4,
            fontSize: 12,
            color: 'var(--text-dim)',
            flexShrink: 0,
            cursor: 'pointer',
            userSelect: 'none',
          }}
          onClick={() => selectLine(ln)}
          onMouseEnter={e => (e.currentTarget as HTMLElement).style.color = 'var(--text)'}
          onMouseLeave={e => (e.currentTarget as HTMLElement).style.color = 'var(--text-dim)'}
        >
          {ln}
        </div>

        {/* Continuous scope bar */}
        <div style={{ width: SCOPE_W, flexShrink: 0, display: 'flex', alignSelf: 'stretch', alignItems: 'stretch', padding: '0 4px' }}>
          <div style={{ flex: 1, ...scopeStyle }} />
        </div>
      </div>
    )
  }

  return (
    <div
      ref={containerRef}
      style={{
        position: 'relative',
        width: GUTTER_W,
        flexShrink: 0,
        overflow: 'hidden',
        background: 'var(--bg)',
        borderRight: '1px solid var(--border)',
      }}
    >
      {lines}
    </div>
  )
}
