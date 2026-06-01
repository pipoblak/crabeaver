import { useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { useConnections } from '@/context/ConnectionContext'
import { capabilitiesFor, descriptorFor } from '@/connectors/registry'
import { cacheGet, cacheSet, cacheDelete } from '@/lib/cache'
import { timeAgo } from '@/lib/timeAgo'
import { formatBytes } from '@/lib/formatBytes'
import {
  Plus, ChevronRight, ChevronDown, Plug, PlugZap, Loader2, RefreshCw,
  Table2, Database, FolderOpen, Folder, Settings,
  Shield,
} from 'lucide-react'

interface Connection { id: string; name: string; driver: string; host: string; port: number; database: string }
interface ColumnInfo  { name: string; typeName: string }
interface TableInfo   { name: string; columns: ColumnInfo[] }
interface SchemaInfo  { schema: string; tables: TableInfo[] }
interface TableSize   { name: string; bytes: number }
interface SchemaSizes { schema: string; totalBytes: number; tables: TableSize[] }
/** Per-database size lookup: schema → { total, table-name → bytes }. */
type SizeIndex = Record<string, { total: number; byTable: Record<string, number> }>

function indexSizes(rows: SchemaSizes[]): SizeIndex {
  const out: SizeIndex = {}
  for (const s of rows) {
    const byTable: Record<string, number> = {}
    for (const t of s.tables) byTable[t.name] = t.bytes
    out[s.schema] = { total: s.totalBytes, byTable }
  }
  return out
}

interface Props {
  openSettings?: (section?: string, connectionId?: string) => void
  openTab?: (type: 'session-manager' | 'lock-manager' | 'table-details' | 'schema-details', title: string, extra: Record<string, string>) => void
  width?: number
}

type LoadState = 'idle' | 'loading' | 'refreshing' | 'done' | 'error'

interface ConnectionTree {
  databases:    { names: string[]; state: LoadState; error?: string; fetchedAt?: number }
  schemas:      Record<string, { data: SchemaInfo[]; state: LoadState; error?: string; fetchedAt?: number }>
}

const dbCacheKey = (connId: string) => connId
const schemaCacheKey = (connId: string, dbName: string) => `${connId}:${dbName}`

function StatusBar({ status }: { status: string }) {
  const [show, setShow] = useState(false)
  return (
    <div className="relative shrink-0 cursor-default"
      style={{ borderTop: '1px solid var(--border)' }}
      onMouseEnter={() => setShow(true)}
      onMouseLeave={() => setShow(false)}
    >
      <p className="px-3 py-1.5 text-[10px] text-th-dim truncate">{status}</p>
      {show && (
        <div className="absolute bottom-full left-0 right-0 mb-1 mx-1 px-2 py-2 rounded text-[11px] z-50"
          style={{
            background: 'var(--sidebar-bg)',
            border: '1px solid var(--border)',
            color: 'var(--text)',
            wordBreak: 'break-word',
            boxShadow: '0 4px 12px rgba(0,0,0,0.35)',
            pointerEvents: 'none',
          }}>
          {status}
        </div>
      )}
    </div>
  )
}

export default function Sidebar({ openSettings, openTab, width = 224 }: Props) {
  const { connections, connected, connect: ctxConnect, disconnect: ctxDisconnect } = useConnections()
  const [loading, setLoading] = useState(new Set<string>())
  const [expanded, setExpanded]       = useState(new Set<string>()) // generic set of node keys
  const [trees, setTrees]             = useState<Record<string, ConnectionTree>>({})
  const [status, setStatus]           = useState('')
  // Per-database table/schema sizes, keyed by `${connId}:${db}`. Loaded eagerly
  // when a database's schema list opens, cached + background-refreshed.
  const [sizes, setSizes]             = useState<Record<string, SizeIndex>>({})

  // Fetch on-disk sizes for a database (all its schemas at once). Gated on the
  // engine's `tableSizes` capability; cached so reopen paints instantly.
  const loadSizes = (connId: string, dbName: string) => {
    const driver = connections.find(c => c.id === connId)?.driver
    if (!driver || !capabilitiesFor(driver).tableSizes) return
    const key = schemaCacheKey(connId, dbName)
    const cached = cacheGet<SchemaSizes[]>('schema-sizes', key)
    if (cached) setSizes(prev => ({ ...prev, [key]: indexSizes(cached.data) }))
    invoke<SchemaSizes[]>('get_schema_sizes', { connectionId: connId, database: dbName })
      .then(rows => {
        cacheSet('schema-sizes', key, rows)
        setSizes(prev => ({ ...prev, [key]: indexSizes(rows) }))
      })
      .catch(() => { /* sizes are best-effort; tree still works without them */ })
  }

  const setLoad = (id: string, on: boolean) =>
    setLoading(prev => { const s = new Set(prev); on ? s.add(id) : s.delete(id); return s })

  const isExpanded = (key: string) => expanded.has(key)
  const toggle = (key: string) => setExpanded(prev => {
    const s = new Set(prev); s.has(key) ? s.delete(key) : s.add(key); return s
  })

  const treeFor = (id: string): ConnectionTree =>
    trees[id] ?? { databases: { names: [], state: 'idle' }, schemas: {} }

  const updateTree = (id: string, fn: (t: ConnectionTree) => ConnectionTree) =>
    setTrees(prev => ({ ...prev, [id]: fn(treeFor(id)) }))

  const isPasswordMissing = (e: unknown) =>
    String(e).includes('Password not found')

  // Connect and expand top level
  const expandConnection = async (c: Connection) => {
    const key = c.id
    if (isExpanded(key)) { toggle(key); return }
    toggle(key)

    if (!connected.has(c.id)) {
      setLoad(c.id, true)
      setStatus(`Connecting to ${c.name}…`)
      try {
        await ctxConnect(c.id)
        setStatus(`Connected to ${c.name}`)
      } catch (e) {
        toggle(key) // collapse back
        if (isPasswordMissing(e)) {
          setStatus(`${c.name}: re-enter password in Settings`)
          openSettings?.('connections', c.id)
        } else {
          setStatus(`Error: ${String(e)}`)
        }
        setLoad(c.id, false)
        return
      } finally { setLoad(c.id, false) }
    }

    // Load databases if not loaded. Seed from cache for an instant paint, then
    // always background-refresh.
    const tree = treeFor(c.id)
    if (tree.databases.state === 'idle') {
      const cached = cacheGet<string[]>('databases', dbCacheKey(c.id))
      if (cached) {
        updateTree(c.id, t => ({ ...t, databases: { names: cached.data, state: 'refreshing', fetchedAt: cached.fetchedAt } }))
      } else {
        updateTree(c.id, t => ({ ...t, databases: { names: [], state: 'loading' } }))
      }
      setStatus(`Loading databases for ${c.name}…`)
      try {
        const names = await invoke<string[]>('list_databases', { connectionId: c.id })
        const entry = cacheSet('databases', dbCacheKey(c.id), names)
        updateTree(c.id, t => ({ ...t, databases: { names, state: 'done', fetchedAt: entry.fetchedAt } }))
        setStatus(`${c.name}: ${names.length} database${names.length !== 1 ? 's' : ''}`)
      } catch (e) {
        // Keep cached names visible on a refresh failure.
        updateTree(c.id, t => ({ ...t, databases: { names: t.databases.names, state: 'error', error: String(e), fetchedAt: t.databases.fetchedAt } }))
        setStatus(`Error: ${String(e)}`)
      }
    }
  }

  const expandDatabase = async (connId: string, dbName: string) => {
    const key = `${connId}/db/${dbName}`
    toggle(key)
  }

  const expandSchemas = async (connId: string, dbName: string) => {
    const key = `${connId}/schemas/${dbName}`
    const willExpand = !isExpanded(key)
    toggle(key)
    if (willExpand) loadSizes(connId, dbName)
    const tree = treeFor(connId)
    if (tree.schemas[dbName]?.state === 'done') return
    const cached = cacheGet<SchemaInfo[]>('schemas', schemaCacheKey(connId, dbName))
    if (cached) {
      updateTree(connId, t => ({ ...t, schemas: { ...t.schemas, [dbName]: { data: cached.data, state: 'refreshing', fetchedAt: cached.fetchedAt } } }))
    } else {
      updateTree(connId, t => ({ ...t, schemas: { ...t.schemas, [dbName]: { data: [], state: 'loading' } } }))
    }
    setStatus(`Loading schemas…`)
    try {
      const data = await invoke<SchemaInfo[]>('get_schemas', { connectionId: connId })
      const entry = cacheSet('schemas', schemaCacheKey(connId, dbName), data)
      updateTree(connId, t => ({ ...t, schemas: { ...t.schemas, [dbName]: { data, state: 'done', fetchedAt: entry.fetchedAt } } }))
      const total = data.reduce((n, s) => n + s.tables.length, 0)
      setStatus(`${total} table${total !== 1 ? 's' : ''} loaded`)
    } catch (e) {
      updateTree(connId, t => ({ ...t, schemas: { ...t.schemas, [dbName]: { data: t.schemas[dbName]?.data ?? [], state: 'error', error: String(e), fetchedAt: t.schemas[dbName]?.fetchedAt } } }))
      setStatus(`Error: ${String(e)}`)
    }
  }

  // Background refresh — keeps old data visible, replaces when done
  const refreshDatabases = async (connId: string, connName: string, e: React.MouseEvent) => {
    e.stopPropagation()
    updateTree(connId, t => ({ ...t, databases: { ...t.databases, state: 'refreshing' } }))
    setStatus(`Refreshing databases for ${connName}…`)
    try {
      const names = await invoke<string[]>('list_databases', { connectionId: connId })
      const entry = cacheSet('databases', dbCacheKey(connId), names)
      updateTree(connId, t => ({ ...t, databases: { names, state: 'done', fetchedAt: entry.fetchedAt } }))
      setStatus(`${connName}: ${names.length} database${names.length !== 1 ? 's' : ''}`)
    } catch (e) {
      updateTree(connId, t => ({ ...t, databases: { ...t.databases, state: 'error', error: String(e) } }))
      setStatus(`Error: ${String(e)}`)
    }
  }

  const refreshSchemas = async (connId: string, dbName: string, e: React.MouseEvent) => {
    e.stopPropagation()
    loadSizes(connId, dbName)
    updateTree(connId, t => ({ ...t, schemas: { ...t.schemas, [dbName]: { ...(t.schemas[dbName] ?? { data: [] }), state: 'refreshing' } } }))
    setStatus(`Refreshing schemas…`)
    try {
      const data = await invoke<SchemaInfo[]>('get_schemas', { connectionId: connId })
      const entry = cacheSet('schemas', schemaCacheKey(connId, dbName), data)
      updateTree(connId, t => ({ ...t, schemas: { ...t.schemas, [dbName]: { data, state: 'done', fetchedAt: entry.fetchedAt } } }))
      const total = data.reduce((n, s) => n + s.tables.length, 0)
      setStatus(`${total} table${total !== 1 ? 's' : ''} loaded`)
    } catch (e) {
      updateTree(connId, t => ({ ...t, schemas: { ...t.schemas, [dbName]: { ...(t.schemas[dbName] ?? { data: [] }), state: 'error', error: String(e) } } }))
      setStatus(`Error: ${String(e)}`)
    }
  }

  const toggleConnect = async (c: Connection, e: React.MouseEvent) => {
    e.stopPropagation()
    setLoad(c.id, true)
    try {
      if (connected.has(c.id)) {
        setStatus(`Disconnecting…`)
        await ctxDisconnect(c.id)
        // Drop cached tree for this connection so a reconnect doesn't paint a
        // tree from a dead session.
        const dead = treeFor(c.id)
        cacheDelete('databases', dbCacheKey(c.id))
        for (const db of dead.databases.names) {
          cacheDelete('schemas', schemaCacheKey(c.id, db))
          cacheDelete('schema-sizes', schemaCacheKey(c.id, db))
        }
        setSizes(prev => {
          const next = { ...prev }
          for (const k of Object.keys(next)) { if (k.startsWith(`${c.id}:`)) delete next[k] }
          return next
        })
        setTrees(prev => { const t = { ...prev }; delete t[c.id]; return t })
        setExpanded(prev => {
          const s = new Set(prev)
          for (const k of [...s]) { if (k.startsWith(c.id)) s.delete(k) }
          return s
        })
        setStatus(`Disconnected`)
      } else {
        setStatus(`Connecting to ${c.name}…`)
        try {
          await ctxConnect(c.id)
        } catch (e) {
          if (isPasswordMissing(e)) {
            setStatus(`${c.name}: re-enter password in Settings`)
            openSettings?.('connections', c.id)
          } else {
            setStatus(`Error: ${String(e)}`)
          }
          return
        }
        setStatus(`Connected to ${c.name}`)
      }
    } catch (err) { setStatus(`Error: ${String(err)}`) }
    finally { setLoad(c.id, false) }
  }

  const Row = ({ depth, icon, label, expanded: exp, onClick, loading: spin, refreshing, onRefresh, fetchedAt, trailing }: {
    depth: number; icon: React.ReactNode; label: string
    expanded?: boolean; onClick?: () => void; loading?: boolean
    refreshing?: boolean; onRefresh?: (e: React.MouseEvent) => void; fetchedAt?: number
    /** Dim right-aligned text (e.g. a size badge). Hidden while the refresh button shows. */
    trailing?: string
  }) => {
    const [hovered, setHovered] = useState(false)
    return (
      <div
        className="flex items-center gap-1.5 cursor-pointer transition-colors"
        style={{ paddingLeft: 8 + depth * 12, paddingTop: 3, paddingBottom: 3, paddingRight: 8, background: hovered ? 'var(--hover)' : 'transparent' }}
        onClick={onClick}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
      >
        <span className="shrink-0 text-th-dim w-3 flex justify-center">
          {spin ? <Loader2 size={10} className="animate-spin" />
            : exp !== undefined ? (exp ? <ChevronDown size={10} /> : <ChevronRight size={10} />) : null}
        </span>
        <span className="shrink-0 text-th-dim">{icon}</span>
        <span className="text-[12px] text-th-text truncate flex-1">{label}</span>
        {trailing && !(onRefresh && hovered) && (
          <span className="shrink-0 text-[10px] text-th-dim tabular-nums">{trailing}</span>
        )}
        {onRefresh && hovered && (
          <button
            onClick={onRefresh}
            title={refreshing ? 'Refreshing…' : fetchedAt ? `Updated ${timeAgo(fetchedAt)} · click to refresh` : 'Refresh'}
            className="text-th-dim hover:text-th-accent transition-colors"
            style={{ flexShrink: 0 }}
          >
            <RefreshCw size={10} className={refreshing ? 'animate-spin' : ''} />
          </button>
        )}
      </div>
    )
  }

  return (
    <aside className="flex flex-col shrink-0 overflow-hidden bg-th-sidebar" style={{ width, borderRight: '1px solid var(--border)' }}>
      {/* Header */}
      <div className="flex items-center justify-between pl-4 pr-2 border-t border-t-transparent border-b border-b-th-border" style={{ height: 37 }}>
        <span className="text-[11px] font-semibold tracking-[0.1em] uppercase text-th-dim">Connections</span>
        <div className="flex items-center gap-0.5">
          <button onClick={() => openSettings?.('connections')} title="New connection"
            className="flex items-center justify-center w-6 h-6 rounded transition-colors text-th-dim hover:text-th-text">
            <Plus size={13} />
          </button>
          <button onClick={() => openSettings?.('connections')} title="Manage"
            className="flex items-center justify-center w-6 h-6 rounded transition-colors text-th-dim hover:text-th-text">
            <Settings size={12} />
          </button>
        </div>
      </div>

      {/* Tree */}
      <div className="flex flex-col flex-1 overflow-y-auto">
        {connections.length === 0 && (
          <div className="flex flex-col items-center justify-center flex-1 px-4">
            <p className="text-[11px] text-center text-th-dim">No connections yet.<br />Click + to add one.</p>
          </div>
        )}

        {connections.map(c => {
          const isConn    = connected.has(c.id)
          const isLoad    = loading.has(c.id)
          const connExp   = isExpanded(c.id)
          const tree      = treeFor(c.id)
          // Capability gating: only show server tools the connector actually has.
          const caps      = capabilitiesFor(c.driver)
          const descriptor = descriptorFor(c.driver)
          const adminItems = [
            caps.sessions ? 'Sessions' : null,
            caps.locks    ? 'Locks'    : null,
          ].filter(Boolean) as string[]
          const subtitle  = descriptor.connectionKind === 'file'
            ? (c.database.split('/').pop() || c.database)
            : `${c.host}:${c.port}`

          return (
            <div key={c.id}>
              {/* Connection row */}
              <div className="group flex items-center gap-1.5 cursor-pointer transition-colors hover:bg-th-hover"
                style={{ padding: '4px 8px 4px 8px' }}
                onClick={() => expandConnection(c)}>
                <span className="shrink-0 text-th-dim w-3 flex justify-center">
                  {isLoad ? <Loader2 size={10} className="animate-spin" />
                    : connExp ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
                </span>
                <span className="shrink-0 w-2 h-2 rounded-full" style={{ background: isConn ? '#22c55e' : 'var(--text-dim)' }} />
                <div className="flex flex-col flex-1 min-w-0">
                  <span className="text-[13px] text-th-text truncate font-medium">{c.name}</span>
                  <span className="text-[10px] text-th-dim truncate">{subtitle}</span>
                </div>
                <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                  <button onClick={e => { e.stopPropagation(); openSettings?.('connections', c.id) }}
                    title="Edit connection"
                    className="flex items-center justify-center w-5 h-5 text-th-dim hover:text-th-accent transition-colors">
                    <Settings size={10} />
                  </button>
                  <button onClick={e => toggleConnect(c, e)} title={isConn ? 'Disconnect' : 'Connect'}
                    className="flex items-center justify-center w-5 h-5 text-th-dim hover:text-th-accent transition-colors">
                    {isConn ? <PlugZap size={11} /> : <Plug size={11} />}
                  </button>
                </div>
              </div>

              {/* Top-level categories */}
              {connExp && (
                <>
                  {/* Databases */}
                  <Row depth={1} icon={<Database size={11} />} label="Databases"
                    expanded={isExpanded(`${c.id}/databases`)}
                    loading={tree.databases.state === 'loading'}
                    refreshing={tree.databases.state === 'refreshing'}
                    fetchedAt={tree.databases.fetchedAt}
                    onRefresh={tree.databases.state !== 'idle' ? e => refreshDatabases(c.id, c.name, e) : undefined}
                    onClick={() => toggle(`${c.id}/databases`)} />

                  {isExpanded(`${c.id}/databases`) && (tree.databases.state === 'done' || tree.databases.state === 'refreshing') && (
                    <>
                      {tree.databases.names.map(dbName => {
                        const dbKey  = `${c.id}/db/${dbName}`
                        const dbExp  = isExpanded(dbKey)
                        const schKey = `${c.id}/schemas/${dbName}`
                        const sch    = tree.schemas[dbName]
                        return (
                          <div key={dbName}>
                            <Row depth={2} icon={<FolderOpen size={11} />} label={dbName}
                              expanded={dbExp}
                              onClick={() => expandDatabase(c.id, dbName)} />

                            {dbExp && (
                              <div>
                                {/* Schemas */}
                                <Row depth={3} icon={<Folder size={11} />} label="Schemas"
                                  expanded={isExpanded(schKey)}
                                  loading={sch?.state === 'loading'}
                                  refreshing={sch?.state === 'refreshing'}
                                  fetchedAt={sch?.fetchedAt}
                                  onRefresh={sch?.state === 'done' || sch?.state === 'refreshing' ? e => refreshSchemas(c.id, dbName, e) : undefined}
                                  onClick={() => expandSchemas(c.id, dbName)} />

                                {isExpanded(schKey) && (sch?.state === 'done' || sch?.state === 'refreshing') && (() => {
                                  const sizeIdx = sizes[schemaCacheKey(c.id, dbName)]
                                  return sch.data.map(schema => {
                                  const sk = `${schKey}/${schema.schema}`
                                  const schemaSize = sizeIdx?.[schema.schema]
                                  return (
                                    <div key={sk}>
                                      <Row depth={4} icon={<Folder size={10} />} label={schema.schema}
                                        expanded={isExpanded(sk)} onClick={() => toggle(sk)}
                                        trailing={schemaSize ? formatBytes(schemaSize.total) : undefined} />
                                      {isExpanded(sk) && schema.tables.map(tbl => {
                                        const tk = `${sk}/${tbl.name}`
                                        const tblBytes = schemaSize?.byTable[tbl.name]
                                        return (
                                          <div key={tk}>
                                            <Row depth={5} icon={<Table2 size={10} />} label={tbl.name}
                                              trailing={tblBytes != null ? formatBytes(tblBytes) : undefined}
                                              onClick={() => openTab?.('table-details', `${tbl.name}`, {
                                                connectionId: c.id,
                                                connectionName: c.name,
                                                schema: schema.schema,
                                                table: tbl.name,
                                              })} />
                                          </div>
                                        )
                                      })}
                                    </div>
                                  )
                                }) })()}
                                {isExpanded(schKey) && sch?.state === 'error' && (
                                  <div style={{ paddingLeft: 8 + 3 * 12 }} className="text-[11px] text-th-err py-1">{sch.error}</div>
                                )}
                              </div>
                            )}
                          </div>
                        )
                      })}
                    </>
                  )}

                  {/* Tools — only shown when the connector supports any of them */}
                  {adminItems.length > 0 && (
                    <>
                      <Row depth={1} icon={<Shield size={11} />} label="Tools"
                        expanded={isExpanded(`${c.id}/admin`)} onClick={() => toggle(`${c.id}/admin`)} />
                      {isExpanded(`${c.id}/admin`) && adminItems.map(item => (
                        <Row key={item} depth={2} icon={<Folder size={10} />} label={item}
                          onClick={
                            item === 'Sessions' ? () => openTab?.('session-manager', `Sessions — ${c.name}`, { connectionId: c.id, connectionName: c.name })
                            : item === 'Locks'  ? () => openTab?.('lock-manager',     `Locks — ${c.name}`,     { connectionId: c.id, connectionName: c.name })
                            : undefined
                          }
                        />
                      ))}
                    </>
                  )}
                </>
              )}
            </div>
          )
        })}
      </div>

      {/* Status */}
      {status && <StatusBar status={status} />}
    </aside>
  )
}
