import { useState, useEffect } from 'react'
import { useMcp } from '@/hooks/useMcp'
import { useConnections } from '@/context/ConnectionContext'

export default function McpSection() {
  const { status, flags, setGlobalPrompt, setConnNote, setPort } = useMcp()
  const { connections } = useConnections()

  return (
    <div className="flex flex-col h-full overflow-y-auto">
      <div style={{ padding: '16px 20px 12px', borderBottom: '1px solid var(--border)' }}>
        <p className="text-[15px] font-semibold text-th-bright">MCP Server</p>
      </div>

      <div style={{ padding: '16px 20px' }} className="flex flex-col gap-6">
        <Field label="Global server prompt" description="Sent to every client as initialize.instructions.">
          <Editor value={status?.global_prompt ?? ''} onSave={setGlobalPrompt} rows={4}
            placeholder="DBs of company X. Prefer read queries. Confirm before destructive writes…" />
        </Field>

        <Field label="Default port" description="Port the local MCP server binds (127.0.0.1).">
          <PortInput value={status?.port ?? 7300} onSave={setPort} />
        </Field>

        <Field label="Per-connection notes" description="Shown to the agent in list_connections / describe_table.">
          <div className="flex flex-col gap-3">
            {connections.length === 0 && <p className="text-[12px] text-th-dim">No connections.</p>}
            {connections.map(c => (
              <div key={c.id} className="flex flex-col gap-1">
                <span className="text-[12px] text-th-text">{c.name}{flags[c.id]?.expose ? '' : ' (not exposed)'}</span>
                <Editor value={flags[c.id]?.note ?? ''} onSave={v => setConnNote(c.id, v)} rows={2}
                  placeholder="note for the agent…" />
              </div>
            ))}
          </div>
        </Field>
      </div>
    </div>
  )
}

function Field({ label, description, children }: { label: string; description?: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-[13px] text-th-text">{label}</span>
      {description && <span className="text-[11px] text-th-dim">{description}</span>}
      {children}
    </div>
  )
}

function Editor({ value, onSave, rows, placeholder }: { value: string; onSave: (v: string) => void; rows: number; placeholder: string }) {
  const [draft, setDraft] = useState(value)
  useEffect(() => { setDraft(value) }, [value])
  return (
    <textarea
      value={draft}
      rows={rows}
      placeholder={placeholder}
      onChange={e => setDraft(e.target.value)}
      onBlur={() => { if (draft !== value) onSave(draft) }}
      className="w-full text-[12px] rounded px-2 py-1.5 outline-none resize-none"
      style={{ background: 'var(--sidebar-bg)', border: '1px solid var(--border)', color: 'var(--text)' }}
    />
  )
}

function PortInput({ value, onSave }: { value: number; onSave: (v: number) => void }) {
  const [draft, setDraft] = useState(String(value))
  useEffect(() => { setDraft(String(value)) }, [value])
  return (
    <input
      value={draft}
      inputMode="numeric"
      onChange={e => setDraft(e.target.value.replace(/[^0-9]/g, ''))}
      onBlur={() => { const n = Number(draft); if (n > 0 && n < 65536 && n !== value) onSave(n) }}
      className="w-28 text-[12px] rounded px-2 py-1.5 outline-none"
      style={{ background: 'var(--sidebar-bg)', border: '1px solid var(--border)', color: 'var(--text)' }}
    />
  )
}
