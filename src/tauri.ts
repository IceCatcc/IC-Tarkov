import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { invoke } from '@tauri-apps/api/core'
import { useStore, collectUiPrefs } from './store'
import type {
  QuestEventPayload,
  WatcherStatePayload,
  PlayerQuest,
  ActivityItem,
  QuestGraph,
  QuestDetail,
  AppSettings,
  PlayerProfile,
  PlayerPositionPayload,
  MapInfo,
} from './types'

/** 幂等守卫：只允许注册一次全局监听。StrictMode 双挂载 / HMR 重入时避免重复注册导致通知重复弹出 */
let tauriInited = false

export async function initTauri(): Promise<UnlistenFn> {
  if (tauriInited) return () => {}
  tauriInited = true
  const { applyEvent, setWatcher, pushToast } = useStore.getState()

  // 任务接取 / 完成 → 全局通知
  const offQuest = await listen<QuestEventPayload>('quest-event', (e) => {
    const p = e.payload
    applyEvent(p)
    if (p.type === 'accept') pushToast(`接取任务：${p.name} · ${p.traderName}`, 'accept')
    else if (p.type === 'complete') pushToast(`完成任务：${p.name}`, 'done')
  })
  const offState = await listen<WatcherStatePayload>('watcher-state', (e) => {
    setWatcher(e.payload)
  })

  // 全局监听当前地图变化：任何页面（含非地图页）收到 map-changed 都写入 store，
  // 保证在别的页面进入某张地图时全局当前地图被更新，切回地图页即默认切换到对应地图。
  const { setCurrentMapId, setMapNames } = useStore.getState()
  const offMap = await listen<{ locationId: string; timestamp?: string }>(
    'map-changed',
    (e) => {
      setCurrentMapId(e.payload.locationId)
      // 进入地图 → 全局通知（名称取启动时缓存的地图名表）
      const name = useStore.getState().mapNames[e.payload.locationId]
      pushToast(`进入地图：${name ?? e.payload.locationId}`, 'map')
    },
  )
  // 启动时拉取后端已记录的当前地图（历史值），避免等到下一次地图变化事件
  getCurrentMap()
    .then((id) => {
      if (id) setCurrentMapId(id)
    })
    .catch(() => {})
  // 缓存地图 id -> 中文名，供通知与列表显示使用
  getMaps()
    .then((list) => {
      if (list?.length) setMapNames(Object.fromEntries(list.map((m) => [m.id, m.name])))
    })
    .catch(() => {})

  // 全局监听会话模式（pve/pvp）：游戏以某模式启动时，任务图谱自动跟随切换
  const { applyDetectedMode } = useStore.getState()
  const offMode = await listen<{ mode: string; timestamp?: string }>('session-mode', (e) => {
    applyDetectedMode(e.payload.mode)
  })
  getSessionMode()
    .then((m) => {
      if (m) applyDetectedMode(m)
    })
    .catch(() => {})

  // —— UI 偏好统一持久化到后端 settings.json（localStorage 仅作首帧缓存）——
  // 启动恢复在 App.tsx 拿到 getSettings 结果后调用 applyUiPrefs；
  // 这里订阅偏好字段变化，防抖写回后端。
  let prefTimer: number | undefined
  const prefFields = [
    'repMetGraph',
    'lvlMetGraph',
    'mapUnlockedGraph',
    'showCompletedGraph',
    'hideLegacyGraph',
    'disabledTradersGraph',
    'questMode',
    'autoZoomMap',
    'untrackedQuests',
  ] as const
  const snapState = (s: ReturnType<typeof useStore.getState>) =>
    JSON.stringify(Object.fromEntries(prefFields.map((k) => [k, s[k]])))
  let prevSnapshot = snapState(useStore.getState())
  const offPrefs = useStore.subscribe((state) => {
    const snap = snapState(state)
    if (snap === prevSnapshot) return
    prevSnapshot = snap
    if (prefTimer) window.clearTimeout(prefTimer)
    prefTimer = window.setTimeout(() => {
      const s = useStore.getState()
      saveSettings(
        s.settings.logDir,
        s.settings.screenshotDir,
        s.settings.deleteScreenshots,
        undefined,
        collectUiPrefs(),
      ).catch(() => {})
    }, 400)
  })

  return () => {
    offQuest()
    offState()
    offMap()
    offMode()
    offPrefs?.()
  }
}

export async function startWatching(dir?: string): Promise<void> {
  await invoke('start_watching', dir ? { dir } : {})
}

export async function stopWatching(): Promise<void> {
  await invoke('stop_watching')
}

export async function getState(): Promise<WatcherStatePayload> {
  return await invoke<WatcherStatePayload>('get_state')
}

export async function getStats(): Promise<{ inProgress: number; completed: number }> {
  return await invoke('get_stats')
}

export async function getPlayerQuests(): Promise<PlayerQuest[]> {
  return await invoke<PlayerQuest[]>('get_player_quests')
}

export async function getActivity(): Promise<ActivityItem[]> {
  return await invoke<ActivityItem[]>('get_activity')
}

export async function getUnlocked(): Promise<string[]> {
  return await invoke<string[]>('get_unlocked')
}

/** 手动修改任务状态：accept=接取（同时完成前置）、complete=完成、unlock=解锁（含前置未结束任务） */
export async function setQuestStatus(
  questId: string,
  action: 'accept' | 'complete' | 'unlock',
): Promise<{ quests: PlayerQuest[]; unlocked: string[] }> {
  return await invoke<{ quests: PlayerQuest[]; unlocked: string[] }>('set_quest_status', {
    questId,
    action,
  })
}

export async function resetAndRescan(): Promise<void> {
  await invoke('reset_and_rescan')
}

export async function exportData(path: string): Promise<void> {
  await invoke('export_data', { path })
}

export async function importData(path: string): Promise<void> {
  await invoke('import_data', { path })
}

export async function getQuestGraph(): Promise<QuestGraph> {
  return await invoke<QuestGraph>('get_quest_graph')
}

export async function getQuestDetail(questId: string): Promise<QuestDetail | null> {
  return await invoke<QuestDetail | null>('get_quest_detail', { questId })
}

export async function getSettings(): Promise<AppSettings> {
  return await invoke<AppSettings>('get_settings')
}

export async function saveSettings(
  logDir: string,
  screenshotDir: string,
  deleteScreenshots?: boolean,
  profile?: PlayerProfile,
  uiPrefs?: Record<string, unknown>,
): Promise<AppSettings> {
  return await invoke<AppSettings>('save_settings', {
    logDir,
    screenshotDir,
    deleteScreenshots,
    profile,
    uiPrefs,
  })
}

export async function openUrl(url: string): Promise<void> {
  await invoke('open_url', { url })
}

export async function getPlayerPosition(): Promise<PlayerPositionPayload | null> {
  return await invoke<PlayerPositionPayload | null>('get_player_position')
}

export async function getCurrentMap(): Promise<string | null> {
  return await invoke<string | null>('get_current_map')
}

export async function openDataDir(): Promise<void> {
  await invoke('open_data_dir')
}

/**
 * 从 tarkov.dev API 同步服务器时间（用于推算塔科夫游戏内左右局时间）。
 * 取不到（离线 / 接口不可用时）返回 null，前端据此隐藏时间显示。
 * @returns 服务器当前时间的毫秒时间戳
 */
export async function fetchTarkovTime(): Promise<number | null> {
  try {
    const res = await fetch('https://api.tarkov.dev/graphql', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: '{ ServerStatus { currentTime } }' }),
    })
    if (!res.ok) return null
    const json = (await res.json()) as {
      data?: { ServerStatus?: { currentTime?: string }[] | { currentTime?: string } }
    }
    const st = json.data?.ServerStatus
    const cur = Array.isArray(st) ? st[0]?.currentTime : st?.currentTime
    if (!cur) return null
    const ms = Date.parse(cur)
    return Number.isFinite(ms) ? ms : null
  } catch {
    return null
  }
}

export async function getSessionMode(): Promise<string | null> {
  return await invoke<string | null>('get_session_mode')
}

export async function getMaps(): Promise<MapInfo[]> {
  return await invoke<MapInfo[]>('get_maps')
}
