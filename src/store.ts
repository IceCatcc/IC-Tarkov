import { create } from 'zustand'
import type {
  ActivityItem,
  PlayerQuest,
  QuestGraph,
  QuestDetail,
  WatcherState,
  WatcherStatePayload,
  AppSettings,
  QuestEventPayload,
} from './types'

interface AppState {
  page: 'monitor' | 'graph' | 'map' | 'profile'
  setPage: (p: AppState['page']) => void

  settings: AppSettings
  setSettings: (s: AppSettings) => void
  showSettings: boolean
  openSettings: () => void
  closeSettings: () => void

  watcher: WatcherState
  setWatcher: (w: WatcherState) => void

  playerQuests: PlayerQuest[]
  activities: ActivityItem[]
  applyEvent: (e: QuestEventPayload) => void
  seedPlayerQuests: (list: PlayerQuest[]) => void
  seedActivity: (list: ActivityItem[]) => void

  filter: 'all' | 'in_progress' | 'completed'
  setFilter: (f: 'all' | 'in_progress' | 'completed') => void
  traderFilter: string | null
  setTraderFilter: (t: string | null) => void

  graph: QuestGraph | null
  setGraph: (g: QuestGraph) => void

  selectedId: string | null
  detail: QuestDetail | null
  setSelected: (id: string | null, d: QuestDetail | null) => void

  /** Wiki 内嵌抽屉 */
  wikiUrl: string | null
  openWiki: (url: string) => void
  closeWiki: () => void

  /** 任务图谱中关闭显示的商人（traderId -> true 为隐藏） */
  disabledTradersGraph: Record<string, boolean>
  toggleTraderGraph: (id: string) => void

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
  focusGraph: boolean
  setFocusGraph: (v: boolean) => void
}

function uid(): string {
  return Math.random().toString(36).slice(2, 10)
}

export const useStore = create<AppState>((set) => ({
  page: 'monitor',
  setPage: (p) => set({ page: p }),

  settings: { logDir: '', screenshotDir: '', profile: { level: 1, loyalty: {} } },
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
        const text = `同步任务列表 · ${e.endpoint}`
        if (isDup('progress', text, e.timestamp)) return {}
        activities.unshift({
          id: uid(),
          ts: e.timestamp,
          kind: 'progress',
          text,
        })
        return { activities: activities.slice(0, 300) }
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
        return { playerQuests, activities: activities.slice(0, 300) }
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
      return { playerQuests, activities: activities.slice(0, 300) }
    }),

  seedPlayerQuests: (list) => set({ playerQuests: list }),
  seedActivity: (list) => set({ activities: list }),

  graph: null,
  setGraph: (g) => set({ graph: g }),

  selectedId: null,
  detail: null,
  setSelected: (id, d) => set({ selectedId: id, detail: d }),

  wikiUrl: null,
  openWiki: (url) => set({ wikiUrl: url }),
  closeWiki: () => set({ wikiUrl: null }),

  disabledTradersGraph: {},
  toggleTraderGraph: (id) =>
    set((state) => ({
      disabledTradersGraph: {
        ...state.disabledTradersGraph,
        [id]: !state.disabledTradersGraph[id],
      },
    })),
  mapSelGraph: '',
  setMapSelGraph: (m) => set({ mapSelGraph: m }),
  searchGraph: '',
  setSearchGraph: (s) => set({ searchGraph: s }),

  hideLegacyGraph: false,
  setHideLegacyGraph: (v) => set({ hideLegacyGraph: v }),
  repMetGraph: true,
  setRepMetGraph: (v) => set({ repMetGraph: v }),
  lvlMetGraph: false,
  setLvlMetGraph: (v) => set({ lvlMetGraph: v }),
  focusGraph: false,
  setFocusGraph: (v) => set({ focusGraph: v }),
}))
