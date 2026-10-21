import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { invoke } from '@tauri-apps/api/core'
import { useStore, collectUiPrefs, normQuestMode } from '../store'
import { sendLanMsg } from '../lan'
import { traderDisplayName } from '../traderMeta'

/**
 * 事件自带的任务模式与当前档位不同时自动跟随切换。
 * 手机端没有本地日志，全靠电脑端推来的事件（quest-event / session-mode 等都带 mode）
 * 或同步快照来对齐档位；桌面端则由日志的 session-mode 事件对齐。
 */
function followEventMode(mode?: string): void {
  if (!mode) return
  const s = useStore.getState()
  const m = normQuestMode(mode)
  if (m !== s.questMode) s.applyDetectedMode(m)
}
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
  DisplayInfo,
  DisplayFilterParams,
  DisplayFilterState,
  BossMonitorPayload,
  LoggingConfigStatus,
} from '../types'

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
      // 事件来自某个会话模式：档位不同则先跟随切换（切换会重新拉取该模式的全量进度）
      followEventMode(p.mode)
      applyEvent(p)
      if (p.type === 'accept')
        pushToast(`接取任务：${p.name} · ${traderDisplayName(p.traderId, p.traderName)}`, 'accept')
      else if (p.type === 'complete') pushToast(`完成任务：${p.name}`, 'done')
    }),
  )
  track(
    await listen<WatcherStatePayload>('watcher-state', (e) => {
      setWatcher(e.payload)
    }),
  )
  // 同步：电脑端的收藏进度变化（本机操作的后端事件回声为同值，无害）
  track(
    await listen<string[]>('collected-changed', (e) => {
      useStore.getState().setCollectedItems(e.payload)
    }),
  )
  // 同步：任务目标的手动打勾进度（对端改动后同步过来，本机操作的后端回声为同值）
  track(
    await listen<{ questId: string; objectivesDone: string[] }>('objective-changed', (e) => {
      const p = e.payload
      if (p?.questId) useStore.getState().setObjectivesDone(p.questId, p.objectivesDone ?? [])
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
  // 进图 / 出图：战局计时（地图页 BTR 跟踪用）。手机端由电脑端经局域网转发同一事件
  track(
    await listen<RaidStatePayload>('raid-changed', (e) => {
      useStore.getState().setRaid(e.payload)
    }),
  )
  getRaidState()
    .then((r) => {
      if (r) useStore.getState().setRaid(r)
    })
    .catch(() => {})

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

  // 全局监听会话模式（pvp/pvps/pve）：游戏以某模式启动时（或电脑端经 LAN 推来）自动跟随切换
  const { applyDetectedMode } = useStore.getState()
  track(
    await listen<{ mode: string; timestamp?: string }>('session-mode', (e) => {
      const mode = normQuestMode(e.payload.mode)
      if (applyDetectedMode(mode)) {
        const label: Record<string, string> = { pvp: 'PvP', pvps: 'PvP 赛季', pve: 'PvE' }
        pushToast(`检测到进入模式：${label[mode] ?? mode.toUpperCase()}`, 'info')
      }
    }),
  )
  getSessionMode()
    .then((m) => {
      if (m) applyDetectedMode(m)
    })
    .catch(() => {})

  // 本地战局 Boss 监控：确认刷新时弹顶部悬浮通知。
  // 后端只在快照变化时 emit，这里按「会话 + 战局 + 地图」去重，避免重连 / 重扫重复提示。
  const bossNames = new Map<string, string>()
  getMapBosses()
    .then((doc) => {
      for (const [nn, list] of Object.entries(doc?.maps ?? {})) {
        for (const b of list ?? []) {
          bossNames.set(`${b.id.toLowerCase()}|${nn}`, b.nameZh || b.name || b.id)
        }
      }
    })
    .catch(() => {})
  const bossToastSeen = new Set<string>()
  let bossRaidKey = ''
  // 快照同时写进全局 store：地图页的 Boss 刷新率面板直接据此改颜色，无需自己再 invoke
  const { setBoss } = useStore.getState()
  getBossMonitor()
    .then((b) => setBoss(b))
    .catch(() => {})
  track(
    await listen<BossMonitorPayload>('boss-monitor', (e) => {
      const p = e.payload
      setBoss(p)
      const raidKey = `${p.session}|${p.raidId}|${p.map}`
      if (raidKey !== bossRaidKey) {
        // 换局 / 换图（含刚开启监控时的历史回放）：已刷新的一律不补弹通知
        bossRaidKey = raidKey
        bossToastSeen.clear()
        for (const b of p.bosses ?? []) {
          if (b.status === 'confirmed') bossToastSeen.add(`${raidKey}|${b.role.toLowerCase()}`)
        }
        const ready = p.btr?.readyAt ?? []
        if (ready.length) bossToastSeen.add(`${raidKey}|btr|${ready[ready.length - 1]}`)
        return
      }
      if (!p.enabled || !p.notify || p.ended || !p.map) return
      for (const b of p.bosses ?? []) {
        if (b.status !== 'confirmed') continue
        const k = `${raidKey}|${b.role.toLowerCase()}`
        if (bossToastSeen.has(k)) continue
        bossToastSeen.add(k)
        // 只提示本图 Boss 表里有的角色（普通 AI / 其它图的 Boss 不打扰）
        const name = bossNames.get(`${b.role.toLowerCase()}|${p.map}`)
        if (!name) continue
        pushToast(`Boss 已刷新：${name}${p.mapName ? `（${p.mapName}）` : ''}`, 'boss')
      }
      // BTR：出发准备信号（BTR 即将沿路线发车）
      const ready = p.btr?.readyAt ?? []
      if (ready.length) {
        const last = ready[ready.length - 1]
        const k = `${raidKey}|btr|${last}`
        if (!bossToastSeen.has(k)) {
          bossToastSeen.add(k)
          pushToast(`BTR 出发准备信号${p.mapName ? `（${p.mapName}）` : ''}`, 'boss')
        }
      }
    }),
  )

  // —— UI 偏好统一持久化到后端 settings.json（localStorage 仅作首帧缓存）——
  // 启动恢复在 App.tsx 拿到 getSettings 结果后调用 applyUiPrefs；
  // 这里订阅偏好字段变化，防抖写回后端。
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
    'bossMarkers',
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
      const s = useStore.getState()
      saveSettings(
        s.settings.logDir,
        s.settings.screenshotDir,
        s.settings.deleteScreenshots,
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

/**
 * 启动进度（「读取中 xx」）：后端后台加载线程上报的当前步骤。
 * 事件为 `startup-step`（见 boot.ts），本命令用于挂载时先查一次当前状态。
 */
export interface StartupState {
  /** 步骤键：同一键内只更新文案（如数据集读取的各子阶段） */
  step: string
  label: string
  /** 后台资料读取是否已结束（成功与失败都为 true） */
  done: boolean
  error: string | null
}

export async function getStartupState(): Promise<StartupState> {
  return await invoke<StartupState>('get_startup_state')
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

/** 手动修改任务状态：accept=接取（同时完成前置）、complete=完成、unlock=解锁、reset=重置为未接取 */
export async function setQuestStatus(
  questId: string,
  action: 'accept' | 'complete' | 'unlock' | 'reset',
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

/** 某任务里已手动打勾完成的目标 id */
export async function getObjectivesDone(questId: string): Promise<string[]> {
  return await invoke<string[]>('get_objectives_done', { questId })
}

/** 单独勾选 / 取消勾选某个任务目标（不改变任务本身的接取 / 完成状态），返回更新后的全集 */
export async function setObjectiveStatus(
  questId: string,
  objectiveId: string,
  done: boolean,
): Promise<string[]> {
  return await invoke<string[]>('set_objective_status', { questId, objectiveId, done }).then((r) => {
    // 已连接电脑端时反向同步过去（电脑端执行后经事件广播回所有端）
    sendLanMsg({ type: 'set-objective-status', questId, objectiveId, done })
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

/** 精简日志：就地清掉日志目录下各 .log 里的无关输出（进入地图等），只保留任务相关信息 */
export async function simplifyLogs(): Promise<SimplifyLogResult> {
  return await invoke<SimplifyLogResult>('simplify_logs')
}

export async function getQuestGraph(): Promise<QuestGraph> {
  return await invoke<QuestGraph>('get_quest_graph')
}

/** 全部物品目录（物品列表用）：id + 中文名 + 主类型 */
export async function getItems(): Promise<ItemInfo[]> {
  return await invoke<ItemInfo[]>('get_items')
}

/** 全部藏身处配方（工具 → 配方查询）：材料与产物都带跳蚤 24h 均价 */
export async function getCrafts(): Promise<CraftInfo[]> {
  return await invoke<CraftInfo[]>('get_crafts')
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
  uiPrefs?: Record<string, unknown>,
): Promise<AppSettings> {
  return await invoke<AppSettings>('save_settings', {
    logDir,
    screenshotDir,
    deleteScreenshots,
    uiPrefs,
  })
}

/**
 * 移动端屏幕常亮开关：写入 settings.json 并立即生效（Android 切换 Window flag）。
 * 桌面端无对应能力，仅持久化设置。
 */
export async function setKeepScreenOn(enable: boolean): Promise<AppSettings> {
  return await invoke<AppSettings>('set_keep_screen_on', { enable })
}

export async function openUrl(url: string): Promise<void> {
  await invoke('open_url', { url })
}

/* ---------------- 显示器滤镜（显卡 gamma ramp） ---------------- */

/** 枚举已接入的显示器（非 Windows 桌面 / 浏览器端为空列表） */
export async function listDisplays(): Promise<DisplayInfo[]> {
  return await invoke<DisplayInfo[]>('list_displays')
}

/** 读取整机滤镜状态（含内置方案） */
export async function getDisplayFilter(): Promise<DisplayFilterState> {
  return await invoke<DisplayFilterState>('get_display_filter')
}

/** 只落盘不改变画面（总开关、方案增删等） */
export async function saveDisplayFilter(state: DisplayFilterState): Promise<void> {
  await invoke('save_display_filter', { state })
}

/** 把参数下发到一台显示器并记入存档；selected 同步落盘（快捷键的目标） */
export async function applyDisplayFilter(
  displayId: string,
  params: DisplayFilterParams,
  selected?: string | null,
): Promise<void> {
  await invoke('apply_display_filter', { displayId, params, selected: selected ?? null })
}

/** 还原显示器：省略 displayId 表示还原全部 */
export async function resetDisplayFilter(displayId?: string): Promise<void> {
  await invoke('reset_display_filter', { displayId: displayId ?? null })
}

/** 当前进程是否以管理员身份运行（游戏提权运行时需要同级权限才能收到全局热键） */
export async function isElevated(): Promise<boolean> {
  return await invoke<boolean>('is_elevated')
}

/** 以管理员身份重启本程序（弹 UAC，成功后当前进程退出） */
export async function relaunchAsAdmin(): Promise<void> {
  await invoke('relaunch_as_admin')
}

/* ---------------- 本地战局 Boss 监控（桌面端） ---------------- */

/** 当前监控快照（顺带让后端立即扫一次日志） */
export async function getBossMonitor(): Promise<BossMonitorPayload> {
  return await invoke<BossMonitorPayload>('boss_get_state')
}

/** 开关监控（关闭会清空实时状态，设置仍落盘） */
export async function setBossMonitorEnabled(enabled: boolean): Promise<BossMonitorPayload> {
  return await invoke<BossMonitorPayload>('boss_set_enabled', { enabled })
}

/** 是否在确认刷新时弹顶部通知 */
export async function setBossMonitorNotify(notify: boolean): Promise<BossMonitorPayload> {
  return await invoke<BossMonitorPayload>('boss_set_notify', { notify })
}

/** Logging.config 当前位置 / aiData 级别 / 备份情况（顺带自动探测游戏目录） */
export async function getBossLoggingStatus(): Promise<LoggingConfigStatus> {
  return await invoke<LoggingConfigStatus>('boss_logging_status')
}

/** 指定游戏安装目录（含 EscapeFromTarkov.exe）或直接指定 Logging.config */
export async function setBossGameRoot(path: string): Promise<LoggingConfigStatus> {
  return await invoke<LoggingConfigStatus>('boss_set_game_root', { path })
}

/** 一键把 aiData 的 minLevel 改成 Trace（改前备份原文件） */
export async function applyBossLoggingConfig(): Promise<LoggingConfigStatus> {
  return await invoke<LoggingConfigStatus>('boss_apply_logging')
}

/** 一键恢复：把备份写回 Logging.config */
export async function restoreBossLoggingConfig(): Promise<LoggingConfigStatus> {
  return await invoke<LoggingConfigStatus>('boss_restore_logging')
}

export async function getPlayerPosition(): Promise<PlayerPositionPayload | null> {
  return await invoke<PlayerPositionPayload | null>('get_player_position')
}

export async function getCurrentMap(): Promise<string | null> {
  return await invoke<string | null>('get_current_map')
}

/** 当前战局状态（进图 / 出图时间）：BTR 跟踪的计时基准 */
export async function getRaidState(): Promise<RaidStatePayload | null> {
  return await invoke<RaidStatePayload | null>('get_raid_state')
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

/** 切换界面查看的任务模式（pvp / pvps / pve）：后端据此读取与写入对应的那套数据 */
export async function setViewMode(mode: 'pvp' | 'pvps' | 'pve'): Promise<void> {
  await invoke('set_view_mode', { mode })
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
 * 触发数据更新：后端向 tarkov.dev 逐项发条件请求（带上次记录的 ETag），
 * 内容没变的端点返回 304、不传输响应体；有变化的才下载，完成后重建派生索引。
 * @param force true = 忽略 ETag 强制全量重下（本地缓存疑似损坏时用）
 */
export async function refreshGameData(force = false): Promise<void> {
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

/** 本机可连接 IP + 端口（用于渲染二维码） */
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

/** 数据摘要：判断两端用户数据是否一致（不含日志目录等仅属于单机的字段） */
export interface SyncSummary {
  /** 有进度的任务数（进行中 + 已完成） */
  questCount: number
  /** 已完成的任务数 */
  completedCount: number
  /** 收藏家已收集物品数 */
  collectedCount: number
  /** 手动解锁的任务数 */
  unlockedCount: number
  /** 内容指纹：两端一致即代表数据相同 */
  hash: string
  /** 是否为空数据（全新安装 / 从未记录进度） */
  empty: boolean
}

/** 本端数据摘要：手机端连接时上报，电脑端据此判断两端是否一致 */
export async function getSyncSummary(): Promise<SyncSummary> {
  return await invoke<SyncSummary>('get_sync_summary')
}

/**
 * 两端数据不一致时，由电脑端选择以哪一端数据为准。
 * side：local=用电脑端数据覆盖手机 / remote=用手机端数据覆盖电脑 / skip=暂不同步
 */
export async function resolveLanConflict(side: 'local' | 'remote' | 'skip'): Promise<void> {
  await invoke('resolve_lan_conflict', { side })
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
