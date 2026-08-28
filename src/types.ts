// 与 src-tauri 后端事件/命令对应的前端类型定义（Rust 侧 rename_all = "camelCase"）
export type QuestStatus = 'in_progress' | 'completed'

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
}

export type ActivityKind = 'accept' | 'complete' | 'progress'

export interface ActivityItem {
  id: string
  ts: string
  kind: ActivityKind
  text: string
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
}

export interface AppSettings {
  logDir: string
  screenshotDir: string
  profile: PlayerProfile
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
  minLevel: number | null
  map: string | null
  /** 地图展示名（官方中文，后端由缓存 map_meta.json 解析） */
  mapName: string | null
  /** 贸易条件（商人忠诚等级/好感） */
  traderReqs: TraderReq[]
  /** 是否为旧任务（当前赛季已移除，多为旧 PvP 专属任务） */
  legacy: boolean
  special: boolean
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
