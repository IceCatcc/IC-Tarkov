/** 任务模式：与桌面端 store::MODES 保持一致 */
export const MODES = ['pvp', 'pvps', 'pve'] as const
export type Mode = (typeof MODES)[number]

/** 规范化模式名（未知值一律回退到 pvp，与桌面端 store::norm_mode 一致） */
export function normMode(m: unknown): Mode {
  const s = String(m ?? '').trim().toLowerCase()
  return s === 'pvps' ? 'pvps' : s === 'pve' ? 'pve' : 'pvp'
}

export type QuestStatus = 'in_progress' | 'completed' | 'failed'

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
  maps: string[]
}

export interface ActivityRow {
  id: string
  ts: string
  kind: 'accept' | 'complete' | 'progress'
  questId: string
  questName: string
  text: string
  wiki: string | null
}

/** quest_entries 表行 */
export interface QuestEntryRow {
  quest_id: string
  accepted_at: string | null
  completed_at: string | null
}
