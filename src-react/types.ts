// 与 src-tauri 后端事件/命令对应的前端类型定义（Rust 侧 rename_all = "camelCase"）
export type QuestStatus = 'in_progress' | 'completed'

/** 全局通知（顶部居中堆叠，3s 自动关闭） */
export type ToastKind = 'info' | 'accept' | 'done' | 'map'
export interface Toast {
  id: string
  text: string
  kind: ToastKind
  /** 弹出时刻（ms），用于同文本短窗口去重 */
  bornAt: number
}

export interface Reward {
  name: string
  count: number
}

export interface PlayerQuest {
  questId: string
  name: string
  traderId: string
  traderName: string
  acceptedAt: string | null
  completedAt: string | null
  status: QuestStatus
  wiki: string
  minLevel: number | null
  /** 任务涉及的地图 id（normalizedName，来自后端任务索引） */
  maps: string[]
}

export type ActivityKind = 'accept' | 'complete' | 'progress'

export interface ActivityItem {
  id: string
  ts: string
  kind: ActivityKind
  text: string
  /** 关联任务 id：实时事件由 quest-event 带入；后端活动行自带，用于实时/历史按任务去重 */
  questId?: string
}

export interface WatcherState {
  watching: boolean
  logDir: string
  sessions: number
  lastScan: string | null
  error: string | null
}

// 后端 watcher-state 事件载荷（字段与 WatcherState 一致）
export type WatcherStatePayload = WatcherState

// 角色档案（好感度日志无法获取，用户手动填写）
export interface PlayerProfile {
  level: number
  /** traderId -> 忠诚等级 LL(1..4)，未填写视为 1 */
  loyalty: Record<string, number>
  /** 已锁定的地图 id 列表（玩家尚未解锁的地图）；为空表示全部地图可用 */
  lockedMaps: string[]
}

/** 地图列表项（角色页管理地图解锁用） */
export interface MapInfo {
  id: string
  name: string
}

export interface AppSettings {
  logDir: string
  screenshotDir: string
  profile: PlayerProfile
  /** 读取坐标后是否删除截图 */
  deleteScreenshots: boolean
  /** UI 偏好（图谱筛选/模式切换/侧边栏等），持久化于后端 settings.json */
  uiPrefs?: Record<string, unknown>
}

export interface ItemRef {
  id: string
  name: string
  count: number | null
  /** 是否必须在战局内拾取（目标级 foundInRaid，收藏家类任务全为 true） */
  foundInRaid: boolean
}

export interface ObjectiveInfo {
  description: string
  type?: string
  typeZh?: string | null
  count?: number | null
  items: ItemRef[]
}

// 任务图谱
export type TraderReqType = 'level' | 'reputation'

export interface TraderReq {
  traderId: string
  traderName: string
  reqType: TraderReqType | string
  value: number
}

export interface GraphNode {
  id: string
  name: string
  traderId: string
  traderName: string
  prereqs: string[]
  /** PVE 模式下的前置（与 prereqs 不同时非空，如 收视灵药） */
  prereqsPve?: string[]
  minLevel: number | null
  map: string | null
  /** 地图展示名（官方中文，后端由 tarkov.dev 地图数据中文本地化解析） */
  mapName: string | null
  /** 任务涉及的所有地图 id（map 字段 + 目标/奖励文本提取） */
  maps: string[]
  /** 贸易条件（商人忠诚等级/好感） */
  traderReqs: TraderReq[]
  /** 是否为赛季任务（往期赛季任务，当前赛季已移除，多为旧 PvP 专属任务） */
  legacy: boolean
  special: boolean
  /** 任务可用模式：pvp / pve（两者都有则为 ['pvp','pve']） */
  modes?: string[]
  turnIns: ItemRef[]
}

export interface GraphEdge {
  from: string
  to: string
}

export interface QuestGraph {
  nodes: GraphNode[]
  edges: GraphEdge[]
}

export interface PrereqInfo {
  id: string
  name: string
}

export interface QuestDetail {
  id: string
  name: string
  traderName: string
  minLevel: number | null
  wiki: string
  map: string | null
  /** 地图展示名（官方中文） */
  mapName: string | null
  objectives: ObjectiveInfo[]
  rewards: Reward[]
  prereqs: PrereqInfo[]
  /** PVE 模式下的前置 id（与 prereqs 不同时非空） */
  prereqsPve?: string[]
  /** 任务可用模式：pvp / pve */
  modes?: string[]
  traderReqs: TraderReq[]
  legacy: boolean
  special: boolean
}

// 后端通过 'quest-event' 推送的增量事件
export type QuestEventPayload =
  | {
      type: 'accept'
      questId: string
      name: string
      traderId: string
      traderName: string
      objectives: ObjectiveInfo[]
      wiki: string
      minLevel: number | null
      timestamp: string
      source: string
    }
  | {
      type: 'complete'
      questId: string
      name: string
      timestamp: string
      via: string
      source: string
    }
  | {
      type: 'progress'
      timestamp: string
      endpoint: string
      source: string
    }

// ===== 玩家位置（截图文件名解析） =====

export interface PlayerPositionPayload {
  position: { x: number; y: number; z: number }
  /** 面朝方向（度，0 = 游戏 +Z 北向，顺时针增加） */
  rotation: number
  /** 截图捕获时间（文件名日期时间） */
  timestamp: string
  file: string
}

// 'map-changed' 事件载荷：日志检测到进入新地图
export interface MapChangedPayload {
  locationId: string
  timestamp: string
}

// ===== 地图页数据（后端由 tarkov.dev 原始 API JSON 派生，非本地预处理文件） =====

export interface MarkerPosition {
  x: number
  y?: number
  z: number
}

export interface MarkerEntry {
  id?: string
  name?: string
  nameZh?: string | null
  position?: MarkerPosition | null
  top?: number | null
  bottom?: number | null
  faction?: string | null
  categories?: string[]
  kind?: string | null
  icon?: string | null
  /** 撤离要求（合作撤离/信号弹/付费…），来自 tarkov.dev，缺失时为空 */
  requirements?: {
    type: string
    value?: string | null
    /** 物品类要求（itemRequired/payment）携带，用于 popup 显示图标 */
    itemId?: string
    name?: string
    count?: number | null
  }[] | null
}

export interface MapMarkersDoc {
  version: number
  maps: Record<string, Record<string, MarkerEntry[]>>
  /** 游戏 nameId -> normalizedName（来自 json.tarkov.dev） */
  nameIds?: Record<string, string>
  /** 无独立地图的变体 location id 归并规则 */
  nameIdFallback?: Record<string, string>
}

export interface SkeletonLayer {
  name: string
  svgLayer?: string
  tilePath?: string
  show?: boolean
  /** 楼层高度范围（y 轴区间），用于标记自动分层；bounds 区域约束暂不参与判定 */
  extents?: { height?: [number, number] }[]
}

export interface SkeletonMap {
  key: string
  projection: string
  minZoom?: number
  maxZoom?: number
  tileSize?: number
  transform?: number[]
  coordinateRotation?: number
  bounds: [[number, number], [number, number]]
  svgPath?: string
  svgLayer?: string
  tilePath?: string
  layers?: SkeletonLayer[]
  labels?: { position: [number, number]; text: string; rotation?: number; size?: number }[]
}

export interface SkeletonGroup {
  normalizedName: string
  nameZh?: string
  primaryPath?: string
  maps: SkeletonMap[]
}

export interface SkeletonDoc {
  version: number
  groups: SkeletonGroup[]
}

/** 任务目标位置（由原始任务数据的 zones 派生） */
export interface QuestZone {
  nn: string
  position: MarkerPosition
  top?: number | null
  bottom?: number | null
  /** 区域多边形（游戏坐标 x/z），用于绘制半透明黄色区块 */
  outline?: { x: number; z: number }[]
}

export interface QuestZoneObjective {
  type?: string | null
  optional?: boolean
  descZh?: string | null
  maps: string[]
  zones: QuestZone[]
}

export interface QuestZonesDoc {
  version: number
  tasks: Record<
    string,
    { name?: string; nameZh?: string; wiki?: string; objectives: QuestZoneObjective[] }
  >
}

/** 地图 Boss 刷新率（按 normalizedName 索引） */
export interface MapBossesDoc {
  version: number
  source?: string
  maps: Record<
    string,
    { id: string; name: string; nameZh: string; chance: number; locations: number }[]
  >
}

// ===== 游戏数据缓存状态（tarkov.dev 原始 JSON） =====

export interface DataFileStat {
  file: string
  label: string
  bytes: number
  updatedAt: number
}

export interface DataStatus {
  /** 缓存里是否已有完整数据 */
  cached: boolean
  /** 最近一次更新时间（epoch 秒，0 = 未更新过） */
  updatedAt: number
  /** 是否过期（缺失或超过 7 天） */
  stale: boolean
  syncing: boolean
  questCount: number
  mapCount: number
  files: DataFileStat[]
}

/** data-sync-progress 事件：数据更新进度 */
export interface DataSyncProgress {
  running: boolean
  done: number
  total: number
  label: string
  force: boolean
}

/** data-synced 事件：一次更新结束的结果 */
export interface DataSyncReport {
  ok: boolean
  updated: string[]
  failed: string[]
  skipped: number
  updatedAt: number
  message: string
}
