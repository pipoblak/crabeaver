import { useRef, useCallback, useEffect } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { wrap, type Remote } from 'comlink'
import { useValidation } from '@/context/ValidationContext'
import type { SqlWorkerApi, Statement } from '@/workers/sqlWorker'
import type * as monaco_t from 'monaco-editor'

export interface SqlDiagnostic {
  line: number
  column: number
  end_column: number
  message: string
  severity: string
}

interface CacheEntry {
  text: string
  lineCount: number
  diagnostics: SqlDiagnostic[]
}

const CHUNK_SIZE       = 250   // statements per IPC batch — bounds Rust parse load
const PARALLEL_BATCHES = 4     // batches per round (≤1000 stmts in flight)
const CHUNK_DELAY      = 50    // ms yield between rounds — keeps UI responsive

// Monaco renders only the first 500 markers per resource — see
// markerDecorationsService.read({ take: 500 }), sorted by position. Dump more and
// the squiggles silently stop after line ~N (the top of the file eats the whole
// budget). When a file exceeds this, scope markers + line decorations to the
// visible region so what's on screen always shows its diagnostics.
const MARKER_CAP      = 500
const VIEWPORT_BUFFER = 300    // lines of slack above/below the viewport

export function useSqlValidation(
  monaco: typeof monaco_t | null,
  editorRef: React.RefObject<monaco_t.editor.IStandaloneCodeEditor | null>,
  editorReady: boolean,
  schemaKey: string | null,
  dialect?: string,
) {
  const { setState, setResults } = useValidation()
  // Latest schema key, read at invoke time so dirty-detection caching survives key changes.
  const schemaKeyRef = useRef(schemaKey)
  schemaKeyRef.current = schemaKey
  // Latest dialect (the connection's driver), read at invoke time.
  const dialectRef = useRef(dialect)
  dialectRef.current = dialect
  const cache        = useRef(new Map<number, CacheEntry>())
  const prevLines    = useRef<string[]>([])
  const decorations  = useRef<monaco_t.editor.IEditorDecorationsCollection | null>(null)
  const workerRef    = useRef<Remote<SqlWorkerApi> | null>(null)
  const scanAbort    = useRef(false)
  const viewportDebounce = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Boot worker once
  useEffect(() => {
    const w = new Worker(new URL('../workers/sqlWorker.ts', import.meta.url), { type: 'module' })
    workerRef.current = wrap<SqlWorkerApi>(w)
    return () => { w.terminate(); workerRef.current = null }
  }, [])

  const worker = () => workerRef.current

  // ── Apply cached diagnostics to Monaco ──────────────────────────────────
  const applyAll = useCallback(() => {
    const editor = editorRef.current
    const model  = editor?.getModel()
    if (!editor || !model || !monaco) return

    // Clamp all line refs to the current model — stale cache entries (e.g. after
    // the doc shrank) could otherwise push a line past the end, and getLineMaxColumn
    // throws on out-of-range input, which would silently kill every later applyAll.
    const maxLine = model.getLineCount()

    const all: SqlDiagnostic[] = []
    cache.current.forEach(e => all.push(...e.diagnostics))

    // Status-bar counts always reflect the WHOLE file, even when we only render a
    // windowed subset of markers below.
    setResults(
      all.filter(d => d.severity === 'error').length,
      all.filter(d => d.severity === 'warning').length,
    )

    // When over Monaco's 500-marker cap, restrict rendering to the visible region
    // (± buffer) so squiggles follow the viewport on scroll instead of dying at
    // line ~500. Below the cap, render everything (keeps the overview ruler whole).
    let lo = 1, hi = maxLine
    const windowed = all.length > MARKER_CAP
    if (windowed) {
      const ranges = editor.getVisibleRanges()
      lo = (ranges.length ? ranges[0].startLineNumber : 1) - VIEWPORT_BUFFER
      hi = (ranges.length ? ranges[ranges.length - 1].endLineNumber : maxLine) + VIEWPORT_BUFFER
    }

    const shown = (windowed ? all.filter(d => d.line >= lo && d.line <= hi) : all).slice(0, MARKER_CAP)
    monaco.editor.setModelMarkers(model, 'sql-validation', shown.map(d => {
      const line = Math.min(d.line, maxLine)
      return {
        startLineNumber: line, startColumn: d.column,
        endLineNumber:   line, endColumn: Math.max(d.end_column, d.column + 1),
        message: d.message,
        severity: d.severity === 'error' ? monaco.MarkerSeverity.Error : monaco.MarkerSeverity.Warning,
      }
    }))

    const decs: monaco_t.editor.IModelDeltaDecoration[] = []
    cache.current.forEach((entry, startLine) => {
      if (!entry.diagnostics.length) return
      // Same windowing as markers: skip statements outside the visible region when
      // the file is huge, so we don't push tens of thousands of decorations.
      if (windowed && (startLine + entry.lineCount < lo || startLine + 1 > hi)) return
      const cls = entry.diagnostics.some(d => d.severity === 'error') ? 'sql-error-line' : 'sql-warning-line'
      const s = Math.min(startLine + 1, maxLine)
      const e = Math.min(startLine + entry.lineCount, maxLine)
      decs.push({
        range: new monaco.Range(s, 1, e, model.getLineMaxColumn(e) || 1),
        options: { isWholeLine: true, className: cls },
      })
    })
    if (decorations.current) decorations.current.set(decs)
    else decorations.current = editor.createDecorationsCollection(decs)
  }, [monaco, editorRef, setResults])

  // ── Batch validate (one IPC, Rust uses rayon) ───────────────────────────
  const validateBatch = useCallback(async (stmts: Statement[]) => {
    const dirty = stmts.filter(s => {
      const trimmed = s.text.trim().replace(/;$/, '').trim()
      if (!trimmed) return false
      const cached = cache.current.get(s.start)
      return !cached || cached.text !== trimmed
    })
    if (!dirty.length) return

    const input = dirty.map(s => ({
      start_line: s.start,
      sql: s.text.trim().replace(/;$/, '').trim(),
    }))

    let results: SqlDiagnostic[]
    try {
      results = await invoke<SqlDiagnostic[]>('validate_sql_batch', { statements: input, schemaKey: schemaKeyRef.current, dialect: dialectRef.current })
    } catch (e) {
      console.error('[sql-validation] batch failed:', e)
      return
    }

    for (const s of dirty) {
      cache.current.set(s.start, {
        text: s.text.trim().replace(/;$/, '').trim(),
        lineCount: s.lineCount,
        diagnostics: [],
      })
    }
    for (const d of results) {
      const owner = dirty.find(s => d.line > s.start && d.line <= s.start + s.lineCount) ?? dirty[0]
      if (owner) cache.current.get(owner.start)!.diagnostics.push(d)
    }
  }, [])

  // ── Viewport validation ──────────────────────────────────────────────────
  const validateViewport = useCallback(async (lines: string[]) => {
    const editor = editorRef.current
    if (!editor) return
    const ranges = editor.getVisibleRanges()
    // Fallback to first 60 lines when editor hasn't rendered yet (initial mount)
    const first = ranges.length ? ranges[0].startLineNumber : 1
    const last  = ranges.length ? ranges[ranges.length - 1].endLineNumber : Math.min(60, lines.length)
    const w1 = worker(); if (!w1) return
    const stmts = await w1.getViewportStatements(lines, first, last)
    await validateBatch(stmts)
    applyAll()
  }, [editorRef, validateBatch, applyAll])

  // ── Full background scan — only called on open ───────────────────────────
  const runFullScan = useCallback(async (lines: string[]) => {
    scanAbort.current = false
    setState('scanning')
    const w2 = worker(); if (!w2) return
    const stmts = await w2.splitStatements(lines)

    for (let i = 0; i < stmts.length; i += CHUNK_SIZE * PARALLEL_BATCHES) {
      if (scanAbort.current) break
      const parallel: Promise<void>[] = []
      for (let j = 0; j < PARALLEL_BATCHES; j++) {
        const chunk = stmts.slice(i + j * CHUNK_SIZE, i + (j + 1) * CHUNK_SIZE)
        if (chunk.length) parallel.push(validateBatch(chunk))
      }
      await Promise.all(parallel)
      applyAll()
      if (i + CHUNK_SIZE * PARALLEL_BATCHES < stmts.length)
        await new Promise(r => setTimeout(r, CHUNK_DELAY))
    }

    if (!scanAbort.current) setState('done')
  }, [validateBatch, applyAll, setState])

  // ── Scroll listener — validate new viewport area using cache ─────────────
  useEffect(() => {
    if (!editorReady) return
    const editor = editorRef.current
    if (!editor) return
    const valueRef = { current: editor.getValue() }

    const d = editor.onDidScrollChange(() => {
      if (viewportDebounce.current) clearTimeout(viewportDebounce.current)
      viewportDebounce.current = setTimeout(() => {
        const lines = valueRef.current.split('\n')
        validateViewport(lines)
      }, 200)
    })

    const d2 = editor.onDidChangeModelContent(() => {
      valueRef.current = editor.getValue()
    })

    return () => { d.dispose(); d2.dispose() }
  }, [editorReady, editorRef, validateViewport])

  // ── Full scan timer — fires 2s after typing stops ─────────────────────────
  const fullScanTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // ── Main: react to value changes ──────────────────────────────────────────
  const validate = useCallback(async (value: string, isReset: boolean) => {
    const lines = value.split('\n')

    if (isReset) {
      scanAbort.current = true
      cache.current.clear()
      prevLines.current = []
      await validateViewport(lines)
      runFullScan(lines)
      return
    }

    // Worker initialises async — skip dirty detection if not ready yet
    if (!worker()) { prevLines.current = lines; return }

    // Clear dirty lines immediately so errors vanish while typing
    const w3 = worker(); if (!w3) return
    const stmts = await w3.splitStatements(prevLines.current)
    const dirtyStarts = await w3.getDirtyStatements(prevLines.current, lines, stmts)
    if (dirtyStarts.length > 0) {
      for (const start of dirtyStarts) {
        const stmt = stmts.find(s => s.start === start)
        cache.current.set(start, { text: '', lineCount: stmt?.lineCount ?? 1, diagnostics: [] })
      }
      applyAll()
    }

    prevLines.current = lines

    // Validate viewport quickly
    if (viewportDebounce.current) clearTimeout(viewportDebounce.current)
    viewportDebounce.current = setTimeout(() => validateViewport(lines), 400)

    // Full scan 2s after typing stops — catches errors outside viewport
    if (fullScanTimer.current) clearTimeout(fullScanTimer.current)
    fullScanTimer.current = setTimeout(() => runFullScan(lines), 2000)
  }, [validateViewport, runFullScan, applyAll])

  const resetCache = useCallback(() => {
    scanAbort.current = true
    cache.current.clear()
  }, [])

  // Re-validate when the schema index changes — statements cached as clean
  // before the schema loaded must be re-checked against the new table set.
  useEffect(() => {
    if (!editorReady) return
    const editor = editorRef.current
    if (!editor) return
    cache.current.clear()
    const lines = editor.getValue().split('\n')
    validateViewport(lines)
    runFullScan(lines)
  }, [schemaKey, editorReady, editorRef, validateViewport, runFullScan])

  return { validate, resetCache }
}
