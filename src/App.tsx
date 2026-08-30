import { useEffect, useState } from 'react'
import {
  initTauri,
  startWatching,
  getState,
  getPlayerQuests,
  getUnlocked,
  getSettings,
} from './tauri'
import { useStore } from './store'
import { TopBar } from './components/TopBar'
import { MonitorPage } from './pages/MonitorPage'
import { QuestGraphPage } from './pages/QuestGraphPage'
import { ProfilePage } from './pages/ProfilePage'
import { MapPage } from './pages/MapPage'
import SettingsModal from './components/SettingsModal'
import { WikiDrawer } from './components/WikiDrawer'
import { Toasts } from './components/Toasts'

export default function App() {
  const page = useStore((s) => s.page)
  // 地图页 keepAlive：首次访问后常驻挂载（仅用 display 切换隐藏），切走不销毁状态
  const [mapAlive, setMapAlive] = useState(false)
  useEffect(() => {
    if (page === 'map') setMapAlive(true)
  }, [page])
  // 任务图谱页 keepAlive：同上
  const [questAlive, setQuestAlive] = useState(false)
  useEffect(() => {
    if (page === 'graph') setQuestAlive(true)
  }, [page])
  const showSettings = useStore((s) => s.showSettings)
  const setWatcher = useStore((s) => s.setWatcher)
  const setSettings = useStore((s) => s.setSettings)
  const seedPlayerQuests = useStore((s) => s.seedPlayerQuests)
  const setUnlockedQuests = useStore((s) => s.setUnlockedQuests)
  // 界面缩放（类显示器缩放）：作用于根节点 CSS zoom，固定浮层一并等比缩放
  const uiScale = useStore((s) => s.uiScale)
  useEffect(() => {
    document.documentElement.style.zoom = String(uiScale)
  }, [uiScale])

  useEffect(() => {
    let off: (() => void) | undefined
    initTauri()
      .then((un) => {
        off = un
        return getSettings()
      })
      .then((st) => {
        setSettings(st)
        // 后端 settings.json 为 UI 偏好的持久化源（覆盖 localStorage 首帧缓存）
        if (st.uiPrefs && Object.keys(st.uiPrefs).length > 0) {
          useStore.getState().applyUiPrefs(st.uiPrefs)
        }
        // 日志目录未配置：不启动监控，打开设置引导用户选择
        if (!st.logDir) {
          useStore.getState().openSettings()
          return undefined
        }
        return startWatching(st.logDir)
      })
      .then(() => getState())
      .then((wst) => {
        setWatcher(wst)
        return getPlayerQuests()
      })
      .then((list) => {
        // 仅加载玩家任务；历史活动默认不读取，由「加载更多」按需拉取
        seedPlayerQuests(list)
        return getUnlocked()
      })
      .then((list) => {
        setUnlockedQuests(list)
      })
      .catch((e) => console.error('init error', e))
    return () => {
      off?.()
    }
  }, [setWatcher, setSettings, seedPlayerQuests, setUnlockedQuests])

  // 屏蔽浏览器刷新（F5 / Ctrl+R）与右键菜单
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'F5' || (e.ctrlKey && (e.key === 'r' || e.key === 'R'))) {
        e.preventDefault()
      }
    }
    const onCtx = (e: MouseEvent) => e.preventDefault()
    window.addEventListener('keydown', onKey)
    window.addEventListener('contextmenu', onCtx)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('contextmenu', onCtx)
    }
  }, [])

  return (
    <div className="h-full flex flex-col">
      <TopBar />
      <main className="flex-1 min-w-0 overflow-hidden">
        {page === 'monitor' && <MonitorPage />}
        {questAlive && (
          <div className="h-full" style={{ display: page === 'graph' ? 'block' : 'none' }}>
            <QuestGraphPage />
          </div>
        )}
        {page === 'profile' && <ProfilePage />}
        {mapAlive && (
          <div className="h-full" style={{ display: page === 'map' ? 'block' : 'none' }}>
            <MapPage />
          </div>
        )}
      </main>
      {showSettings && <SettingsModal />}
      <WikiDrawer />
      <Toasts />
    </div>
  )
}
