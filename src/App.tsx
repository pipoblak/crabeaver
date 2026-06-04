import { useState, useCallback } from 'react'
import { invoke } from '@tauri-apps/api/core'
import ActivityBar, { type SidebarPanel } from '@/components/ActivityBar'
import Sidebar from '@/components/Sidebar'
import SearchPanel from '@/components/SearchPanel'
import EditorTabs from '@/components/EditorTabs'
import SettingsTab from '@/components/SettingsTab'
import StatusBar from '@/components/StatusBar'
import ActivityDock from '@/components/ActivityDock'
import { TabsProvider, useTabs } from '@/context/TabsContext'
import type { Tab } from '@/lib/tabs'
import ResizeHandle from '@/components/ResizeHandle'
import { useResize } from '@/hooks/useResize'

export type AppView = 'editor' | 'settings'

// F12 opens DevTools — dev builds only
if (import.meta.env.DEV) {
  window.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === 'F12') invoke('open_devtools').catch(() => {})
  })
}

function AppShell() {
  const [view, setView]                   = useState<AppView>('editor')
  const [sidebarPanel, setSidebarPanel]   = useState<SidebarPanel>('connections')
  const [settingsSection, setSettingsSection] = useState<string | undefined>()
  const { restored, openSpecialTab } = useTabs()
  const [sidebarW, setSidebarW] = useState(224)
  const onSidebarResize = useCallback((w: number) => setSidebarW(w), [])
  const sidebarDrag = useResize(sidebarW, onSidebarResize, 'horizontal', 140, 400)

  const [settingsConnectionId, setSettingsConnectionId] = useState<string | undefined>()

  const openSettings = (section?: string, connectionId?: string) => {
    setSettingsSection(section)
    setSettingsConnectionId(connectionId)
    setView('settings')
  }

  return (
    <div className="flex flex-col h-screen w-screen overflow-hidden bg-th-bg text-th-text">
      <div className="flex flex-1 min-h-0">
        <ActivityBar view={view} setView={setView} panel={sidebarPanel} setPanel={setSidebarPanel} />
        {view === 'editor' && (
          <>
            {sidebarPanel === 'search'
              ? <SearchPanel width={sidebarW} />
              : <Sidebar openSettings={openSettings} openTab={(type, title, extra) => { openSpecialTab(type as Tab['type'], title, extra) }} width={sidebarW} />}
            <ResizeHandle onMouseDown={sidebarDrag} />
          </>
        )}
        <main className="flex flex-col flex-1 min-w-0 relative">
          <div className={`absolute inset-0 flex-col ${view === 'editor' ? 'flex' : 'hidden'}`}>
            {restored && <EditorTabs />}
          </div>
          {view === 'settings' && <SettingsTab initialSection={settingsSection} initialConnectionId={settingsConnectionId} />}
        </main>
      </div>
      <ActivityDock />
      <StatusBar />
    </div>
  )
}

export default function App() {
  return (
    <TabsProvider>
      <AppShell />
    </TabsProvider>
  )
}
