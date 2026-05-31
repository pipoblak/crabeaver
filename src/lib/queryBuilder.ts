export type Dialect = 'postgres' | 'sqlite'
export interface Sort { col: string; dir: 'asc' | 'desc' }
export interface ColFilter { col: string; value: string; op: string } // op: '~' | '=' | '!=' | '>' | '<'

/** Map a connection driver string to a query dialect. */
export function driverToDialect(driver?: string): Dialect {
  return driver === 'sqlite' ? 'sqlite' : 'postgres'
}

/** Quote an identifier, doubling embedded quotes so a hostile name is inert. */
export function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`
}

export function qualifiedRef(schema: string, table: string): string {
  return `${quoteIdent(schema)}.${quoteIdent(table)}`
}

/** Escape a string literal's single quotes. Result is NOT surrounded by quotes. */
export function escapeLiteral(value: string): string {
  return value.replace(/'/g, "''")
}

/** One column-filter predicate. Postgres casts with `::text`+ILIKE; SQLite uses
 *  CAST(... AS TEXT)+LIKE (case-insensitive for ASCII). */
export function buildFilterPredicate(f: ColFilter, dialect: Dialect = 'postgres'): string {
  const v = escapeLiteral(f.value)
  const cast = dialect === 'sqlite' ? `CAST(${quoteIdent(f.col)} AS TEXT)` : `${quoteIdent(f.col)}::text`
  const contains = dialect === 'sqlite' ? 'LIKE' : 'ILIKE'
  switch (f.op) {
    case '~':  return `${cast} ${contains} '%${v}%'`
    case '!=': return `${cast} != '${v}'`
    case '>':  return `${cast} > '${v}'`
    case '<':  return `${cast} < '${v}'`
    default:   return `${cast} = '${v}'`
  }
}

/** Append LIMIT to a SELECT/WITH that has no top-level LIMIT. Mirrors the editor's
 *  original helper: ignores non-SELECT, ignores parenthesised (subquery) LIMITs. */
export function applyLimit(sql: string, limit: number): string {
  if (limit <= 0) return sql
  const s = sql.trim().replace(/;\s*$/, '').trimEnd()
  if (!/^(SELECT|WITH)\b/i.test(s)) return sql
  let depth = 0, stripped = ''
  for (const ch of s) {
    if (ch === '(') { depth++; stripped += ' ' }
    else if (ch === ')') { depth = Math.max(0, depth - 1); stripped += ' ' }
    else stripped += depth > 0 ? ' ' : ch
  }
  if (/\bLIMIT\b/i.test(stripped)) return sql
  return `${s}\nLIMIT ${limit}`
}

/** Build a `SELECT * FROM schema.table` with optional filters/sort/pagination. */
export function buildTableQuery(opts: {
  schema: string
  table: string
  sort?: Sort
  filters?: ColFilter[]
  limit: number
  offset?: number
  dialect?: Dialect
}): string {
  const { schema, table, sort, filters = [], limit, offset, dialect = 'postgres' } = opts
  let sql = `SELECT * FROM ${qualifiedRef(schema, table)}`
  const active = filters.filter(f => f.value.trim() !== '')
  if (active.length) sql += `\nWHERE ${active.map(f => buildFilterPredicate(f, dialect)).join(' AND ')}`
  if (sort) sql += `\nORDER BY ${quoteIdent(sort.col)} ${sort.dir.toUpperCase()}`
  if (limit > 0) {
    sql += `\nLIMIT ${limit}`
    if (offset && offset > 0) sql += ` OFFSET ${offset}`
  }
  return sql
}
