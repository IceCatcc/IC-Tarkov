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
  page: 'monitor' | 'graph' | 'map'
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

  traderFilterGraph: string
  setTraderFilterGraph: (t: string) => void
  searchGraph: string
  setSearchGraph: (s: string) => void
}

function uid(): string {
  return Math.random().toString(36).slice(2, 10)
}

export const useStore = create<AppState>((set) => ({
  page: 'monitor',
  setPage: (p) => set({ page: p }),

  settings: { logDir: '', screenshotDir: '' },
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
      const activities = state.activities.slice()

      if (e.type === 'progress') {
        activities.unshift({
          id: uid(),
          ts: e.timestamp,
          kind: 'progress',
          text: `同步任务列表 · ${e.endpoint}`,
        })
        return { activities: activities.slice(0, 300) }
      }

      if (e.type === 'accept') {
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
          text: `接取 ${e.name} · ${e.traderName}`,
        })
        return { playerQuests, activities: activities.slice(0, 300) }
      }

      // complete
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
        text: `完成 ${e.name}（${e.via}）`,
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

  traderFilterGraph: '',
  setTraderFilterGraph: (t) => set({ traderFilterGraph: t }),
  searchGraph: '',
  setSearchGraph: (s) => set({ searchGraph: s }),
}))
