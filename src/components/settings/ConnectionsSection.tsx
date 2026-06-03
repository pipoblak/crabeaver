import { useState, useEffect, useCallback, useRef } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { Plus, Trash2, Plug, PlugZap, Loader2, CheckCircle, XCircle, Fingerprint } from 'lucide-react'
import { CONNECTORS, descriptorFor } from '@/connectors/registry'
import { cacheGet, cacheSet, cacheDelete } from '@/lib/cache'

interface Connection {
  id:         string
  name:       string
  driver:     string
  host:       string
  port:       number
  database:   string
  username:   string
  sslMode:    string
  createdAt:  string
}

const EMPTY = {
  name: '', driver: 'postgres', host: 'localhost',
  port: 5432, database: '', username: '', password: '', sslMode: 'prefer',
}

export default function ConnectionsSection({ initialConnectionId }: { initialConnectionId?: string }) {
  const [connections, setConnections] = useState<Connection[]>([])
  const [selected, setSelected]       = useState<Connection | null>(null)
  const [form, setForm]               = useState({ ...EMPTY })
  const [isNew, setIsNew]             = useState(false)
  const [testing, setTesting]         = useState(false)
  const [testResult, setTestResult]   = useState<{ ok: boolean; msg: string } | null>(null)
  const [saving, setSaving]           = useState(false)
  const [bioStatus, setBioStatus]     = useState<string | null>(null)
  const [connectedIds, setConnected]  = useState(new Set<string>())
  const [toast, setToast]             = useState<{ ok: boolean; msg: string } | null>(null)
  const [pwdSaved, setPwdSaved]       = useState(true)
  const toastTimer                    = useRef<ReturnType<typeof setTimeout> | null>(null)

  const showToast = (ok: boolean, msg: string) => {
    if (toastTimer.current) clearTimeout(toastTimer.current)
    setToast({ ok, msg })
    toastTimer.current = setTimeout(() => setToast(null), 3000)
  }

  const loadConnections = useCallback(async () => {
    const list = await invoke<Connection[]>('list_connections').catch(() => [])
    setConnections(list)
    if (initialConnectionId) {
      const target = list.find(c => c.id === initialConnectionId)
      if (target) selectConnection(target)
    }
    const statuses = await Promise.all(
      list.map(c => invoke<boolean>('connection_status', { id: c.id }).catch(() => false))
    )
    setConnected(new Set(list.filter((_, i) => statuses[i]).map(c => c.id)))
  }, [])

  useEffect(() => { loadConnections() }, [loadConnections])

  const newConnection = () => {
    setSelected(null)
    setForm({ ...EMPTY })
    setIsNew(true)
    setTestResult(null)
    setPwdSaved(true)
  }

  const selectConnection = (c: Connection) => {
    setSelected(c)
    setForm({ name: c.name, driver: c.driver, host: c.host, port: c.port,
              database: c.database, username: c.username, password: '', sslMode: c.sslMode })
    setIsNew(false)
    setTestResult(null)
    setBioStatus(null)
    // Seed from cache for an instant answer, then refresh in the background.
    const cachedPwd = cacheGet<boolean>('has-password', c.id)
    if (cachedPwd) setPwdSaved(cachedPwd.data)
    invoke<boolean>('has_password', { id: c.id })
      .then(v => { setPwdSaved(v); cacheSet('has-password', c.id, v) })
      .catch(() => setPwdSaved(false))
  }

  const testConnection = async () => {
    setTesting(true); setTestResult(null)
    try {
      const { password, ...connFields } = form
      const msg = await invoke<string>('test_connection', {
        conn: { ...connFields, id: selected?.id ?? '', createdAt: '' },
        password: password || null,
      })
      setTestResult({ ok: true, msg })
    } catch (e) {
      setTestResult({ ok: false, msg: String(e) })
    } finally {
      setTesting(false)
    }
  }

  const save = async () => {
    setSaving(true)
    try {
      const { password, ...connFields } = form
      if (isNew) {
        const saved = await invoke<Connection>('add_connection', {
          conn: { ...connFields, id: '', createdAt: '' },
          password,
        })
        setConnections(prev => [...prev, saved])
        setSelected(saved)
        setIsNew(false)
        cacheSet('has-password', saved.id, !!password)
        showToast(true, 'Connection saved.')
      } else if (selected) {
        await invoke('update_connection', {
          conn: { ...connFields, id: selected.id, createdAt: selected.createdAt },
          password: password || null,
        })
        setConnections(prev => prev.map(c => c.id === selected.id ? { ...c, ...connFields } : c))
        if (form.password) { setPwdSaved(true); cacheSet('has-password', selected.id, true) }
        showToast(true, 'Connection updated.')
      }
    } catch (e) {
      showToast(false, String(e))
    } finally {
      setSaving(false)
    }
  }

  const remove = async (id: string) => {
    const name = connections.find(c => c.id === id)?.name ?? 'this connection'
    if (!window.confirm(`Delete connection "${name}"? This also removes its saved password.`)) return
    await invoke('delete_connection', { id }).catch(() => {})
    cacheDelete('has-password', id)
    setConnections(prev => prev.filter(c => c.id !== id))
    if (selected?.id === id) { setSelected(null); setIsNew(false) }
  }

  const toggleConnect = async (c: Connection) => {
    if (connectedIds.has(c.id)) {
      await invoke('disconnect', { id: c.id }).catch(() => {})
      setConnected(prev => { const s = new Set(prev); s.delete(c.id); return s })
    } else {
      await invoke('connect', { id: c.id }).catch(() => {})
      setConnected(prev => new Set([...prev, c.id]))
    }
  }

  const f = (k: keyof typeof EMPTY) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setForm(prev => ({ ...prev, [k]: k === 'port' ? Number(e.target.value) : e.target.value }))

  const showForm = isNew || selected !== null
  const isFileConn = descriptorFor(form.driver).connectionKind === 'file'

  return (
    <div className="flex h-full overflow-hidden relative">
      {/* Connection list */}
      <div className="flex flex-col w-52 shrink-0 overflow-y-auto" style={{ borderRight: '1px solid var(--border)' }}>
        <div className="flex items-center justify-between" style={{ padding: '16px 16px 8px' }}>
          <p className="text-[11px] font-semibold tracking-widest uppercase text-th-dim">Connections</p>
          <button onClick={newConnection} title="New" className="text-th-dim hover:text-th-accent transition-colors"><Plus size={13} /></button>
        </div>

        {connections.length === 0 && (
          <p className="text-[12px] text-th-dim" style={{ padding: '8px 16px' }}>No connections yet.</p>
        )}

        {connections.map(c => {
          const isActive = selected?.id === c.id
          const connected = connectedIds.has(c.id)
          return (
            <div
              key={c.id}
              className={`group flex items-center gap-2 w-full text-[13px] transition-colors border-l-2 cursor-pointer
                ${isActive ? 'border-l-th-accent bg-th-hover text-th-bright' : 'border-l-transparent text-th-text hover:bg-th-hover hover:text-th-bright'}`}
              style={{ padding: '6px 8px 6px 16px' }}
              onClick={() => selectConnection(c)}
            >
              <span className="shrink-0 w-2 h-2 rounded-full" style={{ background: connected ? '#22c55e' : 'var(--text-dim)' }} />
              <span className="truncate flex-1">{c.name || 'Untitled'}</span>
              <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                <button onClick={e => { e.stopPropagation(); toggleConnect(c) }} title={connected ? 'Disconnect' : 'Connect'} className="text-th-dim hover:text-th-accent transition-colors">
                  {connected ? <PlugZap size={11} /> : <Plug size={11} />}
                </button>
                <button onClick={e => { e.stopPropagation(); remove(c.id) }} title="Delete" className="text-th-dim hover:text-th-err transition-colors">
                  <Trash2 size={11} />
                </button>
              </div>
            </div>
          )
        })}
      </div>

      {/* Form */}
      <div className="flex flex-col flex-1 min-w-0 overflow-y-auto">
        {!showForm ? (
          <div className="flex flex-col items-center justify-center flex-1 gap-3" style={{ color: 'var(--text-dim)' }}>
            <p className="text-[13px]">Select a connection or create a new one.</p>
            <button onClick={newConnection} className="flex items-center gap-2 px-4 py-2 rounded text-[13px] transition-colors"
              style={{ background: 'var(--tab-accent)', color: '#fff' }}>
              <Plus size={14} /> New Connection
            </button>
          </div>
        ) : (
          <div style={{ padding: 20 }} className="flex flex-col gap-4 max-w-lg">
            <h2 className="text-[15px] font-semibold text-th-bright">{isNew ? 'New Connection' : 'Edit Connection'}</h2>

            <Field label="Name">
              <Input value={form.name} onChange={f('name')} placeholder="My PostgreSQL" />
            </Field>
            <Field label="Driver">
              <select
                value={form.driver}
                onChange={e => {
                  const driver = e.target.value
                  const d = descriptorFor(driver)
                  setForm(prev => ({ ...prev, driver, port: d.defaultPort ?? prev.port }))
                }}
                className="text-[13px] rounded px-2 py-1.5 outline-none w-full"
                style={{ background: 'var(--sidebar-bg)', border: '1px solid var(--border)', color: 'var(--text)' }}>
                {CONNECTORS.map(c => <option key={c.driver} value={c.driver}>{c.label}</option>)}
              </select>
            </Field>

            {isFileConn ? (
              <Field label="Database file">
                <Input value={form.database} onChange={f('database')} placeholder="/path/to/database.sqlite" />
              </Field>
            ) : (
              <>
                <div className="flex gap-3">
                  <Field label="Host" className="flex-1"><Input value={form.host} onChange={f('host')} placeholder="localhost" /></Field>
                  <Field label="Port" className="w-24"><Input value={form.port} onChange={f('port')} type="number" placeholder="5432" /></Field>
                </div>
                <Field label="Database"><Input value={form.database} onChange={f('database')} placeholder="mydb" /></Field>
                <Field label="Username"><Input value={form.username} onChange={f('username')} placeholder="postgres" /></Field>
                <Field
                  label={
                    !isNew && !pwdSaved
                      ? 'Password — required, not saved yet'
                      : 'Password'
                  }
                  className={!isNew && !pwdSaved ? 'password-required' : ''}
                >
                  <Input
                    value={form.password}
                    onChange={f('password')}
                    type="password"
                    placeholder={isNew || !pwdSaved ? '••••••••' : 'leave blank to keep current'}
                    highlight={!isNew && !pwdSaved && !form.password}
                  />
                </Field>
                <Field label="SSL Mode">
                  <select value={form.sslMode} onChange={f('sslMode')} className="text-[13px] rounded px-2 py-1.5 outline-none w-full"
                    style={{ background: 'var(--sidebar-bg)', border: '1px solid var(--border)', color: 'var(--text)' }}>
                    <option value="disable">Disable</option>
                    <option value="prefer">Prefer</option>
                    <option value="require">Require</option>
                  </select>
                </Field>
              </>
            )}

            {testResult && (
              <div className="flex items-center gap-2 px-3 py-2 rounded text-[12px]"
                style={{ background: testResult.ok ? 'rgba(34,197,94,0.1)' : 'var(--error-bg)', color: testResult.ok ? '#22c55e' : 'var(--error-text)' }}>
                {testResult.ok ? <CheckCircle size={13} /> : <XCircle size={13} />}
                {testResult.msg}
              </div>
            )}

            <div className="flex flex-col gap-2">
            <div className="flex gap-2 flex-wrap">
              <button onClick={testConnection} disabled={testing} className="flex items-center gap-1.5 px-3 py-1.5 rounded text-[13px] transition-colors"
                style={{ border: '1px solid var(--border)', color: 'var(--text)', background: 'transparent', cursor: testing ? 'default' : 'pointer' }}>
                {testing ? <Loader2 size={13} className="animate-spin" /> : <Plug size={13} />}
                Test
              </button>
              <button onClick={save} disabled={saving} className="flex items-center gap-1.5 px-4 py-1.5 rounded text-[13px] transition-opacity"
                style={{ background: 'var(--tab-accent)', color: '#fff', opacity: saving ? 0.7 : 1, cursor: saving ? 'default' : 'pointer' }}>
                {saving ? <Loader2 size={13} className="animate-spin" /> : null}
                Save
              </button>
              {!isNew && selected && (
                <BiometricToggle connectionId={selected.id} onStatus={setBioStatus} />
              )}
            </div>
            {bioStatus && (
              <p className="text-[11px]" style={{ color: bioStatus === 'Touch ID enabled' ? '#22c55e' : 'var(--error-text)' }}>
                {bioStatus}
              </p>
            )}
            </div>
          </div>
        )}
      </div>

      {toast && (
        <div
          className="flex items-center gap-2 px-3 py-2 rounded text-[12px] pointer-events-none"
          style={{
            position: 'absolute', bottom: 16, right: 16,
            background: toast.ok ? 'rgba(34,197,94,0.15)' : 'var(--error-bg)',
            color: toast.ok ? '#22c55e' : 'var(--error-text)',
            border: `1px solid ${toast.ok ? 'rgba(34,197,94,0.3)' : 'var(--error-text)'}`,
            animation: 'fadeIn 0.15s ease',
          }}
        >
          {toast.ok ? <CheckCircle size={13} /> : <XCircle size={13} />}
          {toast.msg}
        </div>
      )}
    </div>
  )
}

function Field({ label, children, className = '' }: { label: string | React.ReactNode; children: React.ReactNode; className?: string }) {
  return (
    <div className={`flex flex-col gap-1 ${className}`}>
      <label className="text-[11px] font-medium uppercase tracking-wide"
        style={{ color: typeof label === 'string' && label.includes('required') ? 'var(--error-text, #f87171)' : 'var(--text-dim)' }}>
        {label}
      </label>
      {children}
    </div>
  )
}

function Input({ value, onChange, type = 'text', placeholder, highlight }: {
  value: string | number; onChange: React.ChangeEventHandler<HTMLInputElement>
  type?: string; placeholder?: string; highlight?: boolean
}) {
  return (
    <input
      type={type}
      value={value}
      onChange={onChange}
      placeholder={placeholder}
      autoCapitalize="off"
      autoCorrect="off"
      spellCheck={false}
      style={{ width: '100%', height: 32, padding: '0 10px', fontSize: 13, borderRadius: 4, background: 'var(--sidebar-bg)', border: `1px solid ${highlight ? 'var(--error-text, #f87171)' : 'var(--border)'}`, color: 'var(--text)', outline: 'none' }}
      onFocus={e => (e.currentTarget.style.borderColor = 'var(--tab-accent)')}
      onBlur={e => (e.currentTarget.style.borderColor = highlight ? 'var(--error-text, #f87171)' : 'var(--border)')}
    />
  )
}

function BiometricToggle({ connectionId, onStatus }: { connectionId: string; onStatus: (s: string | null) => void }) {
  const [available, setAvailable] = useState(false)
  const [loading, setLoading]     = useState(false)

  useEffect(() => {
    invoke<boolean>('biometric_available').then(setAvailable).catch(() => setAvailable(false))
  }, [])

  if (!available) return null

  const enable = async () => {
    setLoading(true); onStatus(null)
    try {
      await invoke('biometric_authenticate', { reason: 'Enable Touch ID for Crabeaver' })
      await invoke('enable_biometric', { id: connectionId })
      onStatus('Touch ID enabled')
    } catch (e) { onStatus(String(e)) }
    finally { setLoading(false) }
  }

  return (
    <button onClick={enable} disabled={loading}
      className="flex items-center gap-1.5 px-3 py-1.5 rounded text-[13px] transition-colors"
      style={{ border: '1px solid var(--border)', color: 'var(--text)', background: 'transparent', cursor: loading ? 'default' : 'pointer' }}>
      {loading ? <Loader2 size={13} className="animate-spin" /> : <Fingerprint size={13} />}
      Enable Touch ID
    </button>
  )
}
