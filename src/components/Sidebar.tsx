import { useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { useConnections } from '@/context/ConnectionContext'
import {
  Plus, ChevronRight, ChevronDown, Plug, PlugZap, Loader2, RefreshCw,
  Table2, Database, FolderOpen, Folder, Settings,
  Shield,
} from 'lucide-react'

interface Connection { id: string; name: string; host: string; port: number; database: string }
interface ColumnInfo  { name: string; typeName: string }
interface TableInfo   { name: string; columns: ColumnInfo[] }
interface SchemaInfo  { schema: string; tables: TableInfo[] }

interface Props {
  openSettings?: (section?: string, connectionId?: string) => void
  openTab?: (type: 'session-manager' | 'lock-manager' | 'table-details', title: string, extra: Record<string, string>) => void
  width?: number
}

type LoadState = 'idle' | 'loading' | 'refreshing' | 'done' | 'error'

interface ConnectionTree {
  databases:    { names: string[]; state: LoadState; error?: string }
  schemas:      Record<string, { data: SchemaInfo[]; state: LoadState; error?: string }>
}

const ADMIN_ITEMS = ['Sessions', 'Locks', 'Jobs']

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

    // Load databases if not loaded
    const tree = treeFor(c.id)
    if (tree.databases.state === 'idle') {
      updateTree(c.id, t => ({ ...t, databases: { names: [], state: 'loading' } }))
      setStatus(`Loading databases for ${c.name}…`)
      try {
        const names = await invoke<string[]>('list_databases', { connectionId: c.id })
        updateTree(c.id, t => ({ ...t, databases: { names, state: 'done' } }))
        setStatus(`${c.name}: ${names.length} database${names.length !== 1 ? 's' : ''}`)
      } catch (e) {
        updateTree(c.id, t => ({ ...t, databases: { names: [], state: 'error', error: String(e) } }))
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
    toggle(key)
    const tree = treeFor(connId)
    if (tree.schemas[dbName]?.state === 'done') return
    updateTree(connId, t => ({ ...t, schemas: { ...t.schemas, [dbName]: { data: [], state: 'loading' } } }))
    setStatus(`Loading schemas…`)
    try {
      const data = await invoke<SchemaInfo[]>('get_schemas', { connectionId: connId })
      updateTree(connId, t => ({ ...t, schemas: { ...t.schemas, [dbName]: { data, state: 'done' } } }))
      const total = data.reduce((n, s) => n + s.tables.length, 0)
      setStatus(`${total} table${total !== 1 ? 's' : ''} loaded`)
    } catch (e) {
      updateTree(connId, t => ({ ...t, schemas: { ...t.schemas, [dbName]: { data: [], state: 'error', error: String(e) } } }))
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
      updateTree(connId, t => ({ ...t, databases: { names, state: 'done' } }))
      setStatus(`${connName}: ${names.length} database${names.length !== 1 ? 's' : ''}`)
    } catch (e) {
      updateTree(connId, t => ({ ...t, databases: { ...t.databases, state: 'error', error: String(e) } }))
      setStatus(`Error: ${String(e)}`)
    }
  }

  const refreshSchemas = async (connId: string, dbName: string, e: React.MouseEvent) => {
    e.stopPropagation()
    updateTree(connId, t => ({ ...t, schemas: { ...t.schemas, [dbName]: { ...(t.schemas[dbName] ?? { data: [] }), state: 'refreshing' } } }))
    setStatus(`Refreshing schemas…`)
    try {
      const data = await invoke<SchemaInfo[]>('get_schemas', { connectionId: connId })
      updateTree(connId, t => ({ ...t, schemas: { ...t.schemas, [dbName]: { data, state: 'done' } } }))
      const total = data.reduce((n, s) => n + s.tables.length, 0)
      setStatus(`${total} table${total !== 1 ? 's' : ''} loaded`)
    } catch (e) {
      updateTree(connId, t => ({ ...t, schemas: { ...t.schemas, [dbName]: { ...(t.schemas[connId] ?? { data: [] }), state: 'error', error: String(e) } } }))
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

  const Row = ({ depth, icon, label, expanded: exp, onClick, loading: spin, refreshing, onRefresh }: {
    depth: number; icon: React.ReactNode; label: string
    expanded?: boolean; onClick?: () => void; loading?: boolean
    refreshing?: boolean; onRefresh?: (e: React.MouseEvent) => void
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
        {onRefresh && hovered && (
          <button
            onClick={onRefresh}
            title="Refresh"
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
                  <span className="text-[10px] text-th-dim truncate">{c.host}:{c.port}</span>
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
                    onRefresh={tree.databases.state !== 'idle' ? e => refreshDatabases(c.id, c.name, e) : undefined}
                    onClick={() => toggle(`${c.id}/databases`)} />

                  {isExpanded(`${c.id}/databases`) && tree.databases.state === 'done' && (
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
                                  onRefresh={sch?.state === 'done' || sch?.state === 'refreshing' ? e => refreshSchemas(c.id, dbName, e) : undefined}
                                  onClick={() => expandSchemas(c.id, dbName)} />

                                {isExpanded(schKey) && sch?.state === 'done' && sch.data.map(schema => {
                                  const sk = `${schKey}/${schema.schema}`
                                  return (
                                    <div key={sk}>
                                      <Row depth={4} icon={<Folder size={10} />} label={schema.schema}
                                        expanded={isExpanded(sk)} onClick={() => toggle(sk)} />
                                      {isExpanded(sk) && schema.tables.map(tbl => {
                                        const tk = `${sk}/${tbl.name}`
                                        return (
                                          <div key={tk}>
                                            <Row depth={5} icon={<Table2 size={10} />} label={tbl.name}
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
                                })}
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

                  {/* Tools */}
                  <Row depth={1} icon={<Shield size={11} />} label="Tools"
                    expanded={isExpanded(`${c.id}/admin`)} onClick={() => toggle(`${c.id}/admin`)} />
                  {isExpanded(`${c.id}/admin`) && ADMIN_ITEMS.map(item => (
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
            </div>
          )
        })}
      </div>

      {/* Status */}
      {status && <StatusBar status={status} />}
    </aside>
  )
}
