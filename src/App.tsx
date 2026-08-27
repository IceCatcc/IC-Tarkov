import { useEffect } from 'react'
import {
  initTauri,
  startWatching,
  getState,
  getPlayerQuests,
  getActivity,
  getSettings,
} from './tauri'
import { useStore } from './store'
import { TopBar } from './components/TopBar'
import { Sidebar } from './components/Sidebar'
import { MonitorPage } from './pages/MonitorPage'
import { QuestGraphPage } from './pages/QuestGraphPage'
import { MapPage } from './pages/MapPage'
import SettingsModal from './components/SettingsModal'

export default function App() {
  const page = useStore((s) => s.page)
  const showSettings = useStore((s) => s.showSettings)
  const setWatcher = useStore((s) => s.setWatcher)
  const setSettings = useStore((s) => s.setSettings)
  const seedPlayerQuests = useStore((s) => s.seedPlayerQuests)
  const seedActivity = useStore((s) => s.seedActivity)

  useEffect(() => {
    let off: (() => void) | undefined
    initTauri()
      .then((un) => {
        off = un
        return getSettings()
      })
      .then((st) => {
        setSettings(st)
        return startWatching(st.logDir || undefined)
      })
      .then(() => getState())
      .then((wst) => {
        setWatcher(wst)
        return getPlayerQuests()
      })
      .then((list) => {
        seedPlayerQuests(list)
        return getActivity()
      })
      .then((acts) => {
        seedActivity(acts)
      })
      .catch((e) => console.error('init error', e))
    return () => {
      off?.()
    }
  }, [setWatcher, setSettings, seedPlayerQuests, seedActivity])

  return (
    <div className="h-full flex flex-col">
      <TopBar />
      <div className="flex-1 flex min-h-0">
        <Sidebar />
        <main className="flex-1 min-w-0 overflow-hidden">
          {page === 'monitor' && <MonitorPage />}
          {page === 'graph' && <QuestGraphPage />}
          {page === 'map' && <MapPage />}
        </main>
      </div>
      {showSettings && <SettingsModal />}
    </div>
  )
}
