import { create } from 'zustand'
import { useEffect, useState } from 'react'
import type {
  ActivityItem,
  PlayerQuest,
  QuestGraph,
  QuestDetail,
  WatcherState,
  WatcherStatePayload,
  AppSettings,
  QuestEventPayload,
  ItemRef,
} from './types'
import { getQuestDetail } from './tauri'

interface AppState {
  page: 'monitor' | 'graph' | 'map' | 'profile'
  setPage: (p: AppState['page']) => void

  /** 当前游戏所在地图（游戏内部 location id，如 factory4_day），由全局 map-changed 事件写入，任何页面生效 */
  currentMapId: string | null
  setCurrentMapId: (id: string | null) => void
  /** 已解析的地图 normalizedName（MapPage 用 markers 映射后写回），用于切回地图页默认选中 */
  currentMap: string | null
  setCurrentMap: (m: string | null) => void

  settings: AppSettings
  setSettings: (s: AppSettings) => void
  showSettings: boolean
  openSettings: () => void
  closeSettings: () => void

  watcher: WatcherState
  setWatcher: (w: WatcherState) => void

  playerQuests: PlayerQuest[]
  /** 实时活动（本会话内的事件，由 applyEvent 累积），默认只显示这部分 */
  activities: ActivityItem[]
  /** 历史活动（来自持久化文件），默认不读取/不显示，点击「加载更多」才加载 */
  historicalActivities: ActivityItem[]
  historicalLoaded: boolean
  applyEvent: (e: QuestEventPayload) => void
  seedPlayerQuests: (list: PlayerQuest[]) => void
  seedActivity: (list: ActivityItem[]) => void
  setHistoricalActivity: (list: ActivityItem[]) => void
  clearHistorical: () => void

  filter: 'all' | 'in_progress' | 'completed'
  setFilter: (f: 'all' | 'in_progress' | 'completed') => void
  traderFilter: string | null
  setTraderFilter: (t: string | null) => void

  graph: QuestGraph | null
  setGraph: (g: QuestGraph) => void

  /** 手动解锁的任务集合（前置未达成但已解锁为可接取），来自后端持久化 */
  unlockedQuests: string[]
  setUnlockedQuests: (list: string[]) => void

  selectedId: string | null
  detail: QuestDetail | null
  setSelected: (id: string | null, d: QuestDetail | null) => void

  /** 任务详情缓存（按 questId）：监控页任务卡片复用，避免重复请求 */
  questDetails: Record<string, QuestDetail>
  setQuestDetail: (id: string, d: QuestDetail) => void

  /** Wiki 内嵌抽屉 */
  wikiUrl: string | null
  openWiki: (url: string) => void
  closeWiki: () => void

  /** 任务图谱中关闭显示的商人（traderId -> true 为隐藏） */
  disabledTradersGraph: Record<string, boolean>
  toggleTraderGraph: (id: string) => void
  setTraderGraph: (id: string, disabled: boolean) => void

  /** 地图单选筛选：''=全部地区 */
  mapSelGraph: string
  setMapSelGraph: (m: string) => void

  searchGraph: string
  setSearchGraph: (s: string) => void

  hideLegacyGraph: boolean
  setHideLegacyGraph: (v: boolean) => void
  /** 仅显示商人忠诚等级达标的任务（搜索时忽略） */
  repMetGraph: boolean
  setRepMetGraph: (v: boolean) => void
  /** 仅显示玩家等级足够的任务（搜索时忽略） */
  lvlMetGraph: boolean
  setLvlMetGraph: (v: boolean) => void
  /** 仅显示地图已解锁（未锁定）的任务 */
  mapUnlockedGraph: boolean
  setMapUnlockedGraph: (v: boolean) => void
  /** 已完成任务的显示开关：勾选显示、不勾选排除（持久化，替代原专注模式） */
  showCompletedGraph: boolean
  setShowCompletedGraph: (v: boolean) => void
  /** 任务图谱模式过滤：'pvp' | 'pve'（localStorage 持久化；日志检测到会话模式时自动跟随） */
  questMode: 'pvp' | 'pve'
  setQuestMode: (v: 'pvp' | 'pve') => void
  /** 日志检测到会话模式时调用：自动切换 questMode 并持久化 */
  applyDetectedMode: (m: string) => void
  /** 用后端 settings.json 的 uiPrefs 批量恢复 UI 偏好（仅启动时调用，不回写） */
  applyUiPrefs: (p: Record<string, unknown>) => void
}

/** 页面顶部行的左侧预留：导航已移至顶部栏，恒为 0（保留函数签名减少页面改动） */
export function useTopPad(): number {
  return 0
}

function uid(): string {
  return Math.random().toString(36).slice(2, 10)
}

// —— 任务图谱筛选偏好持久化（localStorage）——
// 好感达标 / 等级达标 / 地图解锁 / 专注模式 / 商人隐藏 的勾选状态跨启动保留。
const GRAPH_PREFS_KEY = 'eft-spy.graphPrefs.v1'
// 默认不勾选（即隐藏）的特殊商人：竞技场裁判、BTR 司机、灯塔守护者
const DEFAULT_DISABLED_TRADERS = [
  '6617beeaa9cfa777ca915b7c', // 竞技场裁判
  '656f0f98d80a697f855d34b1', // BTR 司机
  '638f541a29ffd1183d187f57', // 灯塔守护者
]

interface GraphPrefs {
  repMet: boolean
  lvlMet: boolean
  mapUnlocked: boolean
  showCompleted: boolean
  hideLegacy: boolean
  disabledTraders: Record<string, boolean>
  questMode: 'pvp' | 'pve'
}

function loadGraphPrefs(): GraphPrefs {
  const fallback: GraphPrefs = {
    repMet: true,
    lvlMet: false,
    mapUnlocked: false,
    showCompleted: false, // 默认排除已完成任务（「已完成」勾选才显示）
    hideLegacy: true, // 默认隐藏旧任务（「旧任务」勾选才显示）
    disabledTraders: Object.fromEntries(DEFAULT_DISABLED_TRADERS.map((id) => [id, true])),
    questMode: 'pvp',
  }
  try {
    const raw = localStorage.getItem(GRAPH_PREFS_KEY)
    if (!raw) return fallback
    const p = JSON.parse(raw) as Partial<GraphPrefs>
    return {
      repMet: p.repMet ?? fallback.repMet,
      lvlMet: p.lvlMet ?? fallback.lvlMet,
      mapUnlocked: p.mapUnlocked ?? fallback.mapUnlocked,
      showCompleted: p.showCompleted ?? fallback.showCompleted,
      hideLegacy: p.hideLegacy ?? fallback.hideLegacy,
      disabledTraders: { ...fallback.disabledTraders, ...(p.disabledTraders ?? {}) },
      questMode: p.questMode === 'pve' ? 'pve' : 'pvp',
    }
  } catch {
    return fallback
  }
}

function persistGraphPrefs() {
  const s = useStore.getState()
  const data: GraphPrefs = {
    repMet: s.repMetGraph,
    lvlMet: s.lvlMetGraph,
    mapUnlocked: s.mapUnlockedGraph,
    showCompleted: s.showCompletedGraph,
    hideLegacy: s.hideLegacyGraph,
    disabledTraders: s.disabledTradersGraph,
    questMode: s.questMode,
  }
  try {
    localStorage.setItem(GRAPH_PREFS_KEY, JSON.stringify(data))
  } catch {
    /* 忽略写入失败（隐私模式等） */
  }
}

/** 供后端持久化：收集当前全部 UI 偏好（与 settings.json 的 uiPrefs 字段对应） */
export function collectUiPrefs(): Record<string, unknown> {
  const s = useStore.getState()
  return {
    graphPrefs: {
      repMet: s.repMetGraph,
      lvlMet: s.lvlMetGraph,
      mapUnlocked: s.mapUnlockedGraph,
      showCompleted: s.showCompletedGraph,
      hideLegacy: s.hideLegacyGraph,
      disabledTraders: s.disabledTradersGraph,
      questMode: s.questMode,
    } satisfies GraphPrefs,
  }
}

interface UiPrefsShape {
  graphPrefs?: Partial<GraphPrefs>
}

const prefs0 = loadGraphPrefs()

export const useStore = create<AppState>((set) => ({
  page: 'monitor',
  setPage: (p) => set({ page: p }),

  currentMapId: null,
  setCurrentMapId: (id) => set({ currentMapId: id }),
  currentMap: null,
  setCurrentMap: (m) => set({ currentMap: m }),

  settings: { logDir: '', screenshotDir: '', profile: { level: 1, loyalty: {}, lockedMaps: [] }, deleteScreenshots: true },
  setSettings: (s) => set({ settings: s }),
  showSettings: false,
  openSettings: () => set({ showSettings: true }),
  closeSettings: () => set({ showSettings: false }),

  watcher: {
    watching: false,
    logDir: '',
    sessions: 0,
    lastScan: null,
    error: null,
  },
  setWatcher: (w) =>
    set({
      watcher: {
        logDir: w.logDir,
        sessions: w.sessions,
        lastScan: w.lastScan,
        watching: w.watching,
        error: w.error,
      },
    }),

  playerQuests: [],
  activities: [],
  historicalActivities: [],
  historicalLoaded: false,

  filter: 'all',
  setFilter: (f) => set({ filter: f }),
  traderFilter: null,
  setTraderFilter: (t) => set({ traderFilter: t }),

  applyEvent: (e) =>
    set((state) => {
      // 内容级去重：开发热重载反复读取日志时，相同事件（类型+文本+时间戳）只保留一条
      const isDup = (kind: ActivityItem['kind'], text: string, ts: string) =>
        state.activities.some((a) => a.kind === kind && a.text === text && a.ts === ts)

      const activities = state.activities.slice()

      if (e.type === 'progress') {
        // 同步任务列表等进度噪声：不进实时活动流，也不进历史
        return {}
      }

      if (e.type === 'accept') {
        const acceptText = `接取 ${e.name} · ${e.traderName}`
        if (isDup('accept', acceptText, e.timestamp)) return {}
        const idx = state.playerQuests.findIndex((q) => q.questId === e.questId)
        let playerQuests: PlayerQuest[]
        if (idx >= 0) {
          const prev = state.playerQuests[idx]
          playerQuests = state.playerQuests.slice()
          playerQuests[idx] = {
            ...prev,
            name: e.name,
            traderId: e.traderId,
            traderName: e.traderName,
            acceptedAt: e.timestamp,
            status: prev.completedAt ? 'completed' : 'in_progress',
            wiki: e.wiki,
          }
        } else {
          playerQuests = [
            ...state.playerQuests,
            {
              questId: e.questId,
              name: e.name,
              traderId: e.traderId,
              traderName: e.traderName,
              acceptedAt: e.timestamp,
              completedAt: null,
              status: 'in_progress',
              wiki: e.wiki,
              minLevel: null,
            },
          ]
        }
        activities.unshift({
          id: uid(),
          ts: e.timestamp,
          kind: 'accept',
          text: acceptText,
        })
        return { playerQuests, activities: activities.slice(0, 20) }
      }

      // complete
      const completeText = `完成 ${e.name}（${e.via}）`
      if (isDup('complete', completeText, e.timestamp)) return {}
      const idx = state.playerQuests.findIndex((q) => q.questId === e.questId)
      let playerQuests: PlayerQuest[]
      if (idx >= 0) {
        const prev = state.playerQuests[idx]
        playerQuests = state.playerQuests.slice()
        playerQuests[idx] = {
          ...prev,
          name: prev.name && prev.name !== prev.questId ? prev.name : e.name,
          completedAt: e.timestamp,
          status: 'completed',
        }
      } else {
        playerQuests = [
          ...state.playerQuests,
          {
            questId: e.questId,
            name: e.name,
            traderId: '',
            traderName: '',
            acceptedAt: null,
            completedAt: e.timestamp,
            status: 'completed',
            wiki: `https://www.eftarkov.com/news/id/${e.questId}.html`,
            minLevel: null,
          },
        ]
      }
      activities.unshift({
        id: uid(),
        ts: e.timestamp,
        kind: 'complete',
        text: completeText,
      })
      return { playerQuests, activities: activities.slice(0, 20) }
    }),

  seedPlayerQuests: (list) => set({ playerQuests: list }),
  // 启动装载实时区：只保留玩家任务活动（排除进度噪声），最多 20 条
  seedActivity: (list) =>
    set({ activities: list.filter((a) => a.kind !== 'progress').slice(0, 20) }),
  // 历史活动：同样排除进度噪声
  setHistoricalActivity: (list) =>
    set({
      historicalActivities: list.filter((a) => a.kind !== 'progress'),
      historicalLoaded: true,
    }),
  clearHistorical: () => set({ historicalActivities: [], historicalLoaded: false }),

  graph: null,
  setGraph: (g) => set({ graph: g }),

  unlockedQuests: [],
  setUnlockedQuests: (list) => set({ unlockedQuests: list }),

  selectedId: null,
  detail: null,
  setSelected: (id, d) => set({ selectedId: id, detail: d }),

  questDetails: {},
  setQuestDetail: (id, d) => set((s) => ({ questDetails: { ...s.questDetails, [id]: d } })),

  wikiUrl: null,
  openWiki: (url) => set({ wikiUrl: url }),
  closeWiki: () => set({ wikiUrl: null }),

  disabledTradersGraph: prefs0.disabledTraders,
  toggleTraderGraph: (id) => {
    set((state) => ({
      disabledTradersGraph: {
        ...state.disabledTradersGraph,
        [id]: !state.disabledTradersGraph[id],
      },
    }))
    persistGraphPrefs()
  },
  setTraderGraph: (id, disabled) => {
    set((state) => ({
      disabledTradersGraph: { ...state.disabledTradersGraph, [id]: disabled },
    }))
    persistGraphPrefs()
  },
  mapSelGraph: '',
  setMapSelGraph: (m) => set({ mapSelGraph: m }),
  searchGraph: '',
  setSearchGraph: (s) => set({ searchGraph: s }),

  hideLegacyGraph: prefs0.hideLegacy,
  setHideLegacyGraph: (v) => set({ hideLegacyGraph: v }),
  repMetGraph: prefs0.repMet,
  setRepMetGraph: (v) => {
    set({ repMetGraph: v })
    persistGraphPrefs()
  },
  lvlMetGraph: prefs0.lvlMet,
  setLvlMetGraph: (v) => {
    set({ lvlMetGraph: v })
    persistGraphPrefs()
  },
  mapUnlockedGraph: prefs0.mapUnlocked,
  setMapUnlockedGraph: (v) => {
    set({ mapUnlockedGraph: v })
    persistGraphPrefs()
  },
  showCompletedGraph: prefs0.showCompleted,
  setShowCompletedGraph: (v) => {
    set({ showCompletedGraph: v })
    persistGraphPrefs()
  },
  questMode: prefs0.questMode,
  setQuestMode: (v) => {
    set({ questMode: v })
    persistGraphPrefs()
  },
  applyDetectedMode: (m) => {
    const mode = m === 'pve' ? 'pve' : 'pvp'
    const cur = useStore.getState().questMode
    if (cur === mode) return
    set({ questMode: mode })
    persistGraphPrefs()
  },
  applyUiPrefs: (p) => {
    const u = p as UiPrefsShape
    const patch: Partial<AppState> = {}
    const g = u.graphPrefs
    if (g && typeof g === 'object') {
      if (typeof g.repMet === 'boolean') patch.repMetGraph = g.repMet
      if (typeof g.lvlMet === 'boolean') patch.lvlMetGraph = g.lvlMet
      if (typeof g.mapUnlocked === 'boolean') patch.mapUnlockedGraph = g.mapUnlocked
      if (typeof g.showCompleted === 'boolean') patch.showCompletedGraph = g.showCompleted
      if (typeof g.hideLegacy === 'boolean') patch.hideLegacyGraph = g.hideLegacy
      if (g.questMode === 'pve' || g.questMode === 'pvp') patch.questMode = g.questMode
      if (g.disabledTraders && typeof g.disabledTraders === 'object') {
        patch.disabledTradersGraph = {
          ...DEFAULT_DISABLED_TRADERS.reduce(
            (acc, id) => ({ ...acc, [id]: true }),
            {} as Record<string, boolean>,
          ),
          ...(g.disabledTraders as Record<string, boolean>),
        }
      }
    }
    if (Object.keys(patch).length > 0) set(patch)
  },
}))

/** 从任务目标里聚合去重所需物品（与任务图谱详情一致） */
export function dedupeItems(items: ItemRef[]): ItemRef[] {
  const m = new Map<string, ItemRef>()
  for (const it of items) {
    const prev = m.get(it.id)
    const c = it.count ?? 1
    if (prev) {
      if (it.count != null) prev.count = (prev.count ?? 0) + c
    } else {
      m.set(it.id, { ...it })
    }
  }
  return [...m.values()]
}

/**
 * 取任务详情并缓存：监控页卡片调用，离线读取本地索引，无需网络。
 * 优先命中缓存，未命中则异步拉取后写入 store 供其他卡片复用。
 */
export function useQuestDetail(id: string | null): QuestDetail | null {
  const map = useStore((s) => s.questDetails)
  const setDetail = useStore((s) => s.setQuestDetail)
  const cached = id ? map[id] ?? null : null
  const [detail, setLocal] = useState<QuestDetail | null>(cached)

  useEffect(() => {
    if (!id) {
      setLocal(null)
      return
    }
    if (map[id]) {
      setLocal(map[id])
      return
    }
    let alive = true
    getQuestDetail(id)
      .then((d) => {
        if (!alive) return
        if (d) {
          setDetail(id, d)
          setLocal(d)
        } else {
          setLocal(null)
        }
      })
      .catch(() => alive && setLocal(null))
    return () => {
      alive = false
    }
  }, [id, map, setDetail])

  return detail
}
