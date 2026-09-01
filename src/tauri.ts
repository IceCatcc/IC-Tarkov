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
  MapMarkersDoc,
  QuestZonesDoc,
  MapBossesDoc,
  SkeletonDoc,
  DataStatus,
} from './types'

/**
 * 注册全局监听，返回统一清理函数。
 * 每次调用独立注册一组监听；清理可能在某条 listen 尚未完成时发生（异步 IPC），
 * disposed 标记保证「清理后才完成的注册」立即自行注销，既避免重复监听泄漏，
 * 也保证重挂载后能重新注册（不能用模块级布尔守卫——那会让清理后的重挂载
 * 永远不再注册监听，表现为实时活动 / 任务状态 / 地图 / 模式事件全部失效）。
 */
export async function initTauri(): Promise<UnlistenFn> {
  const offs: UnlistenFn[] = []
  let disposed = false
  const track = (off: UnlistenFn) => {
    if (disposed) off()
    else offs.push(off)
  }
  const { applyEvent, setWatcher, pushToast } = useStore.getState()

  // 任务接取 / 完成 → 全局通知
  track(
    await listen<QuestEventPayload>('quest-event', (e) => {
      const p = e.payload
      applyEvent(p)
      if (p.type === 'accept') pushToast(`接取任务：${p.name} · ${p.traderName}`, 'accept')
      else if (p.type === 'complete') pushToast(`完成任务：${p.name}`, 'done')
    }),
  )
  track(
    await listen<WatcherStatePayload>('watcher-state', (e) => {
      setWatcher(e.payload)
    }),
  )

  // 全局监听当前地图变化：任何页面（含非地图页）收到 map-changed 都写入 store，
  // 保证在别的页面进入某张地图时全局当前地图被更新，切回地图页即默认切换到对应地图。
  const { setCurrentMapId, setMapNames } = useStore.getState()
  track(
    await listen<{ locationId: string; timestamp?: string }>('map-changed', (e) => {
      setCurrentMapId(e.payload.locationId)
      // 进入地图 → 全局通知（名称取启动时缓存的地图名表）
      const name = useStore.getState().mapNames[e.payload.locationId]
      pushToast(`进入地图：${name ?? e.payload.locationId}`, 'map')
    }),
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

  // 全局监听会话模式（pve/pvp）：游戏以某模式启动时，任务图谱自动跟随切换并触发通知
  const { applyDetectedMode, pushToast } = useStore.getState()
  track(
    await listen<{ mode: string; timestamp?: string }>('session-mode', (e) => {
      const mode = e.payload.mode === 'pve' ? 'pve' : 'pvp'
      if (applyDetectedMode(mode)) {
        pushToast(`检测到进入模式：${mode === 'pve' ? 'PvE 赛季' : 'PvP 赛季'}`, 'info')
      }
    }),
  )
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
    'uiScale',
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

  track(offPrefs)

  return () => {
    disposed = true
    offs.forEach((off) => off())
    offs.length = 0
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

export type DataLocation = 'appdata' | 'portable'

export async function getDataLocation(): Promise<DataLocation> {
  return (await invoke<string>('get_data_location')) as DataLocation
}

export async function setDataLocation(location: DataLocation): Promise<void> {
  await invoke('set_data_location', { location })
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

/* ================= 游戏数据（tarkov.dev 原始 API JSON） ================= */

/** 缓存状态：是否完整、更新时间、是否过期、派生出的任务/地图数量 */
export async function getDataStatus(): Promise<DataStatus> {
  return await invoke<DataStatus>('get_data_status')
}

/**
 * 触发数据更新：后端重新请求 tarkov.dev 的原始端点并刷新缓存，
 * 完成后重建派生索引并发出 data-reloaded 事件。
 * @param force true = 忽略 7 天过期判断，全部重下
 */
export async function refreshGameData(force = true): Promise<void> {
  await invoke('refresh_game_data', { force })
}

export async function getMapMarkers(): Promise<MapMarkersDoc> {
  return await invoke<MapMarkersDoc>('get_map_markers')
}

export async function getQuestZones(): Promise<QuestZonesDoc> {
  return await invoke<QuestZonesDoc>('get_quest_zones')
}

export async function getMapBosses(): Promise<MapBossesDoc | null> {
  return await invoke<MapBossesDoc | null>('get_map_bosses')
}

export async function getMapsSkeleton(): Promise<SkeletonDoc> {
  return await invoke<SkeletonDoc>('get_maps_skeleton')
}
