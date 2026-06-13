import { useState, useEffect } from 'react'
import { Copy, RefreshCw, Check, Loader2 } from 'lucide-react'
import { useMcp } from '@/hooks/useMcp'
import { useConnections } from '@/context/ConnectionContext'

export default function McpPanel({ width = 224 }: { width?: number }) {
  const { status, token, clients, flags, activity, refresh, start, stop, rotate, setAutostart, setupClient, setConnFlags, setGlobalPrompt, setConnNote } = useMcp()
  const { connections } = useConnections()
  const [copied, setCopied] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [installing, setInstalling] = useState<string | null>(null) // client id being (re)installed

  const doSetup = async (id: string) => {
    setInstalling(id)
    try { await setupClient(id) }
    catch (e) { setErr(String(e).replace(/^.*Error: /, '')); setTimeout(() => setErr(null), 4000) }
    finally { setInstalling(null) }
  }

  const copy = (key: string, text: string) => {
    navigator.clipboard.writeText(text)
      .then(() => { setCopied(key); setTimeout(() => setCopied(null), 1200) })
      .catch(() => {})
  }
  const running = !!status?.running

  return (
    <aside className="flex flex-col shrink-0 overflow-hidden bg-th-sidebar" style={{ width, borderRight: '1px solid var(--border)' }}>
      <div className="px-3 py-2 flex items-center justify-between shrink-0" style={{ borderBottom: '1px solid var(--border)' }}>
        <div className="flex items-center gap-1.5">
          <span className="w-2 h-2 rounded-full" style={{ background: running ? '#22c55e' : 'var(--text-dim)' }} />
          <span className="text-[11px] font-semibold tracking-[0.1em] uppercase text-th-dim">MCP Server</span>
        </div>
        <button onClick={() => (running ? stop() : start())}
          className="text-[11px] px-2 py-0.5 rounded transition-colors"
          style={{ background: running ? 'var(--hover)' : 'var(--tab-accent)', color: running ? 'var(--text)' : '#fff' }}>
          {running ? 'On' : 'Off'}
        </button>
      </div>

      <div className="overflow-y-auto flex-1">
        {/* Endpoint */}
        <div className="px-3 py-2" style={{ borderBottom: '1px solid var(--border)' }}>
          <Row label={status?.url ?? ''} onCopy={() => status && copy('url', status.url)} copied={copied === 'url'} />
          {token && (
            <Row label={`token  ${token.slice(0, 12)}…`} onCopy={() => copy('tok', token)} copied={copied === 'tok'}
              extra={<button title="Rotate token" onClick={() => rotate()} className="text-th-dim hover:text-th-accent shrink-0"><RefreshCw size={11} /></button>} />
          )}
          <label className="flex items-center gap-1.5 mt-1 text-[11px] text-th-dim cursor-pointer">
            <input type="checkbox" checked={!!status?.autostart} onChange={e => setAutostart(e.target.checked)} />
            Start on launch
          </label>
        </div>

        {err && <div className="px-3 py-1 text-[10px]" style={{ color: 'var(--error-text, #f87171)' }}>{err}</div>}

        {/* Server prompt */}
        <Section title="Server prompt">
          <div className="px-3 py-1.5">
            <NoteField
              value={status?.global_prompt ?? ''}
              placeholder="Context for every client (initialize.instructions)…"
              onSave={setGlobalPrompt}
              multiline
            />
          </div>
        </Section>

        {/* Setup */}
        <Section title="Setup">
          {clients.map(c => {
            const busy = installing === c.id
            return (
            <div key={c.id} className="flex items-center gap-2 px-3 py-1 text-[12px]">
              <span className="flex-1 truncate" style={{ color: c.detected ? 'var(--text)' : 'var(--text-dim)' }}>{c.name}</span>
              {busy
                ? <span className="flex items-center gap-1 text-[10px] text-th-dim"><Loader2 size={11} className="animate-spin" />installing…</span>
                : c.installed
                ? <>
                    <span className="text-[10px] text-th-dim">installed</span>
                    <button onClick={() => doSetup(c.id)} title="Reinstall (re-apply current token)" className="text-[11px] text-th-accent hover:underline">Reinstall</button>
                  </>
                : c.can_setup
                ? <button onClick={() => doSetup(c.id)} className="text-[11px] text-th-accent hover:underline">Set up</button>
                : <span className="text-[10px] text-th-dim">copy only</span>}
            </div>
            )
          })}
        </Section>

        {/* Connections */}
        <Section title="Connections">
          {connections.length === 0 && <p className="px-3 py-1.5 text-[11px] text-th-dim">No connections.</p>}
          {connections.map(c => {
            const f = flags[c.id] ?? { expose: false, allow_write: false, note: '' }
            return (
              <div key={c.id} className="flex flex-col gap-1 px-3 py-1.5" style={{ borderBottom: '1px solid var(--border)' }}>
                <div className="flex items-center gap-2 text-[12px]">
                  <label className="flex items-center gap-1 text-[11px] text-th-dim cursor-pointer">
                    <input type="checkbox" checked={f.expose}
                      onChange={e => setConnFlags(c.id, e.target.checked, e.target.checked ? f.allow_write : false)} />
                    expose
                  </label>
                  <label className="flex items-center gap-1 text-[11px] text-th-dim cursor-pointer" style={{ opacity: f.expose ? 1 : 0.4 }}>
                    <input type="checkbox" disabled={!f.expose} checked={f.allow_write}
                      onChange={e => setConnFlags(c.id, f.expose, e.target.checked)} />
                    write
                  </label>
                  <span className="flex-1 truncate text-right" style={{ color: 'var(--text)' }}>{c.name}</span>
                </div>
                {f.expose && (
                  <NoteField value={f.note ?? ''} placeholder="note for the agent…" onSave={v => setConnNote(c.id, v)} />
                )}
              </div>
            )
          })}
        </Section>

        {/* Activity */}
        <Section title="Activity" action={
          <button title="Refresh" onClick={() => refresh()} className="text-th-dim hover:text-th-accent"><RefreshCw size={11} /></button>
        }>
          {activity.length === 0 && <p className="px-3 py-1.5 text-[11px] text-th-dim">No tool calls yet.</p>}
          {activity.map((a, i) => (
            <div key={`${a.at}-${i}`} className="flex items-center gap-2 px-3 py-0.5 text-[11px]">
              <span className="font-mono text-th-dim shrink-0 tabular-nums">{fmtTime(a.at)}</span>
              <span className="shrink-0" style={{ color: 'var(--tab-accent)' }}>{a.tool}</span>
              {a.connection && <span className="text-th-dim truncate">{a.connection}</span>}
              <span className="flex-1 truncate text-right text-th-dim">{a.summary}</span>
            </div>
          ))}
        </Section>
      </div>
    </aside>
  )
}

function NoteField({ value, placeholder, onSave, multiline }: {
  value: string; placeholder: string; onSave: (v: string) => void; multiline?: boolean
}) {
  const [draft, setDraft] = useState(value)
  useEffect(() => { setDraft(value) }, [value])
  const commit = () => { if (draft !== value) onSave(draft) }
  const common = {
    value: draft,
    placeholder,
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setDraft(e.target.value),
    onBlur: commit,
    className: 'w-full text-[11px] rounded px-1.5 py-1 outline-none resize-none',
    style: { background: 'var(--sidebar-bg)', border: '1px solid var(--border)', color: 'var(--text)' },
  }
  return multiline
    ? <textarea {...common} rows={2} />
    : <input {...common} onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }} />
}

function fmtTime(ms: number): string {
  const d = new Date(ms)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`
}

function Section({ title, action, children }: { title: string; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div style={{ borderBottom: '1px solid var(--border)' }}>
      <div className="px-3 py-1.5 flex items-center justify-between">
        <span className="text-[10px] font-semibold tracking-widest uppercase text-th-dim">{title}</span>
        {action}
      </div>
      {children}
    </div>
  )
}

function Row({ label, onCopy, copied, extra }: { label: string; onCopy: () => void; copied: boolean; extra?: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2 py-0.5">
      <span className="flex-1 truncate text-[11px] font-mono text-th-dim">{label}</span>
      {extra}
      <button onClick={onCopy} className="text-th-dim hover:text-th-accent shrink-0">{copied ? <Check size={11} /> : <Copy size={11} />}</button>
    </div>
  )
}
