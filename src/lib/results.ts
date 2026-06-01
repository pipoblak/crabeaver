export interface ColumnInfo { name: string; typeName: string }

export interface QueryResult {
  columns:       ColumnInfo[]
  rows:          unknown[][]
  affectedRows?: number
  executionMs:   number
}

export interface ResultTab {
  id:           string
  title:        string
  data?:        QueryResult
  error?:       string
  running?:     boolean
  loadingMore?: boolean
  sql?:         string      // last executed SQL (shown as preview)
  ranAt?:       number       // epoch ms the result was last fetched (for "fetched Nm ago")
  baseSql?:     string      // SQL without ORDER BY/LIMIT/WHERE — for re-sort, filter, pagination
  sortCol?:     string
  sortDir?:     'asc' | 'desc'
  colFilters?:  Record<string, string>  // col → filter value
  colFilterOps?: Record<string, string> // col → operator: '~' | '=' | '!=' | '>' | '<'
  offset?:      number
  hasMore?:     boolean
  history?:     Array<Pick<ResultTab, 'data'|'sql'|'baseSql'|'sortCol'|'sortDir'|'colFilters'|'colFilterOps'|'offset'|'hasMore'>>
  // Forward stack: states popped off `history` by Back, restorable by Forward.
  // Cleared whenever a new FK navigation branches the history.
  future?:      Array<Pick<ResultTab, 'data'|'sql'|'baseSql'|'sortCol'|'sortDir'|'colFilters'|'colFilterOps'|'offset'|'hasMore'>>
}
