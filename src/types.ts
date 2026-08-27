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

export interface AppSettings {
  logDir: string
  screenshotDir: string
}

// 任务图谱
export interface GraphNode {
  id: string
  name: string
  traderId: string
  traderName: string
  prereqs: string[]
  minLevel: number | null
  map: string | null
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
  objectives: string[]
  rewards: Reward[]
  prereqs: PrereqInfo[]
}

// 后端通过 'quest-event' 推送的增量事件
export type QuestEventPayload =
  | {
      type: 'accept'
      questId: string
      name: string
      traderId: string
      traderName: string
      objectives: string[]
      rewards: Reward[]
      wiki: string
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
