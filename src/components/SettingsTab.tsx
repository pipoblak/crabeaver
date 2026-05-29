import { useState } from 'react'
import { Palette, Code2, Database, Info, ChevronRight } from 'lucide-react'
import ThemesSection from '@/components/settings/ThemesSection'

type Section = 'themes' | 'editor' | 'connections' | 'about'

const SECTIONS = [
  { id: 'themes'      as Section, label: 'Themes',      icon: Palette,  },
  { id: 'editor'      as Section, label: 'Editor',       icon: Code2,    },
  { id: 'connections' as Section, label: 'Connections',  icon: Database, },
  { id: 'about'       as Section, label: 'About',        icon: Info,     },
]

export default function SettingsTab() {
  const [active, setActive] = useState<Section>('themes')

  return (
    <div className="flex h-full overflow-hidden bg-th-bg">

      {/* ── Left: section list ── */}
      <div
        className="flex flex-col w-48 shrink-0 overflow-y-auto"
        style={{ borderRight: '1px solid var(--border)' }}
      >
        <div style={{ padding: '16px 16px 8px' }}>
          <p className="text-[11px] font-semibold tracking-widest uppercase text-th-dim">
            Settings
          </p>
        </div>

        {SECTIONS.map(s => {
          const Icon = s.icon
          const isActive = active === s.id
          return (
            <button
              key={s.id}
              onClick={() => setActive(s.id)}
              className="flex items-center justify-between w-full text-left text-[13px] transition-colors"
              style={{
                padding: '7px 16px',
                borderLeft: isActive ? '2px solid var(--tab-accent)' : '2px solid transparent',
                background: isActive ? 'var(--hover)' : 'transparent',
                color: isActive ? 'var(--text-bright)' : 'var(--text)',
              }}
              onMouseEnter={e => { if (!isActive) { e.currentTarget.style.background = 'var(--hover)'; e.currentTarget.style.color = 'var(--text-bright)' } }}
              onMouseLeave={e => { if (!isActive) { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'var(--text)' } }}
            >
              <div className="flex items-center gap-2.5">
                <Icon size={14} strokeWidth={1.5} />
                <span>{s.label}</span>
              </div>
              {isActive && <ChevronRight size={12} style={{ color: 'var(--text-dim)' }} />}
            </button>
          )
        })}
      </div>

      {/* ── Right: section content ── */}
      <div className="flex flex-col flex-1 min-w-0 overflow-hidden">
        {active === 'themes'      && <ThemesSection />}
        {active === 'editor'      && <EditorSection />}
        {active === 'connections' && <ConnectionsSection />}
        {active === 'about'       && <AboutSection />}
      </div>
    </div>
  )
}

/* ── Stub sections ── */

function EditorSection() {
  return (
    <SectionShell title="Editor">
      <SettingRow label="Font Size" description="Editor font size in pixels">
        <select
          className="text-[13px] rounded px-2 py-1 outline-none"
          style={{ background: 'var(--sidebar-bg)', border: '1px solid var(--border)', color: 'var(--text)' }}
          defaultValue="14"
        >
          {[11,12,13,14,15,16,18,20].map(s => <option key={s} value={s}>{s}px</option>)}
        </select>
      </SettingRow>
      <SettingRow label="Tab Size" description="Number of spaces per tab">
        <select
          className="text-[13px] rounded px-2 py-1 outline-none"
          style={{ background: 'var(--sidebar-bg)', border: '1px solid var(--border)', color: 'var(--text)' }}
          defaultValue="2"
        >
          {[2, 4, 8].map(s => <option key={s} value={s}>{s}</option>)}
        </select>
      </SettingRow>
      <SettingRow label="Word Wrap" description="Wrap long lines">
        <Toggle defaultChecked={false} />
      </SettingRow>
      <SettingRow label="Minimap" description="Show minimap in editor">
        <Toggle defaultChecked={true} />
      </SettingRow>
    </SectionShell>
  )
}

function ConnectionsSection() {
  return (
    <SectionShell title="Connections">
      <div style={{ padding: '16px', color: 'var(--text-dim)', fontSize: 13 }}>
        Manage your database connections here.
        <br /><br />
        <span style={{ color: 'var(--text-dim)', fontSize: 12 }}>
          PostgreSQL, MySQL, SQLite support coming soon.
        </span>
      </div>
    </SectionShell>
  )
}

function AboutSection() {
  return (
    <SectionShell title="About">
      <div style={{ padding: '16px' }} className="flex flex-col gap-4">
        <div className="flex items-center gap-3">
          <img src="/app-icon.png" alt="Crabeaver" style={{ width: 48, height: 48, borderRadius: 10 }} />
          <div>
            <p className="text-[15px] font-semibold text-th-bright">Crabeaver</p>
            <p className="text-[12px] text-th-dim">v0.1.0</p>
          </div>
        </div>
        <div className="flex flex-col gap-1">
          <InfoRow label="Built with" value="Tauri v2 + React + Rust" />
          <InfoRow label="SQL Parser" value="sqlparser-rs" />
          <InfoRow label="Editor" value="Monaco Editor" />
        </div>
      </div>
    </SectionShell>
  )
}

/* ── Shared components ── */

function SectionShell({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col h-full overflow-y-auto">
      <div style={{ padding: '16px 20px 12px', borderBottom: '1px solid var(--border)' }}>
        <p className="text-[15px] font-semibold text-th-bright">{title}</p>
      </div>
      <div className="flex flex-col">{children}</div>
    </div>
  )
}

function SettingRow({ label, description, children }: {
  label: string; description?: string; children: React.ReactNode
}) {
  return (
    <div
      className="flex items-center justify-between"
      style={{ padding: '12px 20px', borderBottom: '1px solid var(--border)' }}
    >
      <div className="flex flex-col gap-0.5">
        <span className="text-[13px] text-th-text">{label}</span>
        {description && <span className="text-[11px] text-th-dim">{description}</span>}
      </div>
      {children}
    </div>
  )
}

function Toggle({ defaultChecked }: { defaultChecked: boolean }) {
  const [on, setOn] = useState(defaultChecked)
  return (
    <button
      onClick={() => setOn(v => !v)}
      className="relative rounded-full transition-colors"
      style={{
        width: 36, height: 20, flexShrink: 0,
        background: on ? 'var(--tab-accent)' : 'var(--border)',
      }}
    >
      <span
        className="absolute top-0.5 rounded-full bg-white transition-transform"
        style={{ width: 16, height: 16, left: 2, transform: on ? 'translateX(16px)' : 'translateX(0)' }}
      />
    </button>
  )
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-[12px] text-th-dim w-24 shrink-0">{label}</span>
      <span className="text-[12px] text-th-text">{value}</span>
    </div>
  )
}
