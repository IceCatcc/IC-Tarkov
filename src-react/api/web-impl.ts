/**
 * Web 版数据层实现：与 `tauri-impl.ts` 导出同一套函数，内部改为 HTTP + WebSocket。
 *
 * 页面与 store 只 import `../tauri`，由构建期的路径别名在两套实现之间切换
 * （见 vite.config.ts 的 `@api-impl` 与 tsconfig 的 paths），因此业务代码无需改动。
 *
 * 与桌面端的差异：
 *   - 日志监控 / 截图定位 / 数据目录迁移属于本机能力，web 端不存在 → 空实现
 *   - 局域网同步被「同一账号的多端实时同步」取代（服务端广播 + 各端拉取）
 *   - 数据更新、任务数据等改为服务端共享
 */
import { useStore, collectUiPrefs, normQuestMode } from '../store'
import { traderDisplayName } from '../traderMeta'
import { ICON_DEFAULTS, migrateChips } from '../mapIconGroups'
import { ApiError, request } from './http'
import type {
  QuestEventPayload,
  WatcherStatePayload,
  PlayerQuest,
  ActivityItem,
  QuestGraph,
  QuestDetail,
  AppSettings,
  PlayerPositionPayload,
  MapInfo,
  MapMarkersDoc,
  QuestZonesDoc,
  MapBossesDoc,
  SkeletonDoc,
  DataStatus,
  ItemInfo,
  CraftInfo,
  SimplifyLogResult,
  RaidStatePayload,
} from '../types'

/* ---------------- HTTP 基础 ---------------- */

const NOT_SUPPORTED = '当前环境不支持该功能（桌面端能力）'

export { ApiError }

/** 为查询串补上 mode（未显式指定时由后端取用户的查看模式） */
function withMode(path: string, mode?: string): string {
  if (!mode) return path
  return path + (path.includes('?') ? '&' : '?') + `mode=${encodeURIComponent(mode)}`
}

/* ---------------- 实时通道 ---------------- */

type EventHandler = (payload: unknown) => void
type UnlistenFn = () => void

const handlers = new Map<string, Set<EventHandler>>()
let socket: WebSocket | null = null
let reconnectTimer: number | undefined
let closedByUs = false

/** 与服务端建立实时连接（断线自动重连） */
function connectRealtime(): void {
  if (typeof window === 'undefined') return
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
  const url = `${proto}//${location.host}/api/ws`
  const ws = new WebSocket(url)
  socket = ws

  ws.onmessage = (ev) => {
    try {
      const frame = JSON.parse(String(ev.data)) as { type?: string; payload?: unknown }
      if (frame.type) dispatch(frame.type, frame.payload)
    } catch {
      /* 忽略非 JSON 帧 */
    }
  }
  ws.onclose = () => {
    if (closedByUs) return
    // 断线后退避重连（登录态失效时服务端会以 4401 关闭，重连依然会被拒，前端据此可重定向到登录页）
    reconnectTimer = window.setTimeout(connectRealtime, 3000)
  }
  ws.onerror = () => ws.close()
}

function dispatch(type: string, payload: unknown): void {
  const set = handlers.get(type)
  if (!set) return
  for (const fn of set) {
    try {
      fn(payload)
    } catch (e) {
      console.error(`[ws] 处理 ${type} 事件失败`, e)
    }
  }
}

/** 重新拉取当前模式的全部用户数据（导入后、或其它设备的批量改动后调用） */
async function reloadUserData(): Promise<void> {
  try {
    const [quests, unlocked, collected] = await Promise.all([
      getPlayerQuests(),
      getUnlocked(),
      getCollectedItems(),
    ])
    useStore.setState({
      playerQuests: quests,
      unlockedQuests: unlocked,
      collectedItems: collected,
      // 目标打勾与人物进度一起变了，清掉缓存由各页面按需重取
      objectivesDone: {},
    })
  } catch {
    /* 失败时保持现有数据 */
  }
}

/** 注册事件回调（返回取消函数）；与 Tauri listen 的用法一致 */
function on(type: string, fn: EventHandler): UnlistenFn {
  let set = handlers.get(type)
  if (!set) {
    set = new Set()
    handlers.set(type, set)
  }
  set.add(fn)
  return () => set!.delete(fn)
}

/* ---------------- 初始化（对应 initTauri） ---------------- */

export async function initTauri(): Promise<UnlistenFn> {
  const offs: UnlistenFn[] = []
  const { applyEvent, setWatcher, pushToast, setCurrentMapId, setMapNames } = useStore.getState()

  offs.push(
    on('quest-event', (raw) => {
      const p = raw as QuestEventPayload
      if (p?.mode && normQuestMode(p.mode) !== useStore.getState().questMode) return
      applyEvent(p)
      if (p.type === 'accept')
        pushToast(`接取任务：${p.name} · ${traderDisplayName(p.traderId, p.traderName)}`, 'accept')
      else if (p.type === 'complete') pushToast(`完成任务：${p.name}`, 'done')
    }),
  )

  offs.push(
    on('watcher-state', (raw) => setWatcher(raw as WatcherStatePayload)),
  )

  offs.push(
    on('collected-changed', (raw) => {
      const p = raw as { mode?: string; items: string[] }
      if (p?.mode && p.mode !== useStore.getState().questMode) return
      useStore.getState().setCollectedItems(p?.items ?? [])
    }),
  )

  offs.push(
    on('objective-changed', (raw) => {
      const p = raw as { mode?: string; questId: string; objectivesDone: string[] }
      if (p?.mode && p.mode !== useStore.getState().questMode) return
      if (p?.questId) useStore.getState().setObjectivesDone(p.questId, p.objectivesDone ?? [])
    }),
  )

  // 同一账号在别处的改动（其它标签页 / 手机）：直接刷新玩家任务列表
  offs.push(
    on('quests-changed', (raw) => {
      const p = raw as { mode?: string }
      if (p?.mode && p.mode !== useStore.getState().questMode) return
      void getPlayerQuests()
        .then((qs) => useStore.setState({ playerQuests: qs }))
        .catch(() => {})
    }),
  )

  // 账号数据被导入（本端或其它设备）：整批重取
  offs.push(
    on('data-imported', () => {
      void reloadUserData()
    }),
  )

  offs.push(
    on('map-changed', (raw) => {
      const p = raw as { locationId: string }
      setCurrentMapId(p.locationId)
      const name = useStore.getState().mapNames[p.locationId]
      pushToast(`进入地图：${name ?? p.locationId}`, 'map')
    }),
  )

  offs.push(
    on('data-reloaded', () => {
      // 服务端完成了数据更新：任务/地图数据需要整页重取
      pushToast('游戏数据已更新', 'info')
      void getMaps()
        .then((list) => {
          if (list?.length) setMapNames(Object.fromEntries(list.map((m) => [m.id, m.name])))
        })
        .catch(() => {})
    }),
  )

  connectRealtime()

  // 初始数据（与桌面端 initTauri 一致）
  getCurrentMap()
    .then((id) => {
      if (id) setCurrentMapId(id)
    })
    .catch(() => {})
  getMaps()
    .then((list) => {
      if (list?.length) setMapNames(Object.fromEntries(list.map((m) => [m.id, m.name])))
    })
    .catch(() => {})
  getSessionMode()
    .then((m) => {
      if (m) useStore.getState().applyDetectedMode(m)
    })
    .catch(() => {})

  // UI 偏好防抖写回服务端
  let prefTimer: number | undefined
  const prefFields = [
    'showCompletedBoard',
    'followDetail',
    'hideLegacyGraph',
    'disabledTradersGraph',
    'questMode',
    'autoZoomMap',
    'autoCenter',
    'focusZoom',
    'untrackedQuests',
    'mapChips',
    'uiScale',
    'wikiWidth',
    'wikiSite',
    'wikiCustom',
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
      saveSettings('', '', undefined, collectUiPrefs()).catch(() => {})
    }, 400)
  })
  offs.push(offPrefs)

  return () => {
    closedByUs = true
    if (reconnectTimer) window.clearTimeout(reconnectTimer)
    socket?.close()
    socket = null
    handlers.clear()
    offs.forEach((off) => off())
    offs.length = 0
  }
}

/* ---------------- 监控状态（web 端无日志监控） ---------------- */

export async function startWatching(_dir?: string): Promise<void> {
  /* 服务端没有本机日志可读；任务进度由用户手动维护或经日志上传接口写入 */
}

export async function stopWatching(): Promise<void> {
  /* 同上 */
}

export async function getState(): Promise<WatcherStatePayload> {
  return request<WatcherStatePayload>('GET', '/api/state')
}

export async function getStats(): Promise<{ inProgress: number; completed: number }> {
  return request('GET', withMode('/api/stats', useStore.getState().questMode))
}

export interface StartupState {
  step: string
  label: string
  done: boolean
  error: string | null
}

/** web 端没有后端资料加载阶段：直接视为完成，启动遮罩只显示前端步骤 */
export async function getStartupState(): Promise<StartupState> {
  return { step: 'ready', label: '准备就绪', done: true, error: null }
}

/* ---------------- 任务进度 ---------------- */

export async function getPlayerQuests(): Promise<PlayerQuest[]> {
  return request('GET', withMode('/api/quests', useStore.getState().questMode))
}

export async function getActivity(): Promise<ActivityItem[]> {
  return request('GET', withMode('/api/activity', useStore.getState().questMode))
}

export async function getUnlocked(): Promise<string[]> {
  return request('GET', withMode('/api/unlocked', useStore.getState().questMode))
}

export async function getCollectorQuestId(): Promise<string | null> {
  return request('GET', '/api/collector-quest-id')
}

export async function getCollectedItems(): Promise<string[]> {
  return request('GET', withMode('/api/collected', useStore.getState().questMode))
}

export async function setItemCollected(itemId: string, collected: boolean): Promise<string[]> {
  return request('PUT', `/api/collected/${encodeURIComponent(itemId)}`, {
    collected,
    mode: useStore.getState().questMode,
  })
}

export async function setQuestStatus(
  questId: string,
  action: 'accept' | 'complete' | 'unlock' | 'reset',
): Promise<{ quests: PlayerQuest[]; unlocked: string[] }> {
  return request('POST', `/api/quests/${encodeURIComponent(questId)}/status`, {
    action,
    mode: useStore.getState().questMode,
  })
}

export async function getObjectivesDone(questId: string): Promise<string[]> {
  return request(
    'GET',
    withMode(`/api/quests/${encodeURIComponent(questId)}/objectives`, useStore.getState().questMode),
  )
}

/** 一次性取回全部任务的目标打勾（地图页预取） */
export async function getAllObjectivesDone(): Promise<Record<string, string[]>> {
  return request('GET', withMode('/api/objectives', useStore.getState().questMode))
}

export async function setObjectiveStatus(
  questId: string,
  objectiveId: string,
  done: boolean,
): Promise<string[]> {
  return request(
    'PUT',
    `/api/quests/${encodeURIComponent(questId)}/objectives/${encodeURIComponent(objectiveId)}`,
    { done, mode: useStore.getState().questMode },
  )
}

/** web 端没有本地日志可重扫 */
export async function resetAndRescan(_mode?: string): Promise<void> {
  throw new Error('Web 端没有本地日志，无法重新扫描')
}

/** 导出：桌面端导出为本地 zip，web 端暂未提供下载 */
export async function exportData(_path?: string): Promise<string> {
  throw new Error(NOT_SUPPORTED)
}

export async function importData(_path: string): Promise<void> {
  throw new Error(NOT_SUPPORTED)
}

export async function importDataBytes(_bytes: Uint8Array): Promise<void> {
  throw new Error(NOT_SUPPORTED)
}

/** web 端没有本地日志可精简 */
export async function simplifyLogs(): Promise<SimplifyLogResult> {
  throw new Error(NOT_SUPPORTED)
}

/* ---------------- 游戏静态数据 ---------------- */

export async function getQuestGraph(): Promise<QuestGraph> {
  return request('GET', '/api/graph')
}

export async function getItems(): Promise<ItemInfo[]> {
  return request('GET', '/api/items')
}

export async function getCrafts(): Promise<CraftInfo[]> {
  return request('GET', '/api/crafts')
}

export async function getQuestDetail(questId: string): Promise<QuestDetail | null> {
  return request('GET', `/api/quests/${encodeURIComponent(questId)}`)
}

export async function getMaps(): Promise<MapInfo[]> {
  return request('GET', '/api/maps')
}

export async function getMapMarkers(): Promise<MapMarkersDoc> {
  return request('GET', '/api/map/markers')
}

export async function getQuestZones(): Promise<QuestZonesDoc> {
  return request('GET', '/api/map/zones')
}

export async function getMapBosses(): Promise<MapBossesDoc | null> {
  return request('GET', '/api/map/bosses')
}

export async function getMapsSkeleton(): Promise<SkeletonDoc> {
  return request('GET', '/api/map/skeleton')
}

/* ---------------- 设置 ---------------- */

/** web 端的 settings 只承载 uiPrefs；目录字段保持形状兼容 */
export async function getSettings(): Promise<AppSettings> {
  return request('GET', '/api/settings')
}

export async function saveSettings(
  _logDir: string,
  _screenshotDir: string,
  _deleteScreenshots?: boolean,
  uiPrefs?: Record<string, unknown>,
): Promise<AppSettings> {
  return request('PUT', '/api/settings', { uiPrefs })
}

export async function setKeepScreenOn(_enable: boolean): Promise<AppSettings> {
  return getSettings()
}

export async function openUrl(url: string): Promise<void> {
  window.open(url, '_blank', 'noopener,noreferrer')
}

/* ---------------- 本机能力（web 端不可用） ---------------- */

export async function getPlayerPosition(): Promise<PlayerPositionPayload | null> {
  return null
}

export async function getCurrentMap(): Promise<string | null> {
  return request('GET', withMode('/api/current-map', useStore.getState().questMode))
}

/**
 * 战局状态：web 端没有日志监控，拿不到进图 / 出图时间。
 * 地图页的 BTR 跟踪退化为手动开始（输入当前战局剩余时间）。
 */
export async function getRaidState(): Promise<RaidStatePayload | null> {
  return null
}

export async function openDataDir(): Promise<void> {
  /* 无本机数据目录 */
}

export interface DataLocation {
  kind: 'appdata' | 'portable'
  root: string
  portableHasData: boolean
  appdataHasData: boolean
}

export async function getDataLocation(): Promise<DataLocation> {
  return { kind: 'portable', root: '（服务端）', portableHasData: true, appdataHasData: false }
}

export async function setDataLocation(_kind: DataLocation['kind']): Promise<DataLocation> {
  return getDataLocation()
}

/* ---------------- 会话模式 ---------------- */

export async function getSessionMode(): Promise<string | null> {
  return request('GET', '/api/session-mode')
}

export async function setViewMode(mode: 'pvp' | 'pvps' | 'pve'): Promise<void> {
  await request('PUT', '/api/mode', { mode })
}

/* ---------------- 数据更新 ---------------- */

export async function getDataStatus(): Promise<DataStatus> {
  return request('GET', '/api/data/status')
}

export async function refreshGameData(force = false): Promise<void> {
  await request('POST', '/api/data/refresh', { force })
}

/**
 * 从 tarkov.dev 取服务器时间（用于推算游戏内左右局时间）。
 * 浏览器直连可能被 CORS 拦截，取不到时返回 null（UI 隐藏该显示）。
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

/* ---------------- 局域网同步（web 端由服务端多端同步取代） ---------------- */

export interface ConnectInfo {
  hosts: string[]
  port: number
}

export interface LanStatus {
  running: boolean
  port: number
  connections: number
}

export async function startLanSync(): Promise<void> {
  /* web 端无局域网服务 */
}

export async function stopLanSync(): Promise<void> {
  /* 同上 */
}

export async function getLanStatus(): Promise<LanStatus> {
  return { running: false, port: 0, connections: 0 }
}

export async function getConnectInfo(): Promise<ConnectInfo> {
  return { hosts: [], port: 0 }
}

export async function getSnapshot(): Promise<string> {
  throw new Error(NOT_SUPPORTED)
}

export async function applySnapshot(_json: string): Promise<void> {
  throw new Error(NOT_SUPPORTED)
}

export interface SyncSummary {
  questCount: number
  completedCount: number
  collectedCount: number
  unlockedCount: number
  hash: string
  empty: boolean
}

export async function getSyncSummary(): Promise<SyncSummary> {
  return { questCount: 0, completedCount: 0, collectedCount: 0, unlockedCount: 0, hash: '', empty: true }
}

export async function resolveLanConflict(_side: 'local' | 'remote' | 'skip'): Promise<void> {
  /* 多端同步由服务端直接完成，无需人工仲裁 */
}

export async function ensureCameraPermission(): Promise<boolean> {
  return false
}

export async function scanQr(): Promise<{ text: string | null; error?: string }> {
  return { text: null, error: NOT_SUPPORTED }
}

/* ---------------- 编译期一致性校验 ---------------- */

/**
 * 下面的赋值要求 web 实现与 Tauri 实现导出同一套函数（缺一个或签名不符都会在编译期报错）。
 * 仅类型层面成立，运行时不会执行。
 */
import type * as TauriApi from './tauri-impl'
const _apiParity: typeof TauriApi = {} as typeof import('./web-impl')
void _apiParity

// 供 store 侧恢复 UI 偏好时复用（与桌面端同一套默认值 / 迁移规则）
export { ICON_DEFAULTS, migrateChips }
