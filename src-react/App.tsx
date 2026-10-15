import { useEffect, useRef, useState, type CSSProperties } from 'react'
import {
  initTauri,
  startWatching,
  getState,
  getPlayerQuests,
  getUnlocked,
  getSettings,
} from './tauri'
import { useStore } from './store'
import { startLanAutoConnect, reloadLocalData } from './lan'
import { listenEvent } from './api/shell'
import { refreshAssetIndex, registerAssetSyncListener, subscribeAssets } from './assetUrl'
import { fetchMe } from './api/web-account'
import { AuthGate } from './components/AuthGate'
import { bootReady, bootSnapshot, finishBoot, reportStep, subscribeBoot } from './boot'
import { isMobile, isAndroid, isWeb } from './platform'
import { TopBar } from './components/TopBar'
import { StartupSplash } from './components/StartupSplash'
import { MonitorPage } from './pages/MonitorPage'
import { QuestGraphPage } from './pages/QuestGraphPage'
import { CollectorPage } from './pages/CollectorPage'
import { ItemsPage } from './pages/ItemsPage'
import { MapPage } from './pages/MapPage'
import SettingsModal from './components/SettingsModal'
import { HelpModal } from './components/HelpModal'
import { WikiDrawer } from './components/WikiDrawer'
import { Toasts } from './components/Toasts'
import { LanConflictModal } from './components/LanConflictModal'

/** 屏幕常亮开启时的启动提示文案（帮助窗口挂起后复用，保证文案一致） */
const KEEP_ON_TOAST = '屏幕常亮已开启（可在设置中关闭）'

export default function App() {
  const page = useStore((s) => s.page)
  const setPage = useStore((s) => s.setPage)
  const openSettings = useStore((s) => s.openSettings)
  // 图片资源索引刷新后整棵树重渲染一次：新下载的图片随即替换掉随包路径
  const [, setAssetsRev] = useState(0)
  useEffect(() => subscribeAssets(() => setAssetsRev((v) => v + 1)), [])
  // 首次启动帮助弹窗（仅未看过时显示，看过写入 localStorage 不再弹）
  const [showHelp, setShowHelp] = useState(
    () => typeof localStorage !== 'undefined' && localStorage.getItem('ic-tarkov.helpSeen.v1') !== '1',
  )
  // 帮助窗口展示期间暂缓打开设置（缺日志目录时），待其关闭后再补上，
  // 避免两个浮层同时出现、设置窗口盖住帮助窗口。
  const pendingOpenSettings = useRef(false)
  // 屏幕常亮提示：首次启动时帮助窗口会盖住通知，挂起到帮助关闭后再弹
  const pendingKeepOnToast = useRef(false)
  // 启动遮罩：「读取中 xx」步骤（后端资料读取 + 前端初始化），跑完自动收起
  const [boot, setBoot] = useState(bootSnapshot)
  useEffect(() => subscribeBoot(() => setBoot(bootSnapshot())), [])
  const closeHelp = () => {
    try {
      localStorage.setItem('ic-tarkov.helpSeen.v1', '1')
    } catch {
      /* ignore */
    }
    setShowHelp(false)
    if (pendingKeepOnToast.current) {
      pendingKeepOnToast.current = false
      useStore.getState().pushToast(KEEP_ON_TOAST, 'info')
    }
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
  // 物品页 keepAlive：同上（缓存物品目录与任务需求聚合，切走不销毁）
  const [itemsAlive, setItemsAlive] = useState(false)
  useEffect(() => {
    if (page === 'items') setItemsAlive(true)
  }, [page])
  // 收藏家追踪关闭时导航不再显示「收藏家」页签；若正停留在该页（开关被关掉 /
  // 从设置或局域网同步恢复了关闭态），踢回监控页，避免出现无页签可点的死角
  const collectorTrack = useStore((s) => s.collectorTrack)
  useEffect(() => {
    if (page === 'collector' && !collectorTrack) setPage('monitor')
  }, [page, collectorTrack, setPage])
  const showSettings = useStore((s) => s.showSettings)
  const setWatcher = useStore((s) => s.setWatcher)
  const setSettings = useStore((s) => s.setSettings)
  const seedPlayerQuests = useStore((s) => s.seedPlayerQuests)
  const setUnlockedQuests = useStore((s) => s.setUnlockedQuests)
  // 界面缩放（类显示器缩放）：作用于根节点 CSS zoom，固定浮层一并等比缩放
  const uiScale = useStore((s) => s.uiScale)
  // 移动端 UI 适配分支：底部 Tab、transform 缩放、关闭监控
  const mobile = isMobile()
  // Web 端登录门禁：未登录不加载任何业务数据（接口会 401），先整屏接管
  const web = isWeb()
  const [authChecked, setAuthChecked] = useState(!web)
  const [authed, setAuthed] = useState(!web)
  useEffect(() => {
    if (!web) return
    let alive = true
    fetchMe()
      .then((u) => {
        if (!alive) return
        setAuthed(!!u)
        setAuthChecked(true)
      })
      .catch(() => {
        if (!alive) return
        setAuthed(false)
        setAuthChecked(true)
      })
    return () => {
      alive = false
    }
  }, [web])
  useEffect(() => {
    // 移动端用根容器 transform 缩放（见渲染处），桌面保留 document.zoom。
    // 同时把缩放值写进 CSS 变量：浮层的 vh 高度需按缩放反算，
    // 否则放大后弹窗实际高度超出屏幕，底部的确认按钮会被挤到屏幕外（见各弹窗的 max-h）。
    if (!mobile) {
      document.documentElement.style.zoom = String(uiScale)
      document.documentElement.style.setProperty('--ui-scale', String(uiScale))
    }
  }, [uiScale, mobile])

  useEffect(() => {
    // Web 端未登录时不加载数据（接口会 401），等门禁放行后再走启动链
    if (!authChecked || !authed) return
    let off: (() => void) | undefined
    let offAssets: (() => void) | undefined
    let cancelled = false
    void (async () => {
      try {
        // 资料读取与界面进程分离：后端在独立线程里读进度 / 数据集，
        // 这里先等它就绪（期间遮罩显示「读取中 xx」），再调用依赖数据集的命令
        await bootReady()
        if (cancelled) return
        off = await initTauri()
        // 图片资源索引：每张图优先用「更新图片资源」下载到本机的版本，缺失才回退随包资源，
        // 因而必须在首次渲染前取到（无内置资源版完全依赖它）；更新完成后再刷新一次。
        reportStep('assets', '正在读取图片资源…')
        await refreshAssetIndex()
        offAssets = registerAssetSyncListener()
        reportStep('settings', '正在读取界面设置…')
        const st = await getSettings()
        setSettings(st)
        // 后端 settings.json 为 UI 偏好的持久化源（覆盖 localStorage 首帧缓存）
        if (st.uiPrefs && Object.keys(st.uiPrefs).length > 0) {
          useStore.getState().applyUiPrefs(st.uiPrefs)
        }
        // 日志目录未配置：不启动监控，引导用户到设置里选择。
        // 若首次启动的帮助窗口正在展示，则先挂起，等帮助关闭后再打开设置，
        // 避免两个浮层叠放（设置窗口层级更高会盖住帮助窗口）。
        // 移动端不启动日志监控（游戏在 PC，无日志/截图源），也不引导配置日志目录
        if (mobile) {
          // 启动提示：屏幕常亮已开启（仅 Android 生效，设置里可关闭）
          if (isAndroid() && st.keepScreenOn) {
            const helpSeen =
              typeof localStorage !== 'undefined' &&
              localStorage.getItem('ic-tarkov.helpSeen.v1') === '1'
            if (helpSeen) useStore.getState().pushToast(KEEP_ON_TOAST, 'info')
            else pendingKeepOnToast.current = true
          }
          return
        }
        if (!st.logDir) {
          const helpSeen =
            typeof localStorage !== 'undefined' &&
            localStorage.getItem('ic-tarkov.helpSeen.v1') === '1'
          if (helpSeen) useStore.getState().openSettings()
          else pendingOpenSettings.current = true
          return
        }
        // 初始扫描较慢，后端已把它放到异步线程执行，界面保持可响应
        reportStep('watching', '正在扫描日志…')
        await startWatching(st.logDir)
        setWatcher(await getState())
        reportStep('quests', '正在加载任务列表…')
        // 仅加载玩家任务；历史活动默认不读取，由「加载更多」按需拉取
        seedPlayerQuests(await getPlayerQuests())
        setUnlockedQuests(await getUnlocked())
      } catch (e) {
        console.error('init error', e)
      } finally {
        if (!cancelled) finishBoot()
      }
    })()
    return () => {
      cancelled = true
      off?.()
      offAssets?.()
    }
  }, [authChecked, authed, setWatcher, setSettings, seedPlayerQuests, setUnlockedQuests])

  // 同步（手机端）：启动自动重连已保存的电脑端；监听快照应用后刷新本地数据。
  // 未保存过连接配置时不自动弹连接窗口（首次启动直接弹会打断使用），
  // 由用户点顶部栏「连接」按钮进入（TopBar 内的 LanConnectModal）。
  // Web 端没有局域网同步（多端同步由服务端负责），整体跳过。
  useEffect(() => {
    if (isWeb()) return
    let off: (() => void) | undefined
    startLanAutoConnect()
    listenEvent('lan-sync-updated', () => {
      void reloadLocalData()
    })
      .then((u) => {
        off = u
      })
      .catch(() => {})
    return () => {
      off?.()
    }
  }, [])

  // 同步（电脑端）：手机端连上后自动完成的同步，提示结果；
  // 需要人工选择的情况由 LanConflictModal 弹窗处理。
  useEffect(() => {
    if (isMobile() || isWeb()) return
    let disposed = false
    let off: (() => void) | undefined
    listenEvent<{ state: string; message?: string }>('lan-sync-status', (e) => {
      const done: Record<string, string> = {
        pushed: '已把电脑端数据同步到手机',
        pulled: '已用手机端数据覆盖本机',
        skipped: '已跳过本次同步',
      }
      const s = e
      if (s.state === 'error') {
        useStore.getState().pushToast('同步失败：' + (s.message ?? ''), 'info')
      } else if (done[s.state]) {
        useStore.getState().pushToast(done[s.state], 'done')
      }
    })
      .then((u) => {
        if (disposed) u()
        else off = u
      })
      .catch(() => {})
    return () => {
      disposed = true
      off?.()
    }
  }, [])

  // 屏蔽浏览器刷新（F5 / Ctrl+R）与右键菜单。
  // 仅 Tauri 壳内需要（壳里刷新会丢状态）；浏览器端保留原生行为，不干扰用户。
  useEffect(() => {
    if (isWeb()) return
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

  // 登录门禁（仅 Web）：未登录 / 会话校验未完成时整屏接管，不渲染主界面
  if (!authChecked || !authed) {
    return <AuthGate onAuthed={() => setAuthed(true)} />
  }

  return (
    <div
      className="h-full flex flex-col"
      style={
        mobile
          ? ({
              // 移动端用 transform 缩放替代 CSS zoom；按缩放倒数放大容器避免溢出/留白
              transform: `scale(${uiScale})`,
              transformOrigin: 'top left',
              width: `${100 / uiScale}vw`,
              height: `${100 / uiScale}dvh`,
              // 为底部 Tab 导航预留空间（含 iOS 安全区）
              paddingBottom: 'calc(var(--nav-h) + env(safe-area-inset-bottom))',
              // 供浮层按缩放反算 vh 高度（见各弹窗的 max-h）
              '--ui-scale': String(uiScale),
            } as CSSProperties)
          : undefined
      }
    >
      <TopBar />
      <main className="flex-1 min-w-0 overflow-hidden">
        {page === 'monitor' && <MonitorPage />}
        {questAlive && (
          <div className="h-full" style={{ display: page === 'graph' ? 'block' : 'none' }}>
            <QuestGraphPage />
          </div>
        )}
        {page === 'collector' && <CollectorPage />}
        {itemsAlive && (
          <div className="h-full" style={{ display: page === 'items' ? 'block' : 'none' }}>
            <ItemsPage />
          </div>
        )}
        {mapAlive && (
          <div className="h-full" style={{ display: page === 'map' ? 'block' : 'none' }}>
            <MapPage />
          </div>
        )}
      </main>
      {showSettings && <SettingsModal />}
      <HelpModal open={showHelp} onClose={closeHelp} onGoSettings={goToSettings} />
      {!mobile && !isWeb() && <LanConflictModal />}
      <WikiDrawer />
      <Toasts />
      {/* 启动遮罩压在最上层：初始化跑完后淡出（帮助 / 设置等浮层都在其下） */}
      <StartupSplash steps={boot.steps} error={boot.error} visible={!boot.finished} />
    </div>
  )
}
