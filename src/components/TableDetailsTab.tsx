import { useState, useEffect } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { Loader2, XCircle, Key, Link, Table2, Code2, Info, Database } from 'lucide-react'
import ResultTable from '@/components/ResultTable'
import { useTableData } from '@/hooks/useTableData'
import { driverToDialect } from '@/lib/queryBuilder'
import type { ResultTab } from '@/lib/results'

interface ColumnDetail { ordinal: number; name: string; dataType: string; nullable: boolean; defaultVal?: string; comment?: string; isPk: boolean; isUnique: boolean }
interface ConstraintDetail { name: string; kind: string; columns: string[]; definition: string }
interface ForeignKeyDetail { name: string; columns: string[]; refSchema: string; refTable: string; refColumns: string[]; onDelete: string; onUpdate: string }
interface IndexDetail { name: string; unique: boolean; columns: string[]; definition: string }
interface TableProperties { oid: number; owner: string; tablespace?: string; comment?: string; rowCount?: number; sizePretty?: string; hasRls: boolean }
interface TableDetails { schema: string; table: string; properties: TableProperties; columns: ColumnDetail[]; constraints: ConstraintDetail[]; foreignKeys: ForeignKeyDetail[]; indexes: IndexDetail[]; ddl: string }

type Section = 'columns' | 'constraints' | 'foreign_keys' | 'indexes' | 'ddl' | 'properties' | 'data'

const SECTIONS: { id: Section; label: string; icon: React.ReactNode }[] = [
  { id: 'properties',   label: 'Properties',   icon: <Info size={13} /> },
  { id: 'columns',      label: 'Columns',       icon: <Table2 size={13} /> },
  { id: 'data',         label: 'Data',          icon: <Database size={13} /> },
  { id: 'constraints',  label: 'Constraints',   icon: <Key size={13} /> },
  { id: 'foreign_keys', label: 'Foreign Keys',  icon: <Link size={13} /> },
  { id: 'indexes',      label: 'Indexes',       icon: <Table2 size={13} /> },
  { id: 'ddl',          label: 'DDL',           icon: <Code2 size={13} /> },
]

interface Props { connectionId: string; schema: string; table: string; driver?: string }

export default function TableDetailsTab({ connectionId, schema, table, driver }: Props) {
  const [details, setDetails] = useState<TableDetails | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError]     = useState<string | null>(null)
  const [section, setSection] = useState<Section>('columns')

  useEffect(() => {
    setLoading(true); setError(null)
    invoke<TableDetails>('get_table_details', { connectionId, schema, table })
      .then(d => { setDetails(d); setLoading(false) })
      .catch(e => { setError(String(e)); setLoading(false) })
  }, [connectionId, schema, table])

  if (loading) return <div className="flex items-center justify-center flex-1 gap-2 text-th-dim"><Loader2 size={16} className="animate-spin" />Loading…</div>
  if (error)   return <div className="flex items-center justify-center flex-1 gap-2" style={{ color: 'var(--error-text)' }}><XCircle size={16} />{error}</div>
  if (!details) return null

  return (
    <div className="flex h-full overflow-hidden bg-th-bg">
      {/* Section sidebar */}
      <div className="flex flex-col w-40 shrink-0 overflow-y-auto" style={{ borderRight: '1px solid var(--border)', background: 'var(--sidebar-bg)' }}>
        <div style={{ padding: '10px 12px 6px', borderBottom: '1px solid var(--border)' }}>
          <p className="text-[11px] font-semibold text-th-dim truncate">{details.schema}.{details.table}</p>
          {details.properties.sizePretty && <p className="text-[10px] text-th-dim">{details.properties.sizePretty}</p>}
        </div>
        {SECTIONS.map(s => (
          <button key={s.id} onClick={() => setSection(s.id)}
            className="flex items-center gap-2 text-left text-[13px] transition-colors"
            style={{
              padding: '6px 12px',
              borderLeft: s.id === section ? '2px solid var(--tab-accent)' : '2px solid transparent',
              background: s.id === section ? 'var(--hover)' : 'transparent',
              color: s.id === section ? 'var(--text-bright)' : 'var(--text)',
            }}>
            <span style={{ color: 'var(--text-dim)', flexShrink: 0 }}>{s.icon}</span>
            {s.label}
          </button>
        ))}
      </div>

      {/* Section content */}
      <div className="flex flex-col flex-1 min-w-0 overflow-hidden">
        {section === 'properties' && <PropertiesSection p={details.properties} />}
        {section === 'columns'     && <ColumnsSection cols={details.columns} />}
        {section === 'data'        && <TableDataSection connectionId={connectionId} schema={details.schema} table={details.table} driver={driver} foreignKeys={details.foreignKeys} />}
        {section === 'constraints' && <ConstraintsSection items={details.constraints} />}
        {section === 'foreign_keys'&& <ForeignKeysSection items={details.foreignKeys} />}
        {section === 'indexes'     && <IndexesSection items={details.indexes} />}
        {section === 'ddl'         && <DdlSection ddl={details.ddl} />}
      </div>
    </div>
  )
}

// ── Section components ───────────────────────────────────────────────────────

function SectionHeader({ children }: { children: React.ReactNode }) {
  return <div className="px-4 py-2 text-[11px] font-semibold tracking-widest uppercase text-th-dim shrink-0" style={{ borderBottom: '1px solid var(--border)', background: 'var(--sidebar-bg)' }}>{children}</div>
}

function PropertiesSection({ p }: { p: TableProperties }) {
  const rows = [
    ['Object ID', String(p.oid)], ['Owner', p.owner],
    ['Tablespace', p.tablespace ?? 'pg_default'],
    ['Row Count (est.)', p.rowCount != null ? p.rowCount.toLocaleString() : '—'],
    ['Size', p.sizePretty ?? '—'],
    ['Row-Level Security', p.hasRls ? 'Enabled' : 'Disabled'],
    ...(p.comment ? [['Comment', p.comment]] : []),
  ]
  return (
    <div className="flex flex-col overflow-auto flex-1">
      <SectionHeader>Properties</SectionHeader>
      <table className="text-[12px]" style={{ borderCollapse: 'collapse' }}>
        <tbody>
          {rows.map(([k, v]) => (
            <tr key={k} style={{ borderBottom: '1px solid var(--border)' }}>
              <td className="px-4 py-2 text-th-dim font-medium" style={{ width: 160, borderRight: '1px solid var(--border)' }}>{k}</td>
              <td className="px-4 py-2 text-th-text">{v}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function ColumnsSection({ cols }: { cols: ColumnDetail[] }) {
  return (
    <div className="flex flex-col overflow-hidden flex-1">
      <SectionHeader>{cols.length} column{cols.length !== 1 ? 's' : ''}</SectionHeader>
      <div className="overflow-auto flex-1">
        <table className="text-[12px] w-full" style={{ borderCollapse: 'collapse' }}>
          <thead style={{ position: 'sticky', top: 0, background: 'var(--sidebar-bg)', zIndex: 1 }}>
            <tr>{['#','Name','Type','Nullable','Default','Flags','Comment'].map(h => (
              <th key={h} className="px-3 py-2 text-left text-[11px] font-semibold text-th-dim" style={{ borderBottom: '1px solid var(--border)', borderRight: '1px solid var(--border)', whiteSpace: 'nowrap' }}>{h}</th>
            ))}</tr>
          </thead>
          <tbody>
            {cols.map(c => (
              <tr key={c.name} style={{ borderBottom: '1px solid var(--border)' }} className="hover:bg-th-hover transition-colors">
                <td className="px-3 py-1.5 text-th-dim" style={{ borderRight: '1px solid var(--border)' }}>{c.ordinal}</td>
                <td className="px-3 py-1.5 font-medium text-th-bright" style={{ borderRight: '1px solid var(--border)' }}>{c.name}</td>
                <td className="px-3 py-1.5 text-th-dim font-mono" style={{ borderRight: '1px solid var(--border)' }}>{c.dataType}</td>
                <td className="px-3 py-1.5 text-center" style={{ borderRight: '1px solid var(--border)', color: c.nullable ? 'var(--text-dim)' : '#22c55e' }}>{c.nullable ? '✓' : '✗'}</td>
                <td className="px-3 py-1.5 text-th-dim font-mono text-[11px]" style={{ borderRight: '1px solid var(--border)' }}>{c.defaultVal ?? ''}</td>
                <td className="px-3 py-1.5" style={{ borderRight: '1px solid var(--border)' }}>
                  {c.isPk   && <span className="text-[10px] px-1 py-0.5 rounded mr-1" style={{ background: '#92400e', color: '#fbbf24' }}>PK</span>}
                  {c.isUnique && !c.isPk && <span className="text-[10px] px-1 py-0.5 rounded" style={{ background: '#1e3a5f', color: '#60a5fa' }}>UQ</span>}
                </td>
                <td className="px-3 py-1.5 text-th-dim text-[11px]">{c.comment ?? ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function ConstraintsSection({ items }: { items: ConstraintDetail[] }) {
  return (
    <div className="flex flex-col overflow-hidden flex-1">
      <SectionHeader>{items.length} constraint{items.length !== 1 ? 's' : ''}</SectionHeader>
      <div className="overflow-auto flex-1">
        <table className="text-[12px] w-full" style={{ borderCollapse: 'collapse' }}>
          <thead style={{ position: 'sticky', top: 0, background: 'var(--sidebar-bg)', zIndex: 1 }}>
            <tr>{['Name','Type','Columns','Definition'].map(h => (
              <th key={h} className="px-3 py-2 text-left text-[11px] font-semibold text-th-dim" style={{ borderBottom: '1px solid var(--border)', borderRight: '1px solid var(--border)' }}>{h}</th>
            ))}</tr>
          </thead>
          <tbody>
            {items.map(c => (
              <tr key={c.name} style={{ borderBottom: '1px solid var(--border)' }} className="hover:bg-th-hover transition-colors">
                <td className="px-3 py-1.5 text-th-bright font-medium" style={{ borderRight: '1px solid var(--border)' }}>{c.name}</td>
                <td className="px-3 py-1.5 text-th-dim" style={{ borderRight: '1px solid var(--border)' }}>{c.kind}</td>
                <td className="px-3 py-1.5 font-mono text-[11px] text-th-dim" style={{ borderRight: '1px solid var(--border)' }}>{c.columns.join(', ')}</td>
                <td className="px-3 py-1.5 font-mono text-[11px] text-th-text">{c.definition}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function ForeignKeysSection({ items }: { items: ForeignKeyDetail[] }) {
  return (
    <div className="flex flex-col overflow-hidden flex-1">
      <SectionHeader>{items.length} foreign key{items.length !== 1 ? 's' : ''}</SectionHeader>
      <div className="overflow-auto flex-1">
        <table className="text-[12px] w-full" style={{ borderCollapse: 'collapse' }}>
          <thead style={{ position: 'sticky', top: 0, background: 'var(--sidebar-bg)', zIndex: 1 }}>
            <tr>{['Name','Columns','References','On Delete','On Update'].map(h => (
              <th key={h} className="px-3 py-2 text-left text-[11px] font-semibold text-th-dim" style={{ borderBottom: '1px solid var(--border)', borderRight: '1px solid var(--border)' }}>{h}</th>
            ))}</tr>
          </thead>
          <tbody>
            {items.map(fk => (
              <tr key={fk.name} style={{ borderBottom: '1px solid var(--border)' }} className="hover:bg-th-hover transition-colors">
                <td className="px-3 py-1.5 text-th-bright font-medium" style={{ borderRight: '1px solid var(--border)' }}>{fk.name}</td>
                <td className="px-3 py-1.5 font-mono text-[11px] text-th-dim" style={{ borderRight: '1px solid var(--border)' }}>{fk.columns.join(', ')}</td>
                <td className="px-3 py-1.5 text-th-text text-[11px]" style={{ borderRight: '1px solid var(--border)' }}>{fk.refSchema}.{fk.refTable}({fk.refColumns.join(', ')})</td>
                <td className="px-3 py-1.5 text-th-dim" style={{ borderRight: '1px solid var(--border)' }}>{fk.onDelete}</td>
                <td className="px-3 py-1.5 text-th-dim">{fk.onUpdate}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function IndexesSection({ items }: { items: IndexDetail[] }) {
  return (
    <div className="flex flex-col overflow-hidden flex-1">
      <SectionHeader>{items.length} index{items.length !== 1 ? 'es' : ''}</SectionHeader>
      <div className="overflow-auto flex-1">
        <table className="text-[12px] w-full" style={{ borderCollapse: 'collapse' }}>
          <thead style={{ position: 'sticky', top: 0, background: 'var(--sidebar-bg)', zIndex: 1 }}>
            <tr>{['Name','Unique','Columns','Definition'].map(h => (
              <th key={h} className="px-3 py-2 text-left text-[11px] font-semibold text-th-dim" style={{ borderBottom: '1px solid var(--border)', borderRight: '1px solid var(--border)' }}>{h}</th>
            ))}</tr>
          </thead>
          <tbody>
            {items.map(idx => (
              <tr key={idx.name} style={{ borderBottom: '1px solid var(--border)' }} className="hover:bg-th-hover transition-colors">
                <td className="px-3 py-1.5 text-th-bright font-medium" style={{ borderRight: '1px solid var(--border)' }}>{idx.name}</td>
                <td className="px-3 py-1.5 text-center" style={{ borderRight: '1px solid var(--border)', color: idx.unique ? '#22c55e' : 'var(--text-dim)' }}>{idx.unique ? '✓' : '—'}</td>
                <td className="px-3 py-1.5 font-mono text-[11px] text-th-dim" style={{ borderRight: '1px solid var(--border)' }}>{idx.columns.join(', ')}</td>
                <td className="px-3 py-1.5 font-mono text-[11px] text-th-text">{idx.definition}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function DdlSection({ ddl }: { ddl: string }) {
  return (
    <div className="flex flex-col overflow-hidden flex-1">
      <SectionHeader>DDL</SectionHeader>
      <div className="overflow-auto flex-1 p-4">
        <pre className="text-[13px] text-th-text" style={{ fontFamily: "'Cascadia Code', 'JetBrains Mono', Consolas, monospace" }}>{ddl}</pre>
      </div>
    </div>
  )
}

function TableDataSection({ connectionId, schema, table, driver, foreignKeys }: {
  connectionId: string; schema: string; table: string; driver?: string; foreignKeys: ForeignKeyDetail[]
}) {
  const td = useTableData(connectionId, schema, table, driverToDialect(driver), 200)

  // Lazy: fetch the first time this section mounts.
  useEffect(() => { td.load() }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // FK affordances derived from the table's own foreign keys.
  const fkColumns = new Set<string>()
  const fkRefs    = new Map<string, { table: string; col: string }>()
  for (const fk of foreignKeys) {
    fk.columns.forEach((c, i) => {
      fkColumns.add(c)
      if (!fkRefs.has(c)) fkRefs.set(c, { table: `${fk.refSchema}.${fk.refTable}`, col: fk.refColumns[i] ?? fk.refColumns[0] })
    })
  }

  const s = td.state
  if (s.running && !s.data) return <div className="flex items-center justify-center flex-1 gap-2 text-th-dim"><Loader2 size={16} className="animate-spin" />Loading…</div>
  if (s.error)   return <div className="flex items-center justify-center flex-1 gap-2" style={{ color: 'var(--error-text)' }}><XCircle size={16} />{s.error}</div>
  if (!s.data)   return null

  const tab: ResultTab = {
    id: 'tbl-data', title: `${s.schema}.${s.table}`, data: s.data,
    sortCol: s.sort?.col, sortDir: s.sort?.dir,
    colFilters: Object.fromEntries(s.filters.map(f => [f.col, f.value])),
    colFilterOps: Object.fromEntries(s.filters.map(f => [f.col, f.op])),
    offset: s.offset, hasMore: s.hasMore, loadingMore: s.loadingMore,
    history: s.history.length ? [{}] : undefined, // non-empty → grid shows the Back button
  }

  return (
    <div className="flex flex-col flex-1 min-w-0 overflow-hidden">
      <div className="px-4 py-1.5 text-[11px] text-th-dim shrink-0 flex items-center gap-2" style={{ borderBottom: '1px solid var(--border)', background: 'var(--sidebar-bg)' }}>
        <span className="font-semibold">{s.schema}.{s.table}</span>
        <span>{s.data.rows.length} row{s.data.rows.length !== 1 ? 's' : ''}{s.hasMore ? '+' : ''}</span>
      </div>
      <ResultTable
        result={s.data}
        tab={tab}
        fkColumns={fkColumns}
        fkRefs={fkRefs}
        onSort={(col, dir) => td.setSort(col, dir)}
        onColumnFilter={(col, value, op) => td.setFilter(col, value, op)}
        onFkClick={(refTable, refCol, value) => td.fkClick(refTable, refCol, value)}
        onBack={() => td.back()}
        onLoadMore={() => td.loadMore()}
      />
    </div>
  )
}
