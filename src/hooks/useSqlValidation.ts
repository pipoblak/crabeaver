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

const CHUNK_SIZE       = 10_000
const PARALLEL_BATCHES = 4
const CHUNK_DELAY      = 50

export function useSqlValidation(
  monaco: typeof monaco_t | null,
  editorRef: React.RefObject<monaco_t.editor.IStandaloneCodeEditor | null>,
  editorReady: boolean,
) {
  const { setState, setResults } = useValidation()
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

  const worker = () => workerRef.current!

  // ── Apply cached diagnostics to Monaco ──────────────────────────────────
  const applyAll = useCallback(() => {
    const editor = editorRef.current
    const model  = editor?.getModel()
    if (!editor || !model || !monaco) return

    const all: SqlDiagnostic[] = []
    cache.current.forEach(e => all.push(...e.diagnostics))

    setResults(
      all.filter(d => d.severity === 'error').length,
      all.filter(d => d.severity === 'warning').length,
    )

    monaco.editor.setModelMarkers(model, 'sql-validation', all.map(d => ({
      startLineNumber: d.line, startColumn: d.column,
      endLineNumber:   d.line, endColumn: Math.max(d.end_column, d.column + 1),
      message: d.message,
      severity: d.severity === 'error' ? monaco.MarkerSeverity.Error : monaco.MarkerSeverity.Warning,
    })))

    const decs: monaco_t.editor.IModelDeltaDecoration[] = []
    cache.current.forEach((entry, startLine) => {
      if (!entry.diagnostics.length) return
      const cls = entry.diagnostics.some(d => d.severity === 'error') ? 'sql-error-line' : 'sql-warning-line'
      const s = startLine + 1
      const e = startLine + entry.lineCount
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

    let results: SqlDiagnostic[] = []
    try {
      results = await invoke<SqlDiagnostic[]>('validate_sql_batch', { statements: input })
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
    if (!ranges.length) return
    const first = ranges[0].startLineNumber
    const last  = ranges[ranges.length - 1].endLineNumber
    const stmts = await worker().getViewportStatements(lines, first, last)
    await validateBatch(stmts)
    applyAll()
  }, [editorRef, validateBatch, applyAll])

  // ── Full background scan — only called on open ───────────────────────────
  const runFullScan = useCallback(async (lines: string[]) => {
    scanAbort.current = false
    setState('scanning')
    const stmts = await worker().splitStatements(lines)

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

  // ── Scroll listener — viewport validation only, no full scan ────────────
  useEffect(() => {
    if (!editorReady) return
    const editor = editorRef.current
    if (!editor) return
    const valueRef = { current: editor.getValue() }

    const d = editor.onDidScrollChange(() => {
      if (viewportDebounce.current) clearTimeout(viewportDebounce.current)
      viewportDebounce.current = setTimeout(() => {
        validateViewport(valueRef.current.split('\n'))
      }, 300)
    })

    // Keep valueRef current
    const d2 = editor.onDidChangeModelContent(() => {
      valueRef.current = editor.getValue()
    })

    return () => { d.dispose(); d2.dispose() }
  }, [editorReady, editorRef, validateViewport])

  // ── Main: react to value changes (typing) — viewport only ───────────────
  const validate = useCallback(async (value: string, isReset: boolean) => {
    const lines = value.split('\n')

    if (isReset) {
      // On open: clear cache, do viewport first, then full scan background
      scanAbort.current = true
      cache.current.clear()
      prevLines.current = []
      await validateViewport(lines)
      runFullScan(lines) // background, non-blocking
      return
    }

    // On typing: clear dirty lines immediately, then validate viewport
    const stmts = await worker().splitStatements(prevLines.current)
    const dirtyStarts = await worker().getDirtyStatements(prevLines.current, lines, stmts)
    if (dirtyStarts.length > 0) {
      for (const start of dirtyStarts) {
        const stmt = stmts.find(s => s.start === start)
        cache.current.set(start, { text: '', lineCount: stmt?.lineCount ?? 1, diagnostics: [] })
      }
      applyAll()
    }

    prevLines.current = lines

    if (viewportDebounce.current) clearTimeout(viewportDebounce.current)
    viewportDebounce.current = setTimeout(() => validateViewport(lines), 800)
  }, [validateViewport, runFullScan, applyAll])

  const resetCache = useCallback(() => {
    scanAbort.current = true
    cache.current.clear()
  }, [])

  return { validate, resetCache }
}
