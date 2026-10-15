/**
 * 桌面端数据包的解析（对应 src-tauri/src/lib.rs 的 import_zip / import_json）。
 *
 * 支持两种输入：
 *   - 导出包 zip：`quest_state.{mode}.json` / `collected.{mode}.json` / `settings.json`
 *   - 单个 JSON：旧的 `quest_state.json`（归入 PVP）或 `collected.json`
 *
 * 结构以 `src-tauri/src/store.rs` 的 serde 定义为准 —— 注意 `ModeData` **没有** rename_all，
 * 因此是 snake_case（`current_map` / `offsets`），而 `QuestEntry` / `ActivityRow` 是 camelCase
 * （`acceptedAt` / `objectivesDone` / `questId`）。这里两种情况都容忍。
 */
import { strFromU8, unzipSync } from 'fflate'
import { nowSql } from '../util/time.js'
import { MODES, normMode, type Mode } from '../types.js'

export interface ParsedFile {
  name: string
  json: unknown
}

export interface ParsedQuestEntry {
  questId: string
  acceptedAt: string | null
  completedAt: string | null
  objectivesDone: string[]
}

export interface ParsedActivity {
  /** 桌面端的确定性去重 id，如 `acc|<任务id>`、`unl|<任务id>|<时间>` */
  id: string
  ts: string
  kind: 'accept' | 'complete' | 'progress'
  questId: string
  questName: string
  text: string
  wiki: string | null
}

export interface ParsedModeData {
  quests: ParsedQuestEntry[]
  activity: ParsedActivity[]
  unlocked: string[]
  collected: string[]
  currentMap: string | null
  /** 解析过程中被丢弃的条目说明（用于回显给用户） */
  warnings: string[]
}

const SQL_TS = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/

/** 把各种时间写法归一成 `YYYY-MM-DD HH:mm:ss`（与桌面端日志时间戳同格式）；无法识别返回 null */
export function normalizeTs(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const s = v.trim()
  if (!s) return null
  const m = SQL_TS.exec(s)
  if (m) return `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}:${m[6]}`
  const d = new Date(s)
  if (Number.isNaN(d.getTime())) return null
  return nowSql(d)
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

function strArray(v: unknown): string[] {
  if (!Array.isArray(v)) return []
  return v.filter((x): x is string => typeof x === 'string' && x.length > 0)
}

/** 兼容 camelCase / snake_case 两种键名 */
function pick(o: Record<string, unknown>, ...keys: string[]): unknown {
  for (const k of keys) if (k in o) return o[k]
  return undefined
}

/* ---------------- 包解压 ---------------- */

const ZIP_MAGIC = [0x50, 0x4b]

/**
 * 抽出「文件名 → 已解析 JSON」列表。
 * zip 只接受平铺的已知文件名（防路径穿越与意外条目，与桌面端 import_zip 一致）。
 */
export function extractFiles(bytes: Uint8Array): ParsedFile[] {
  const isZip = bytes.length >= 2 && bytes[0] === ZIP_MAGIC[0] && bytes[1] === ZIP_MAGIC[1]
  if (!isZip) {
    const json = parseJson(strFromU8(bytes))
    return [{ name: '__single__.json', json }]
  }

  let entries: Record<string, Uint8Array>
  try {
    entries = unzipSync(bytes)
  } catch (e) {
    throw new Error(`无法读取压缩包：${e instanceof Error ? e.message : String(e)}`)
  }

  const out: ParsedFile[] = []
  for (const [rawName, data] of Object.entries(entries)) {
    // 只看文件名本身：带目录的一律跳过，避免 zip 内的相对路径被当成有效条目
    const name = rawName.split(/[\\/]/).pop() ?? ''
    if (!isKnownFile(name)) continue
    out.push({ name, json: parseJson(strFromU8(data)) })
  }
  if (out.length === 0) {
    throw new Error('压缩包里没有可识别的数据文件（应为 quest_state.*.json / collected.*.json / settings.json）')
  }
  return out
}

/** 单个 JSON 文件（非 zip）的入口：按内容与文件名猜测归属 */
export function extractSingleFile(name: string, text: string): ParsedFile[] {
  return [{ name: name || '__single__.json', json: parseJson(text) }]
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch (e) {
    throw new Error(`文件不是有效的 JSON：${e instanceof Error ? e.message : String(e)}`)
  }
}

export function isKnownFile(name: string): boolean {
  if (name === 'settings.json') return true
  if (name === 'quest_state.json' || name === 'collected.json') return true
  if (/^quest_state\.(pvp|pvps|pve)\.json$/i.test(name)) return true
  if (/^collected\.(pvp|pvps|pve)\.json$/i.test(name)) return true
  return false
}

/** 文件名 → 目标模式；无法识别返回 null */
export function fileMode(name: string): Mode | null {
  if (name === 'quest_state.json' || name === 'collected.json') return 'pvp'
  const m = /^(?:quest_state|collected)\.([a-z]+)\.json$/i.exec(name)
  if (!m) return null
  const mode = m[1].toLowerCase()
  return (MODES as readonly string[]).includes(mode) ? normMode(mode) : null
}

/* ---------------- 各文件解析 ---------------- */

export function parseModeData(raw: unknown): ParsedModeData {
  const warnings: string[] = []
  if (!isRecord(raw)) throw new Error('任务进度文件格式不正确（应为对象）')

  const quests: ParsedQuestEntry[] = []
  const rawQuests = pick(raw, 'quests')
  if (isRecord(rawQuests)) {
    for (const [questId, entryRaw] of Object.entries(rawQuests)) {
      if (!questId) continue
      const e = isRecord(entryRaw) ? entryRaw : {}
      const acceptedAt = normalizeTs(pick(e, 'acceptedAt', 'accepted_at'))
      const completedAt = normalizeTs(pick(e, 'completedAt', 'completed_at'))
      const objectivesDone = strArray(pick(e, 'objectivesDone', 'objectives_done'))
      // 只有目标打勾、既未接取也未完成的条目不需要进 quest_entries（与前端列表口径一致）
      if (!acceptedAt && !completedAt && objectivesDone.length === 0) continue
      quests.push({ questId, acceptedAt, completedAt, objectivesDone })
    }
  } else if (rawQuests !== undefined) {
    warnings.push('quests 字段不是对象，已忽略')
  }

  const activity: ParsedActivity[] = []
  const rawActivity = pick(raw, 'activity')
  if (Array.isArray(rawActivity)) {
    for (const item of rawActivity) {
      if (!isRecord(item)) continue
      const id = typeof item.id === 'string' ? item.id : ''
      const ts = normalizeTs(item.ts)
      const kindRaw = String(item.kind ?? '')
      const kind = kindRaw === 'accept' || kindRaw === 'complete' || kindRaw === 'progress' ? kindRaw : null
      if (!id || !ts || !kind) continue
      activity.push({
        id,
        ts,
        kind,
        questId: typeof item.questId === 'string' ? item.questId : '',
        questName: typeof item.questName === 'string' ? item.questName : '',
        text: typeof item.text === 'string' ? item.text : '',
        wiki: typeof item.wiki === 'string' ? item.wiki : null,
      })
    }
  }

  const currentMapRaw = pick(raw, 'currentMap', 'current_map')

  return {
    quests,
    activity,
    unlocked: [...new Set(strArray(pick(raw, 'unlocked')))],
    collected: [...new Set(strArray(pick(raw, 'collected')))],
    currentMap: typeof currentMapRaw === 'string' && currentMapRaw ? currentMapRaw : null,
    warnings,
  }
}

export function parseCollected(raw: unknown): string[] {
  if (!Array.isArray(raw)) throw new Error('收藏进度文件格式不正确（应为字符串数组）')
  return [...new Set(strArray(raw))]
}

/** settings.json：web 端只关心 uiPrefs（日志/截图目录等属桌面本机能力） */
export function parseSettings(raw: unknown): Record<string, unknown> | null {
  if (!isRecord(raw)) return null
  const prefs = pick(raw, 'uiPrefs', 'ui_prefs')
  return isRecord(prefs) ? prefs : null
}
