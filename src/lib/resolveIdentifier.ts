export interface ResolverCache {
  schemas: string[]
  tables:  Array<{ schema: string; name: string }>
}

export type ResolveTarget =
  | { kind: 'schema'; schema: string }
  | { kind: 'table'; schema: string; table: string }

const unquote = (s: string) => s.replace(/^"(.*)"$/s, '$1')

/**
 * Resolve the identifier under the cursor to a clickable target.
 * `word` is the bare token clicked; `before` is the text on the same line up to
 * (but not including) the word; `cache` is the known schema/table set.
 *
 * Priority: qualified `schema.word` → bare schema → bare table (unique, else
 * first match) → null.
 */
export function resolveIdentifier(word: string, before: string, cache: ResolverCache): ResolveTarget | null {
  const name = unquote(word.trim())
  if (!name) return null

  // 1. Qualified: a `<prefix>.` immediately precedes the word.
  const prefixMatch = before.match(/(?:^|[^\w."])"?([A-Za-z_][\w$]*)"?\s*\.\s*$/)
  if (prefixMatch) {
    const prefix = prefixMatch[1]
    if (cache.schemas.includes(prefix) && cache.tables.some(t => t.schema === prefix && t.name === name)) {
      return { kind: 'table', schema: prefix, table: name }
    }
  }

  // 2. Bare schema name.
  if (cache.schemas.includes(name)) {
    return { kind: 'schema', schema: name }
  }

  // 3. Bare table name — unique wins; ambiguous falls back to the first match.
  const matches = cache.tables.filter(t => t.name === name)
  if (matches.length > 0) {
    return { kind: 'table', schema: matches[0].schema, table: name }
  }

  return null
}
