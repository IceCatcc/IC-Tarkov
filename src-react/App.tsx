import { useEffect, useRef, useState } from 'react'
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
  const openSettings = useStore((s) => s.openSettings)
  // 首次启动帮助弹窗（仅未看过时显示，看过写入 localStorage 不再弹）
  const [showHelp, setShowHelp] = useState(
    () => typeof localStorage !== 'undefined' && localStorage.getItem('ic-tarkov.helpSeen.v1') !== '1',
  )
  // 帮助窗口展示期间暂缓打开设置（缺日志目录时），待其关闭后再补上，
  // 避免两个浮层同时出现、设置窗口盖住帮助窗口。
  const pendingOpenSettings = useRef(false)
  const closeHelp = () => {
    try {
      localStorage.setItem('ic-tarkov.helpSeen.v1', '1')
    } catch {
      /* ignore */
    }
    setShowHelp(false)
    if (pendingOpenSettings.current) {
      pendingOpenSettings.current = false
      openSettings()
    }
  }
  const goToSettings = () => {
    pendingOpenSettings.current = false
    closeHelp()
    openSettings()
  }
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
        // 日志目录未配置：不启动监控，引导用户到设置里选择。
        // 若首次启动的帮助窗口正在展示，则先挂起，等帮助关闭后再打开设置，
        // 避免两个浮层叠放（设置窗口层级更高会盖住帮助窗口）。
        if (!st.logDir) {
          const helpSeen =
            typeof localStorage !== 'undefined' &&
            localStorage.getItem('ic-tarkov.helpSeen.v1') === '1'
          if (helpSeen) useStore.getState().openSettings()
          else pendingOpenSettings.current = true
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
      <TopBar onShowHelp={() => setShowHelp(true)} />
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
      {showHelp && (
        <div
          className="fixed inset-0 z-[1200] flex items-center justify-center bg-black/60"
          onClick={closeHelp}
        >
          <div
            className="w-[460px] max-w-[calc(100vw-32px)] rounded-2xl border border-line bg-ink-800 shadow-2xl overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            {/* 头部 */}
            <div className="relative px-5 pt-5 pb-4 border-b border-line bg-gradient-to-b from-ink-700/60 to-transparent text-center">
              <div className="text-[18px] font-semibold text-[#e6edf3]">使用帮助</div>
              <div className="mt-1 text-[13px] text-muted">请按以下步骤完成配置</div>
            </div>

            {/* 步骤 */}
            <div className="px-5 py-4 space-y-3">
              {[
                {
                  t: '1. 配置日志目录',
                  d: '在「设置」里配置日志目录，指向游戏根目录下的 Logs 目录。',
                },
                {
                  t: '2. 配置截图目录',
                  d: '配置截图目录，指向「文档\\Escape from Tarkov\\Screenshots\\」。若该目录不存在，请进入游戏后按 PrintScreen 键（默认）进行截图后再配置。',
                },
                {
                  t: '3. 设置游戏档',
                  d: '在「档案」页面设置当前游戏档的角色等级、商人好感与地图解锁情况。',
                },
              ].map((s) => (
                <div
                  key={s.t}
                  className="rounded-lg bg-ink-700/50 border border-line px-3 py-2.5"
                >
                  <div className="text-[14px] font-medium text-[#e6edf3] mb-1">{s.t}</div>
                  <div className="text-[13px] text-[#c9d1d9] leading-relaxed">{s.d}</div>
                </div>
              ))}
            </div>

            {/* 操作 */}
            <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-line">
              <button
                onClick={closeHelp}
                className="px-4 py-1.5 rounded border border-line text-[14px] text-muted hover:text-[#e6edf3] hover:bg-ink-700"
              >
                我知道了
              </button>
              <button
                onClick={goToSettings}
                className="px-4 py-1.5 rounded bg-amber text-black text-[14px] font-medium hover:opacity-90"
              >
                去设置
              </button>
            </div>
          </div>
        </div>
      )}
      <WikiDrawer />
      <Toasts />
    </div>
  )
}
