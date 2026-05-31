import { useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { Loader2, XCircle, Table2, Eye, Layers, FunctionSquare, Hash } from 'lucide-react'
import { descriptorFor } from '@/connectors/registry'
import type { SchemaObjectKind } from '@/connectors/types'
import { useCachedResource } from '@/hooks/useCachedResource'
import CacheFooter from '@/components/CacheFooter'

interface ObjectSummary { name: string; detail?: string }
interface SchemaDetails {
  schema: string
  tables: ObjectSummary[]
  views: ObjectSummary[]
  materializedViews: ObjectSummary[]
  functions: ObjectSummary[]
  sequences: ObjectSummary[]
}

interface Props {
  connectionId: string
  schema: string
  driver?: string
  onOpenTable: (schema: string, table: string) => void
}

const KIND_META: Record<SchemaObjectKind, { label: string; icon: React.ReactNode; field: keyof Omit<SchemaDetails, 'schema'> }> = {
  tables:            { label: 'Tables',             icon: <Table2 size={13} />,         field: 'tables' },
  views:             { label: 'Views',              icon: <Eye size={13} />,            field: 'views' },
  materializedViews: { label: 'Materialized Views', icon: <Layers size={13} />,         field: 'materializedViews' },
  functions:         { label: 'Functions',          icon: <FunctionSquare size={13} />, field: 'functions' },
  sequences:         { label: 'Sequences',          icon: <Hash size={13} />,           field: 'sequences' },
}

export default function SchemaDetailsTab({ connectionId, schema, driver, onOpenTable }: Props) {
  const { data: details, loading, error, refreshing, staleError, fetchedAt, refresh } =
    useCachedResource<SchemaDetails>({
      namespace: 'schema-details',
      key: connectionId ? `${connectionId}:${schema}` : null,
      fetcher: () => invoke<SchemaDetails>('get_schema_details', { connectionId, schema }),
    })

  const kinds = descriptorFor(driver).schemaObjectKinds
  const [section, setSection] = useState<SchemaObjectKind>(kinds[0] ?? 'tables')

  // Spinner only on a cold load (no cached data yet); errors are fatal only when
  // there is nothing to show.
  if (loading && !details) return <div className="flex items-center justify-center flex-1 gap-2 text-th-dim"><Loader2 size={16} className="animate-spin" />Loading…</div>
  if (error && !details)   return <div className="flex items-center justify-center flex-1 gap-2" style={{ color: 'var(--error-text)' }}><XCircle size={16} />{error}</div>
  if (!details) return null

  const items = details[KIND_META[section].field] as ObjectSummary[]

  return (
    <div className="flex h-full overflow-hidden bg-th-bg">
      {/* Section sidebar */}
      <div className="flex flex-col w-44 shrink-0 overflow-y-auto" style={{ borderRight: '1px solid var(--border)', background: 'var(--sidebar-bg)' }}>
        <div style={{ padding: '10px 12px 6px', borderBottom: '1px solid var(--border)' }}>
          <p className="text-[11px] font-semibold text-th-dim truncate">{details.schema}</p>
        </div>
        {kinds.map(k => {
          const count = (details[KIND_META[k].field] as ObjectSummary[]).length
          return (
            <button key={k} onClick={() => setSection(k)}
              className="flex items-center gap-2 text-left text-[13px] transition-colors"
              style={{
                padding: '6px 12px',
                borderLeft: k === section ? '2px solid var(--tab-accent)' : '2px solid transparent',
                background: k === section ? 'var(--hover)' : 'transparent',
                color: k === section ? 'var(--text-bright)' : 'var(--text)',
              }}>
              <span style={{ color: 'var(--text-dim)', flexShrink: 0 }}>{KIND_META[k].icon}</span>
              {KIND_META[k].label}
              <span className="ml-auto text-[10px] text-th-dim">{count}</span>
            </button>
          )
        })}
      </div>

      {/* Section content */}
      <div className="flex flex-col flex-1 min-w-0 overflow-hidden">
        <div className="px-4 py-2 text-[11px] font-semibold tracking-widest uppercase text-th-dim shrink-0" style={{ borderBottom: '1px solid var(--border)', background: 'var(--sidebar-bg)' }}>
          {items.length} {KIND_META[section].label.toLowerCase()}
        </div>
        <div className="overflow-auto flex-1">
          <table className="text-[12px] w-full" style={{ borderCollapse: 'collapse' }}>
            <tbody>
              {items.map(o => {
                const clickable = section === 'tables'
                return (
                  <tr key={o.name}
                    onClick={clickable ? () => onOpenTable(details.schema, o.name) : undefined}
                    style={{ borderBottom: '1px solid var(--border)', cursor: clickable ? 'pointer' : 'default' }}
                    className="hover:bg-th-hover transition-colors">
                    <td className="px-4 py-1.5 font-medium text-th-bright">{o.name}</td>
                    <td className="px-4 py-1.5 text-th-dim text-[11px] text-right">{o.detail ?? ''}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
        <CacheFooter fetchedAt={fetchedAt} refreshing={refreshing} staleError={staleError} onRefresh={refresh} />
      </div>
    </div>
  )
}
