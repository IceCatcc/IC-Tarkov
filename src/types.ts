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
  /** 地图展示名（官方中文，后端由缓存 map_meta.json 解析） */
  mapName: string | null
  /** 任务涉及的所有地图 id（map 字段 + 目标/奖励文本提取） */
  maps: string[]
  /** 贸易条件（商人忠诚等级/好感） */
  traderReqs: TraderReq[]
  /** 是否为旧任务（当前赛季已移除，多为旧 PvP 专属任务） */
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
