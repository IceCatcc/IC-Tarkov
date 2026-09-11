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
  /** 读取坐标后是否删除截图（开启时启动后产生的不含坐标截图也会被清理） */
  deleteScreenshots: boolean
  /** 移动端屏幕常亮（Android FLAG_KEEP_SCREEN_ON）；桌面端不生效，仅持久化 */
  keepScreenOn: boolean
  /** UI 偏好（图谱筛选/模式切换/侧边栏等），持久化于后端 settings.json */
  uiPrefs?: Record<string, unknown>
}

export interface ItemRef {
  id: string
  name: string
  count: number | null
  /** 是否必须在战局内拾取（目标级 foundInRaid，收藏家类任务全为 true） */
  foundInRaid: boolean
  /** 物品主类型中文名（如「医疗」「钥匙」）；数据包缺少物品类别数据时为 null/undefined */
  category?: string | null
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
  /** 比较方式（>= / <= / < / > 等）。如 Fence「亡羊补牢」要求好感 **小于** 阈值 */
  compare: string
}

/** 按 compare 比较：缺省视为 >= */
export function compareMet(cur: number, value: number, compare: string): boolean {
  switch (compare) {
    case '<':
      return cur < value
    case '<=':
      return cur <= value
    case '>':
      return cur > value
    case '>=':
      return cur >= value
    case '==':
    case '=':
      return cur === value
    default:
      return cur >= value
  }
}

/**
 * 任务的忠诚等级（LL）需求：traderReqs 中 level 与 variable 的最大值；0 = 无要求。
 * variable 是源数据用「商人全局变量」表达的等级条件（详情面板同样按「忠诚等级 LLn」展示），
 * 漏掉它们会让大量任务落进「无要求」档；上限按游戏设定截到 4（variable 取 5 时并入 LL4）。
 */
export function questLoyaltyLevel(n: GraphNode): number {
  let v = 0
  for (const r of n.traderReqs ?? []) {
    if (r.reqType !== 'level' && r.reqType !== 'variable') continue
    if (Number.isFinite(r.value)) v = Math.max(v, r.value)
  }
  return Math.min(4, Math.max(0, v))
}

/** LL 档位文案（图谱顶部标签与任务列表分组共用） */
export function llLabel(ll: number): string {
  return ll >= 1 ? `LL${ll}+` : '无 LL 要求'
}

/** 任务模式：PVP（常驻）/ PVPS（PvP 赛季）/ PVE —— 三种模式进度、收藏、档案各自独立 */
export type QuestMode = 'pvp' | 'pvps' | 'pve'

/** 模式展示名 */
export const QUEST_MODE_LABEL: Record<QuestMode, string> = {
  pvp: 'PVP',
  pvps: 'PVPS',
  pve: 'PVE',
}

/** 条件的比较符号文案 */
export function compareLabel(compare: string): string {
  switch (compare) {
    case '<':
      return '<'
    case '<=':
      return '≤'
    case '>':
      return '>'
    case '>=':
      return '≥'
    case '==':
    case '=':
      return '='
    default:
      return '≥'
  }
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
  /** 转生（Prestige）等级：该任务是第 N 次转生的门槛任务时为 N，否则为空 */
  prestigeLevel?: number | null
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
  /** 转生（Prestige）等级：该任务是第 N 次转生的门槛任务时为 N */
  prestigeLevel?: number | null
}

// 后端通过 'quest-event' 推送的增量事件
// mode = 事件归属的任务模式（日志检测到的会话模式）；与界面查看的模式不一致时应忽略
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
      mode?: string
    }
  | {
      type: 'complete'
      questId: string
      name: string
      timestamp: string
      via: string
      source: string
      mode?: string
    }
  | {
      type: 'progress'
      timestamp: string
      endpoint: string
      source: string
      mode?: string
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
  /** 区域名：狙击 AI 靠它区分（如 ZoneSnipeTower），非所有集合都有 */
  zoneName?: string | null
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
  /** Boss 出生点专用：该 Boss 在本图出现的概率（0~1） */
  spawnChance?: number | null
  /** Boss 出生点专用：区域名（如 ZoneDormitory） */
  locationName?: string | null
  /** Boss 出生点专用：落在该区域的概率（0~1） */
  locationChance?: number | null
  /** 转移点（transits）专用：目的地本地化 key（如 LAB_TRANSIT_8_DESC） */
  destKey?: string | null
  /** 转移点专用：目的地中文名（如「灯塔」） */
  destZh?: string | null
  /** 转移点专用：目标地图 normalizedName */
  toMap?: string | null
  /** 转移点专用：目标地图中文名 */
  toMapZh?: string | null
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
  /** 最近一次数据真正发生变化的时间（epoch 秒，0 = 未更新过） */
  updatedAt: number
  /** 最近一次与服务端核对版本的时间（含「已是最新」，epoch 秒，0 = 未核对过） */
  checkedAt: number
  /** 是否过期（缺失，或距上次核对超过 7 天） */
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
  /** 本次已发现并写入的份数（其余为内容未变、已跳过下载） */
  changed: number
  label: string
  force: boolean
}

/** data-synced 事件：一次更新结束的结果 */
export interface DataSyncReport {
  ok: boolean
  updated: string[]
  failed: string[]
  /** 内容未变化（服务端 304）而跳过下载的端点数 */
  unchanged: number
  updatedAt: number
  message: string
}

