/**
 * Split a SQL string into individual statements on top-level `;`, ignoring
 * semicolons inside string literals (`'...'`, `"..."` with doubled-quote escapes),
 * line comments (`-- ... \n`), and slash-star block comments.
 *
 * Returns each statement trimmed, with empty/whitespace-only segments dropped.
 * A single statement (with or without a trailing `;`) returns `[stmt]`.
 */
export function splitSqlStatements(sql: string): string[] {
  const out: string[] = []
  let buf = ''
  let i = 0
  const n = sql.length

  while (i < n) {
    const ch = sql[i]
    const next = sql[i + 1]

    // Line comment — copy through end of line.
    if (ch === '-' && next === '-') {
      const nl = sql.indexOf('\n', i)
      const end = nl === -1 ? n : nl
      buf += sql.slice(i, end)
      i = end
      continue
    }

    // Block comment — copy through the closing `*/`.
    if (ch === '/' && next === '*') {
      const close = sql.indexOf('*/', i + 2)
      const end = close === -1 ? n : close + 2
      buf += sql.slice(i, end)
      i = end
      continue
    }

    // Quoted string / identifier — copy through the matching close quote,
    // treating a doubled quote (`''` or `""`) as an escape that stays inside.
    if (ch === "'" || ch === '"') {
      const quote = ch
      buf += ch
      let j = i + 1
      while (j < n) {
        buf += sql[j]
        if (sql[j] === quote) {
          if (sql[j + 1] === quote) { buf += sql[j + 1]; j += 2; continue }
          j++
          break
        }
        j++
      }
      i = j
      continue
    }

    // Top-level statement terminator.
    if (ch === ';') {
      const s = buf.trim()
      if (s) out.push(s)
      buf = ''
      i++
      continue
    }

    buf += ch
    i++
  }

  const last = buf.trim()
  if (last) out.push(last)
  return out
}
