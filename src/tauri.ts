import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { invoke } from '@tauri-apps/api/core'
import { useStore } from './store'
import type {
  QuestEventPayload,
  WatcherStatePayload,
  PlayerQuest,
  ActivityItem,
  QuestGraph,
  QuestDetail,
  AppSettings,
  PlayerProfile,
  PlayerPositionPayload,
} from './types'

export async function initTauri(): Promise<UnlistenFn> {
  const { applyEvent, setWatcher } = useStore.getState()

  const offQuest = await listen<QuestEventPayload>('quest-event', (e) => {
    applyEvent(e.payload)
  })
  const offState = await listen<WatcherStatePayload>('watcher-state', (e) => {
    setWatcher(e.payload)
  })

  // 全局监听当前地图变化：任何页面（含非地图页）收到 map-changed 都写入 store，
  // 保证在别的页面进入某张地图时全局当前地图被更新，切回地图页即默认切换到对应地图。
  const { setCurrentMapId } = useStore.getState()
  const offMap = await listen<{ locationId: string; timestamp?: string }>(
    'map-changed',
    (e) => {
      setCurrentMapId(e.payload.locationId)
    },
  )
  // 启动时拉取后端已记录的当前地图（历史值），避免等到下一次地图变化事件
  getCurrentMap()
    .then((id) => {
      if (id) setCurrentMapId(id)
    })
    .catch(() => {})

  return () => {
    offQuest()
    offState()
    offMap()
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

export async function getPlayerQuests(): Promise<PlayerQuest[]> {
  return await invoke<PlayerQuest[]>('get_player_quests')
}

export async function getActivity(): Promise<ActivityItem[]> {
  return await invoke<ActivityItem[]>('get_activity')
}

export async function getQuestGraph(): Promise<QuestGraph> {
  return await invoke<QuestGraph>('get_quest_graph')
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
  profile?: PlayerProfile,
): Promise<AppSettings> {
  return await invoke<AppSettings>('save_settings', { logDir, screenshotDir, profile })
}

export async function openUrl(url: string): Promise<void> {
  await invoke('open_url', { url })
}

export async function getPlayerPosition(): Promise<PlayerPositionPayload | null> {
  return await invoke<PlayerPositionPayload | null>('get_player_position')
}

export async function getCurrentMap(): Promise<string | null> {
  return await invoke<string | null>('get_current_map')
}
