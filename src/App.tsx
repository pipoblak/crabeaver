import { useState } from 'react'
import ActivityBar from '@/components/ActivityBar'
import Sidebar from '@/components/Sidebar'
import EditorTabs from '@/components/EditorTabs'
import SettingsTab from '@/components/SettingsTab'
import StatusBar from '@/components/StatusBar'
import { TabsProvider } from '@/context/TabsContext'

export type AppView = 'editor' | 'settings'

export default function App() {
  const [view, setView] = useState<AppView>('editor')

  return (
    <TabsProvider>
      <div className="flex flex-col h-screen w-screen overflow-hidden" style={{ background: 'var(--bg)', color: 'var(--text)' }}>
        <div className="flex flex-1 min-h-0">
          <ActivityBar view={view} setView={setView} />
          <Sidebar />
          <main className="flex flex-col flex-1 min-w-0 relative">
            {/* Always mounted — preserves tab state */}
            <div className="absolute inset-0 flex flex-col" style={{ display: view === 'editor' ? 'flex' : 'none' }}>
              <EditorTabs />
            </div>
            {view === 'settings' && <SettingsTab />}
          </main>
        </div>
        <StatusBar />
      </div>
    </TabsProvider>
  )
}
