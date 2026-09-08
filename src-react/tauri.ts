import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { invoke } from '@tauri-apps/api/core'
import { useStore, collectUiPrefs } from './store'
import { sendLanMsg } from './lan'
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
  // 同步：电脑端的收藏进度 / 档案变化（本机操作的后端事件回声为同值，无害）
  track(
    await listen<string[]>('collected-changed', (e) => {
      useStore.getState().setCollectedItems(e.payload)
    }),
  )
  track(
    await listen<PlayerProfile>('profile-changed', (e) => {
      if (e.payload) {
        const s = useStore.getState()
        s.setSettings({ ...s.settings, profile: e.payload })
      }
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
  const { applyDetectedMode } = useStore.getState()
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
    'autoCenter',
    'focusZoom',
    'untrackedQuests',
    'mapChips',
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

/** 收藏家任务 id（数据集里找不到时为 null） */
export async function getCollectorQuestId(): Promise<string | null> {
  return await invoke<string | null>('get_collector_quest_id')
}

/** 已收集的物品 id 列表（持久化于 collected.json） */
export async function getCollectedItems(): Promise<string[]> {
  return await invoke<string[]>('get_collected_items')
}

/** 标记 / 取消标记收集品，返回更新后的全集 */
export async function setItemCollected(
  itemId: string,
  collected: boolean,
): Promise<string[]> {
  return await invoke<string[]>('set_item_collected', { itemId, collected }).then((r) => {
    // 反向同步收藏变化到电脑端
    sendLanMsg({ type: 'set-item-collected', itemId, collected })
    return r
  })
}

/** 手动修改任务状态：accept=接取（同时完成前置）、complete=完成、unlock=解锁（含前置未结束任务） */
export async function setQuestStatus(
  questId: string,
  action: 'accept' | 'complete' | 'unlock',
): Promise<{ quests: PlayerQuest[]; unlocked: string[] }> {
  return await invoke<{ quests: PlayerQuest[]; unlocked: string[] }>('set_quest_status', {
    questId,
    action,
  }).then((r) => {
    // 已连接电脑端时，把操作反向同步过去（电脑端执行后经事件广播回所有端）
    sendLanMsg({ type: 'set-quest-status', questId, action })
    return r
  })
}

export async function resetAndRescan(mode?: string): Promise<void> {
  await invoke('reset_and_rescan', { mode })
}

/** 导出数据 zip。path 省略时（移动端）自动导出到数据目录，返回实际导出路径 */
export async function exportData(path?: string): Promise<string> {
  return await invoke<string>('export_data', { path: path ?? null })
}

export async function importData(path: string): Promise<void> {
  await invoke('import_data', { path })
}

/** 移动端导入：前端用 plugin-fs 读取 content:// URI 字节后传入 */
export async function importDataBytes(bytes: Uint8Array): Promise<void> {
  await invoke('import_data_bytes', { bytes })
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
  // 档案变化反向同步到电脑端（仅显式携带 profile 时；先发，不依赖本机保存成功）
  if (profile) sendLanMsg({ type: 'set-profile', profile })
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

/** 数据根目录自动探测结果（后端 get_data_location） */
export interface DataLocation {
  /** 实际生效的根：portable = 程序目录 data；appdata = AppData */
  kind: 'appdata' | 'portable'
  /** 实际生效根目录的完整路径 */
  root: string
  /** 程序目录 data 里是否已有数据 */
  portableHasData: boolean
  /** AppData 里是否已有数据 */
  appdataHasData: boolean
}

export async function getDataLocation(): Promise<DataLocation> {
  return await invoke<DataLocation>('get_data_location')
}

/** 迁移数据目录到目标位置（后端 set_data_location）：
 * 写入 settings.json 的数据位置记录，并把 settings / 任务进度 / tarkov-api 缓存整体搬过去。
 * @param kind 目标位置：portable = 程序目录 data；appdata = AppData
 */
export async function setDataLocation(
  kind: DataLocation['kind'],
): Promise<DataLocation> {
  return await invoke<DataLocation>('set_data_location', { kind })
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

/* ================= 同步（电脑端本地服务） ================= */

export interface ConnectInfo {
  hosts: string[]
  port: number
  token: string
}

export interface LanStatus {
  running: boolean
  port: number
  connections: number
}

/** 启动电脑端局域网服务（幂等）；供手机扫码连接 */
export async function startLanSync(): Promise<void> {
  await invoke('start_lan_sync')
}

/** 停止局域网服务 */
export async function stopLanSync(): Promise<void> {
  await invoke('stop_lan_sync')
}

/** 服务运行状态、端口与当前连接数 */
export async function getLanStatus(): Promise<LanStatus> {
  return await invoke<LanStatus>('get_lan_status')
}

/** 本机可连接 IP + 端口 + 配对 token（用于渲染二维码） */
export async function getConnectInfo(): Promise<ConnectInfo> {
  return await invoke<ConnectInfo>('get_connect_info')
}

/** 当前全量快照（settings + 任务进度）JSON 字符串 */
export async function getSnapshot(): Promise<string> {
  return await invoke<string>('get_snapshot')
}

/** 应用手机端推来的快照（反向同步） */
export async function applySnapshot(json: string): Promise<void> {
  await invoke('apply_snapshot', { json })
}

/**
 * 申请相机权限（原生弹窗；桌面无此插件，静默跳过）。
 * WebView 内 getUserMedia 需要 App 先持有 CAMERA 权限。
 */
export async function ensureCameraPermission(): Promise<boolean> {
  try {
    const mod = await import('@tauri-apps/plugin-barcode-scanner')
    if (typeof mod.requestPermissions === 'function') {
      await mod.requestPermissions()
    }
    return true
  } catch {
    return false
  }
}

/**
 * 原生全屏扫码（插件 Activity）。失败时透出真实错误便于排查。
 */
export async function scanQr(): Promise<{ text: string | null; error?: string }> {
  try {
    const mod = await import('@tauri-apps/plugin-barcode-scanner')
    const text = await mod.scan()
    return { text: typeof text === 'string' && text ? text : null }
  } catch (e) {
    return { text: null, error: String(e) }
  }
}
