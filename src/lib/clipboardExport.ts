import type { QueryResult } from '@/lib/results'

export type ExportFormat = 'csv' | 'json' | 'text'

// Render a single cell to a plain string for delimited formats.
// null/undefined → empty, objects/arrays → compact JSON, everything else → String().
function cell(v: unknown): string {
  if (v === null || v === undefined) return ''
  if (typeof v === 'object') return JSON.stringify(v)
  return String(v)
}

// RFC-4180 field: quote when it contains a comma, quote, CR or LF; double quotes.
function csvField(s: string): string {
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

export function toCSV(r: QueryResult): string {
  const head = r.columns.map(c => csvField(c.name)).join(',')
  const body = r.rows.map(row => r.columns.map((_, i) => csvField(cell(row[i]))).join(',')).join('\n')
  return body ? `${head}\n${body}` : head
}

// Tab-separated — pastes cleanly into spreadsheets. Tabs/newlines inside a cell
// are flattened to spaces so the grid shape survives.
export function toText(r: QueryResult): string {
  const flat = (s: string) => s.replace(/[\t\r\n]+/g, ' ')
  const head = r.columns.map(c => flat(c.name)).join('\t')
  const body = r.rows.map(row => r.columns.map((_, i) => flat(cell(row[i]))).join('\t')).join('\n')
  return body ? `${head}\n${body}` : head
}

// Array of row objects keyed by column name. Raw values are preserved (numbers,
// booleans, null, nested JSON); only undefined is normalised to null.
export function toJSON(r: QueryResult): string {
  const rows = r.rows.map(row => {
    const o: Record<string, unknown> = {}
    r.columns.forEach((c, i) => { o[c.name] = row[i] ?? null })
    return o
  })
  return JSON.stringify(rows, null, 2)
}

export function formatResult(r: QueryResult, fmt: ExportFormat): string {
  switch (fmt) {
    case 'csv':  return toCSV(r)
    case 'json': return toJSON(r)
    case 'text': return toText(r)
  }
}
