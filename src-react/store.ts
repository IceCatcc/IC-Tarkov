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
  Toast,
  ToastKind,
  QuestMode,
} from './types'
import {
  getQuestDetail,
  getPlayerQuests,
  getUnlocked,
  getCollectedItems,
  getSettings,
  setViewMode,
  setQuestStatus,
} from './tauri'
import { buildWikiUrl, type WikiSite } from './wiki'
import { ICON_DEFAULTS, migrateChips } from './mapIconGroups'

interface AppState {
  page: 'monitor' | 'graph' | 'map' | 'profile' | 'collector'
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

  /** 全局通知队列（顶部居中堆叠，最新在下） */
  toasts: Toast[]
  pushToast: (text: string, kind?: ToastKind) => void
  dismissToast: (id: string) => void
  /** 地图 id -> 中文名（用于通知显示当前地图名） */
  mapNames: Record<string, string>
  setMapNames: (m: Record<string, string>) => void

  /** 地图：截图定位后是否每次都缩放聚焦（关闭则只平移、保持用户缩放） */
  autoZoomMap: boolean
  setAutoZoomMap: (v: boolean) => void
  /** 地图：截图定位后是否自动将玩家平移到视图中心（关闭则完全不跟随，用户自由看地图） */
  autoCenter: boolean
  setAutoCenter: (v: boolean) => void
  /** 地图：自动聚焦（居中+缩放）时的目标缩放级别，由工具栏进度条调节 */
  focusZoom: number
  setFocusZoom: (v: number) => void

  /** 地图图标显隐（含任务目标），随 mapPrefs 一起持久化。键见 mapIconGroups.ts */
  mapChips: Record<string, boolean>
  setMapChip: (key: string, on: boolean) => void
  /** 批量设置（分类「全部显示 / 全部隐藏」一次写入多个子项） */
  setMapChips: (patch: Record<string, boolean>) => void
  /** 地图：不跟踪的任务 id（不跟踪=不在地图绘制其目标图标）；缺省视为全部跟踪 */
  untrackedQuests: string[]
  toggleQuestTracked: (id: string) => void
  /** 监控页：任务列表的地图过滤（normalizedName，空=全部） */
  mapFilter: string
  setMapFilter: (m: string) => void

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

  /** 收藏家：已收集的物品 id（后端 collected.json 持久化） */
  collectedItems: string[]
  setCollectedItems: (list: string[]) => void

  /** 手动修改任务状态：complete=完成、reset=重置为未接取（另支持 accept / unlock）。
   *  成功后用返回结果同步任务列表与解锁集合，任务链/任务板/监控页状态随之刷新 */
  manualSetStatus: (
    questId: string,
    action: 'accept' | 'complete' | 'unlock' | 'reset',
  ) => Promise<void>

  selectedId: string | null
  detail: QuestDetail | null
  setSelected: (id: string | null, d: QuestDetail | null) => void

  /** 任务详情缓存（按 questId）：监控页任务卡片复用，避免重复请求 */
  questDetails: Record<string, QuestDetail>
  setQuestDetail: (id: string, d: QuestDetail) => void

  /** Wiki 内嵌抽屉宽度（右侧占比 %，桌面可拖动调整，范围 30~92） */
  wikiWidth: number
  setWikiWidth: (v: number) => void
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

  /** 任务板（列表视图）的地图筛选：'' = 全部地图；与图谱视图的地图筛选相互独立 */
  boardMapFilter: string
  setBoardMapFilter: (m: string) => void

  /** 监控页任务列表的关键字过滤（在所选分类内过滤任务名 / 商人名） */
  searchMonitor: string
  setSearchMonitor: (s: string) => void

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
  /** 转生任务（Prestige）的显示开关：勾选显示、不勾选排除 */
  showPrestigeGraph: boolean
  setShowPrestigeGraph: (v: boolean) => void
  /** 任务页当前视图：'list' 任务列表 / 'chain' 任务链图谱 */
  graphTab: 'list' | 'chain'
  /** 任务链详情面板位置（画布容器坐标）；null = 默认右上角。
   *  只在本次运行内记住（切换页面/重选任务都不丢），不写入磁盘 */
  detailPanelPos: { x: number; y: number } | null
  setDetailPanelPos: (p: { x: number; y: number } | null) => void
  setGraphTab: (v: 'list' | 'chain') => void
  /** 任务模式：pvp / pvps / pve（三套数据独立；持久化，日志检测到会话模式时自动跟随） */
  questMode: QuestMode
  setQuestMode: (v: QuestMode) => void
  /** 界面缩放（类显示器缩放）：1 / 1.25 / 1.5 / 2，作用于根节点 CSS zoom */
  uiScale: number
  setUiScale: (v: number) => void
  /** Wiki 站点：eftarkov（默认）/ tarkovbox / custom（持久化于 uiPrefs） */
  wikiSite: WikiSite
  setWikiSite: (v: WikiSite) => void
  /** 自定义 Wiki 模板（含 {taskid} 占位），仅 wikiSite = custom 时生效 */
  wikiCustom: string
  setWikiCustom: (v: string) => void
  /** 按当前站点设置生成任务 Wiki 链接（无可用模板时为 null）。
   *  注意与上面的 wikiUrl（抽屉当前打开的 URL）区分。 */
  wikiUrlFor: (questId: string) => string | null
  /** 日志检测到会话模式时调用：自动切换 questMode 并持久化；返回是否发生了切换 */
  applyDetectedMode: (m: string) => boolean
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

/** 规范化任务模式名（旧数据只有 pvp/pve） */
export function normQuestMode(m: unknown): QuestMode {
  return m === 'pvps' ? 'pvps' : m === 'pve' ? 'pve' : 'pvp'
}

/**
 * 切换到某个任务模式：通知后端把「查看模式」切过去，再把该模式的任务进度、
 * 解锁集合、收藏家进度、档案重新拉一遍（三套数据在后端各自独立）。
 */
async function switchBackendMode(m: QuestMode): Promise<void> {
  try {
    await setViewMode(m)
    const [quests, unlocked, collected, settings] = await Promise.all([
      getPlayerQuests(),
      getUnlocked(),
      getCollectedItems(),
      getSettings(),
    ])
    useStore.setState({
      playerQuests: quests,
      unlockedQuests: unlocked,
      collectedItems: collected,
      settings,
      // 详情缓存、实时活动流、已加载的历史活动都属于原模式，切换后清掉避免串数据
      selectedId: null,
      detail: null,
      activities: [],
      historicalActivities: [],
      historicalLoaded: false,
    })
  } catch {
    /* 后端不可用时保持现有数据，不阻塞切换 */
  }
}

// —— 任务图谱筛选偏好持久化（localStorage）——
// 好感达标 / 等级达标 / 地图解锁 / 显示已完成 / 商人隐藏 的勾选状态跨启动保留。
// v2：新增「显示已完成」开关（旧版无入口、恒为显示，故升级时按新默认「关闭」重置一次）
const GRAPH_PREFS_KEY = 'ic-tarkov.graphPrefs.v2'
const GRAPH_PREFS_KEY_V1 = 'ic-tarkov.graphPrefs.v1'
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
  hideLegacy: boolean
  showPrestige: boolean
  disabledTraders: Record<string, boolean>
  questMode: QuestMode
}

function loadGraphPrefs(): GraphPrefs {
  const fallback: GraphPrefs = {
    repMet: true,
    lvlMet: false,
    mapUnlocked: false,
    hideLegacy: false,
    showPrestige: true, // 默认显示转生任务（「转生任务」不勾选才隐藏）
    disabledTraders: Object.fromEntries(DEFAULT_DISABLED_TRADERS.map((id) => [id, true])),
    questMode: 'pvp',
  }
  try {
    // 优先读 v2；没有时回退 v1（沿用已保存的偏好）
    const raw = localStorage.getItem(GRAPH_PREFS_KEY) ?? localStorage.getItem(GRAPH_PREFS_KEY_V1)
    if (!raw) return fallback
    const p = JSON.parse(raw) as Partial<GraphPrefs>
    return {
      // 这几项不再提供设置入口，固定为下列值（忽略历史偏好）
      repMet: false,
      lvlMet: false,
      mapUnlocked: false,
      hideLegacy: false,
      showPrestige: true,
      disabledTraders: { ...fallback.disabledTraders, ...(p.disabledTraders ?? {}) },
      questMode: normQuestMode(p.questMode),
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
    hideLegacy: s.hideLegacyGraph,
    showPrestige: s.showPrestigeGraph,
    disabledTraders: s.disabledTradersGraph,
    questMode: s.questMode,
  }
  try {
    localStorage.setItem(GRAPH_PREFS_KEY, JSON.stringify(data))
  } catch {
    /* 忽略写入失败（隐私模式等） */
  }
}

// 地图图标显隐的默认值与迁移规则见 mapIconGroups.ts（ICON_DEFAULTS / migrateChips），
// 这里不再单独维护一份，避免两处漂移。

/** 供后端持久化：收集当前全部 UI 偏好（与 settings.json 的 uiPrefs 字段对应） */
export function collectUiPrefs(): Record<string, unknown> {
  const s = useStore.getState()
  return {
    graphPrefs: {
      repMet: s.repMetGraph,
      lvlMet: s.lvlMetGraph,
      mapUnlocked: s.mapUnlockedGraph,
      hideLegacy: s.hideLegacyGraph,
      showPrestige: s.showPrestigeGraph,
      disabledTraders: s.disabledTradersGraph,
      questMode: s.questMode,
    } satisfies GraphPrefs,
    mapPrefs: {
      autoZoom: s.autoZoomMap,
      autoCenter: s.autoCenter,
      focusZoom: s.focusZoom,
      untrackedQuests: s.untrackedQuests,
      chips: s.mapChips,
    },
    uiScale: s.uiScale,
    wikiWidth: s.wikiWidth,
    wikiSite: s.wikiSite,
    wikiCustom: s.wikiCustom,
  }
}

interface UiPrefsShape {
  graphPrefs?: Partial<GraphPrefs>
  mapPrefs?: {
    autoZoom?: boolean
    autoCenter?: boolean
    focusZoom?: number
    untrackedQuests?: string[]
    chips?: Record<string, boolean>
  }
  /** 界面缩放（类显示器缩放）：1 / 1.25 / 1.5 / 2 */
  uiScale?: number
  /** Wiki 抽屉宽度（右侧占比 %） */
  wikiWidth?: number
  /** Wiki 站点：eftarkov / tarkovbox / custom */
  wikiSite?: WikiSite
  /** 自定义 Wiki 模板（含 {taskid} 占位） */
  wikiCustom?: string
}

const prefs0 = loadGraphPrefs()

export const useStore = create<AppState>((set, get) => ({
  page: 'monitor',
  setPage: (p) => set({ page: p }),

  currentMapId: null,
  setCurrentMapId: (id) => set({ currentMapId: id }),
  currentMap: null,
  setCurrentMap: (m) => set({ currentMap: m }),

  settings: {
    logDir: '',
    screenshotDir: '',
    profile: { level: 1, loyalty: {}, lockedMaps: [] },
    deleteScreenshots: true,
    keepScreenOn: true,
  },
  setSettings: (s) => set({ settings: s }),
  showSettings: false,
  openSettings: () => set({ showSettings: true }),
  closeSettings: () => set({ showSettings: false }),

  toasts: [],
  // 最多堆叠 5 条，超出丢弃最旧的；同文本 5s 内只弹一次（监听重复/事件重复 emit 兜底）
  pushToast: (text, kind = 'info') =>
    set((state) => {
      const now = Date.now()
      if (state.toasts.some((t) => t.text === text && now - t.bornAt < 5000)) return {}
      return {
        toasts: [...state.toasts, { id: uid(), text, kind: kind as ToastKind, bornAt: now }].slice(
          -5,
        ),
      }
    }),
  dismissToast: (id) => set((state) => ({ toasts: state.toasts.filter((t) => t.id !== id) })),
  mapNames: {},
  setMapNames: (m) => set({ mapNames: m }),

  autoZoomMap: false,
  setAutoZoomMap: (v) => set({ autoZoomMap: v }),
  autoCenter: true,
  setAutoCenter: (v) => set({ autoCenter: v }),
  focusZoom: 4,
  setFocusZoom: (v) => set({ focusZoom: v }),
  mapChips: { ...ICON_DEFAULTS },
  setMapChip: (key, on) => set((s) => ({ mapChips: { ...s.mapChips, [key]: on } })),
  setMapChips: (patch) => set((s) => ({ mapChips: { ...s.mapChips, ...patch } })),
  untrackedQuests: [],
  toggleQuestTracked: (id) =>
    set((s) => ({
      untrackedQuests: s.untrackedQuests.includes(id)
        ? s.untrackedQuests.filter((x) => x !== id)
        : [...s.untrackedQuests, id],
    })),
  mapFilter: '',
  setMapFilter: (m) => set({ mapFilter: m }),

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

  // 默认显示「进行中」
  filter: 'in_progress',
  setFilter: (f) => set({ filter: f }),
  traderFilter: null,
  setTraderFilter: (t) => set({ traderFilter: t }),

  applyEvent: (e) =>
    set((state) => {
      // 事件带上「日志检测到的会话模式」；与当前查看模式不一致时忽略，避免串模式
      if (e.mode && e.mode !== state.questMode) return {}
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
            // 事件里的 wiki 是后端默认站点地址，这里按当前站点设置重算
            wiki: buildWikiUrl(e.questId, state.wikiSite, state.wikiCustom) ?? '',
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
              // 同上：按当前站点设置生成
              wiki: buildWikiUrl(e.questId, state.wikiSite, state.wikiCustom) ?? '',
              minLevel: null,
              maps: [],
            },
          ]
        }
        activities.unshift({
          id: uid(),
          ts: e.timestamp,
          kind: 'accept',
          text: acceptText,
          questId: e.questId,
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
            wiki: buildWikiUrl(e.questId, state.wikiSite, state.wikiCustom) ?? '',
            minLevel: null,
            maps: [],
          },
        ]
      }
      activities.unshift({
        id: uid(),
        ts: e.timestamp,
        kind: 'complete',
        text: completeText,
        questId: e.questId,
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

  collectedItems: [],
  setCollectedItems: (list) => set({ collectedItems: list }),

  manualSetStatus: async (questId, action) => {
    try {
      const res = await setQuestStatus(questId, action)
      set({ playerQuests: res.quests, unlockedQuests: res.unlocked })
    } catch (e) {
      console.error('手动修改任务状态失败', e)
      set((s) => ({
        toasts: [
          ...s.toasts,
          { id: `${Date.now()}-${Math.random()}`, text: `修改任务状态失败：${String(e)}`, kind: 'info' as ToastKind, bornAt: Date.now() },
        ].slice(-5),
      }))
    }
  },

  selectedId: null,
  detail: null,
  setSelected: (id, d) => set({ selectedId: id, detail: d }),

  questDetails: {},
  setQuestDetail: (id, d) => set((s) => ({ questDetails: { ...s.questDetails, [id]: d } })),

  wikiWidth: 62,
  setWikiWidth: (v) => set({ wikiWidth: Math.round(Math.min(92, Math.max(30, v))) }),
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

  boardMapFilter: '',
  setBoardMapFilter: (m) => set({ boardMapFilter: m }),

  searchMonitor: '',
  setSearchMonitor: (s) => set({ searchMonitor: s }),

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
  showPrestigeGraph: prefs0.showPrestige,
  setShowPrestigeGraph: (v) => {
    set({ showPrestigeGraph: v })
    persistGraphPrefs()
  },
  graphTab: 'chain',
  setGraphTab: (v) => set({ graphTab: v }),
  detailPanelPos: null,
  setDetailPanelPos: (p) => set({ detailPanelPos: p }),
  questMode: prefs0.questMode,
  setQuestMode: (v) => {
    if (useStore.getState().questMode === v) return
    set({ questMode: v })
    persistGraphPrefs()
    void switchBackendMode(v)
  },
  uiScale: 1,
  setUiScale: (v) => set({ uiScale: v }),
  wikiSite: 'eftarkov',
  setWikiSite: (v) => set({ wikiSite: v }),
  wikiCustom: '',
  setWikiCustom: (v) => set({ wikiCustom: v }),
  wikiUrlFor: (questId) => buildWikiUrl(questId, get().wikiSite, get().wikiCustom),
  applyDetectedMode: (m) => {
    const mode = normQuestMode(m)
    const cur = useStore.getState().questMode
    if (cur === mode) return false
    set({ questMode: mode })
    persistGraphPrefs()
    void switchBackendMode(mode)
    return true
  },
  applyUiPrefs: (p) => {
    const u = p as UiPrefsShape
    const patch: Partial<AppState> = {}
    const g = u.graphPrefs
    if (g && typeof g === 'object') {
      if (typeof g.repMet === 'boolean') patch.repMetGraph = g.repMet
      if (typeof g.lvlMet === 'boolean') patch.lvlMetGraph = g.lvlMet
      if (typeof g.mapUnlocked === 'boolean') patch.mapUnlockedGraph = g.mapUnlocked
      if (typeof g.hideLegacy === 'boolean') patch.hideLegacyGraph = g.hideLegacy
      if (typeof g.showPrestige === 'boolean') patch.showPrestigeGraph = g.showPrestige
      if (g.questMode === 'pve' || g.questMode === 'pvp' || g.questMode === 'pvps') {
        patch.questMode = normQuestMode(g.questMode)
      }
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
    const mp = u.mapPrefs
    if (mp && typeof mp === 'object') {
      if (typeof mp.autoZoom === 'boolean') patch.autoZoomMap = mp.autoZoom
      if (typeof mp.autoCenter === 'boolean') patch.autoCenter = mp.autoCenter
      if (typeof mp.focusZoom === 'number') patch.focusZoom = mp.focusZoom
      if (Array.isArray(mp.untrackedQuests))
        patch.untrackedQuests = mp.untrackedQuests.filter((x) => typeof x === 'string')
      if (mp.chips && typeof mp.chips === 'object') {
        // 旧版扁平键先迁移到「分类 / 子分类」键；子分类键是数据驱动的（容器类型等），
        // 无法穷举白名单，因此按前缀校验而不是比对已知键。
        const next: Record<string, boolean> = { ...ICON_DEFAULTS }
        for (const [k, v] of Object.entries(
          migrateChips(mp.chips as Record<string, boolean>),
        )) {
          if (typeof v === 'boolean' && (k.startsWith('cat:') || k.startsWith('sub:'))) {
            next[k] = v
          }
        }
        patch.mapChips = next
      }
    }
    if (typeof u.uiScale === 'number') {
      patch.uiScale = [1, 1.25, 1.5, 2].includes(u.uiScale) ? u.uiScale : 1
    }
    if (typeof u.wikiWidth === 'number') {
      patch.wikiWidth = Math.round(Math.min(92, Math.max(30, u.wikiWidth)))
    }
    if (u.wikiSite === 'eftarkov' || u.wikiSite === 'tarkovbox' || u.wikiSite === 'custom') {
      patch.wikiSite = u.wikiSite
    }
    if (typeof u.wikiCustom === 'string') patch.wikiCustom = u.wikiCustom
    if (Object.keys(patch).length > 0) set(patch)
    // 启动时恢复的模式偏好需要同步给后端（后端默认 pvp），否则会读到另一套数据
    if (patch.questMode) void switchBackendMode(patch.questMode)
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
