/**
 * 导入桌面端已有数据（对应 lib.rs 的 import_zip / import_json，落点从 JSON 文件改为 MySQL）。
 *
 * 两种模式：
 *   - replace（默认，覆盖）：先清空该用户对应模式的进度，再写入导入值 —— 迁移场景用这个，
 *     保证 Web 端与桌面端完全一致
 *   - merge（补充）：只补不删，用 INSERT IGNORE / COALESCE 写入，保留 Web 端已有的更新
 *
 * 按模式分批事务：某个模式的数据有问题时，其它模式不受影响。
 */
import type { PoolConnection } from 'mysql2/promise'
import type { RowDataPacket } from 'mysql2'
import { tx } from '../db.js'
import { MODES, type Mode } from '../types.js'
import type { ParsedFile, ParsedModeData } from '../import/parse.js'
import { fileMode, parseCollected, parseModeData, parseSettings } from '../import/parse.js'
import { saveUiPrefs } from './userData.js'

/** 活动流上限，与 repo/userData.ts 的 ACTIVITY_CAP 保持一致 */
const ACTIVITY_CAP = 800

export interface ModeImportStat {
  mode: Mode
  quests: number
  completed: number
  collected: number
  unlocked: number
  objectives: number
  activities: number
}

export interface ImportOutcome {
  replace: boolean
  modes: ModeImportStat[]
  settingsImported: boolean
  filesUsed: string[]
  warnings: string[]
}

interface Grouped {
  modeData: Map<Mode, ParsedModeData>
  collected: Map<Mode, string[]>
  settings: Record<string, unknown> | null
  filesUsed: string[]
  warnings: string[]
}

/** 把上传的文件按「目标模式 / 设置」归类 */
function groupFiles(files: ParsedFile[]): Grouped {
  const out: Grouped = {
    modeData: new Map(),
    collected: new Map(),
    settings: null,
    filesUsed: [],
    warnings: [],
  }

  for (const f of files) {
    const name = f.name
    try {
      // 无文件名的裸 JSON：按内容猜归属
      if (name === '__single__.json') {
        applySingle(out, f.json)
        out.filesUsed.push('（单个 JSON）')
        continue
      }
      if (name === 'settings.json') {
        const prefs = parseSettings(f.json)
        if (prefs) out.settings = prefs
        else out.warnings.push('settings.json 里没有可用的 uiPrefs，已跳过')
        out.filesUsed.push(name)
        continue
      }
      const mode = fileMode(name)
      if (!mode) {
        out.warnings.push(`无法识别文件归属：${name}`)
        continue
      }
      if (name.startsWith('collected')) {
        mergeCollected(out, mode, parseCollected(f.json))
      } else {
        mergeMode(out, mode, parseModeData(f.json))
      }
      out.filesUsed.push(name)
    } catch (e) {
      out.warnings.push(`${name} 解析失败：${e instanceof Error ? e.message : String(e)}`)
    }
  }
  return out
}

function mergeMode(out: Grouped, mode: Mode, data: ParsedModeData): void {
  const prev = out.modeData.get(mode)
  out.warnings.push(...data.warnings.map((w) => `${mode}: ${w}`))
  if (!prev) {
    out.modeData.set(mode, data)
    return
  }
  // 同一模式出现多份（如 quest_state.json 与 quest_state.pvp.json）：以先出现的为准，其余补空
  prev.quests.push(...data.quests.filter((q) => !prev.quests.some((p) => p.questId === q.questId)))
  prev.activity.push(...data.activity)
  prev.unlocked = [...new Set([...prev.unlocked, ...data.unlocked])]
  prev.collected = [...new Set([...prev.collected, ...data.collected])]
}

function mergeCollected(out: Grouped, mode: Mode, items: string[]): void {
  const prev = out.collected.get(mode)
  out.collected.set(mode, prev ? [...new Set([...prev, ...items])] : items)
}

/** 裸 JSON 按内容判断是任务进度 / 收藏列表 / 设置 */
function applySingle(out: Grouped, json: unknown): void {
  if (Array.isArray(json)) {
    mergeCollected(out, 'pvp', parseCollected(json))
    return
  }
  if (json && typeof json === 'object') {
    const o = json as Record<string, unknown>
    if ('quests' in o || 'activity' in o || 'unlocked' in o) {
      mergeMode(out, 'pvp', parseModeData(o))
      return
    }
    const prefs = parseSettings(o)
    if (prefs) {
      out.settings = prefs
      return
    }
  }
  out.warnings.push('无法识别该 JSON 的内容（既不是任务进度，也不是收藏或设置）')
}

/* ---------------- 批量写入 ---------------- */

async function bulkInsert(
  conn: PoolConnection,
  sqlPrefix: string,
  columns: number,
  rows: unknown[][],
  chunk = 400,
): Promise<void> {
  for (let i = 0; i < rows.length; i += chunk) {
    const slice = rows.slice(i, i + chunk)
    const placeholders = slice.map(() => `(${new Array(columns).fill('?').join(',')})`).join(',')
    await conn.query(`${sqlPrefix} VALUES ${placeholders}`, slice.flat())
  }
}

/** 导入结果按模式汇总，供前端回显 */
function statsOf(mode: Mode, data: ParsedModeData, collected: string[]): ModeImportStat {
  return {
    mode,
    quests: data.quests.length,
    completed: data.quests.filter((q) => q.completedAt).length,
    collected: collected.length,
    unlocked: data.unlocked.length,
    objectives: data.quests.reduce((n, q) => n + q.objectivesDone.length, 0),
    activities: data.activity.length,
  }
}

/* ---------------- 主入口 ---------------- */

export async function importForUser(
  userId: number,
  files: ParsedFile[],
  opts: { replace: boolean },
): Promise<ImportOutcome> {
  if (files.length === 0) throw new Error('没有可导入的文件')
  const g = groupFiles(files)

  const modes: ModeImportStat[] = []
  for (const mode of MODES) {
    const data = g.modeData.get(mode)
    // collected 可能单独成文件（collected.{mode}.json），也可能内嵌在 quest_state 里
    const collected = g.collected.get(mode) ?? data?.collected ?? []
    if (!data && collected.length === 0) continue

    const merged: ParsedModeData =
      data ?? { quests: [], activity: [], unlocked: [], collected: [], currentMap: null, warnings: [] }
    if (data && g.collected.has(mode)) merged.collected = collected

    await applyMode(userId, mode, merged, collected, opts.replace)
    modes.push(statsOf(mode, merged, collected))
  }

  let settingsImported = false
  if (g.settings) {
    await saveUiPrefs(userId, g.settings)
    settingsImported = true
  }

  if (modes.length === 0 && !settingsImported) {
    throw new Error(g.warnings[0] ?? '数据包里没有可导入的内容')
  }

  return {
    replace: opts.replace,
    modes,
    settingsImported,
    filesUsed: g.filesUsed,
    warnings: g.warnings,
  }
}

async function applyMode(
  userId: number,
  mode: Mode,
  data: ParsedModeData,
  collected: string[],
  replace: boolean,
): Promise<void> {
  await tx(async (conn) => {
    if (replace) {
      for (const table of [
        'quest_entries',
        'quest_objectives_done',
        'unlocked_quests',
        'collected_items',
        'activities',
      ]) {
        await conn.execute(`DELETE FROM ${table} WHERE user_id = ? AND \`mode\` = ?`, [userId, mode])
      }
      await conn.execute('DELETE FROM user_mode_state WHERE user_id = ? AND `mode` = ?', [userId, mode])
    }

    // 任务进度：INSERT IGNORE 在 merge 下保留 Web 端已有值；replace 下已是空表，等价于直接写入
    const entryRows = data.quests
      .filter((q) => q.acceptedAt || q.completedAt)
      .map((q) => [userId, mode, q.questId, q.acceptedAt, q.completedAt])
    await bulkInsert(
      conn,
      'INSERT IGNORE INTO quest_entries (user_id, `mode`, quest_id, accepted_at, completed_at)',
      5,
      entryRows,
    )

    const objRows = data.quests.flatMap((q) =>
      q.objectivesDone.map((oid) => [userId, mode, q.questId, oid]),
    )
    await bulkInsert(
      conn,
      'INSERT IGNORE INTO quest_objectives_done (user_id, `mode`, quest_id, objective_id)',
      4,
      objRows,
    )

    await bulkInsert(
      conn,
      'INSERT IGNORE INTO unlocked_quests (user_id, `mode`, quest_id)',
      3,
      data.unlocked.map((id) => [userId, mode, id]),
    )

    await bulkInsert(
      conn,
      'INSERT IGNORE INTO collected_items (user_id, `mode`, item_id)',
      3,
      collected.map((id) => [userId, mode, id]),
    )

    const activityRows = data.activity.map((a) => [
      userId,
      mode,
      a.id,
      a.ts,
      a.kind,
      a.questId,
      a.questName,
      a.text,
      a.wiki,
    ])
    await bulkInsert(
      conn,
      'INSERT IGNORE INTO activities (user_id, `mode`, event_key, ts, kind, quest_id, quest_name, body, wiki)',
      9,
      activityRows,
    )

    // 活动流裁剪（同 repo/userData.ts 的策略）
    await conn.execute(
      `DELETE FROM activities
        WHERE user_id = ? AND \`mode\` = ?
          AND id NOT IN (
            SELECT id FROM (
              SELECT id FROM activities WHERE user_id = ? AND \`mode\` = ? ORDER BY id DESC LIMIT ${ACTIVITY_CAP}
            ) AS keep_rows
          )`,
      [userId, mode, userId, mode],
    )

    if (data.currentMap) {
      await conn.execute(
        `INSERT INTO user_mode_state (user_id, \`mode\`, current_map) VALUES (?, ?, ?)
         ON DUPLICATE KEY UPDATE current_map = VALUES(current_map)`,
        [userId, mode, data.currentMap],
      )
    }
  })
}

interface QuestCountRow extends RowDataPacket {
  mode: string
  quests: number
  completed: number
}

interface CountRow extends RowDataPacket {
  mode: string
  n: number
}

/** 账号数据概览：登录后据此判断是否需要引导导入 */
export interface AccountSummary {
  empty: boolean
  modes: Record<Mode, { quests: number; completed: number; collected: number; unlocked: number }>
}

export async function accountSummary(userId: number): Promise<AccountSummary> {
  const rows = await tx(async (conn) => {
    const [questRows] = await conn.query<QuestCountRow[]>(
      `SELECT \`mode\`,
              SUM(CASE WHEN accepted_at IS NOT NULL OR completed_at IS NOT NULL THEN 1 ELSE 0 END) AS quests,
              SUM(CASE WHEN completed_at IS NOT NULL THEN 1 ELSE 0 END) AS completed
         FROM quest_entries WHERE user_id = ? GROUP BY \`mode\``,
      [userId],
    )
    const [collectedRows] = await conn.query<CountRow[]>(
      'SELECT `mode`, COUNT(*) AS n FROM collected_items WHERE user_id = ? GROUP BY `mode`',
      [userId],
    )
    const [unlockedRows] = await conn.query<CountRow[]>(
      'SELECT `mode`, COUNT(*) AS n FROM unlocked_quests WHERE user_id = ? GROUP BY `mode`',
      [userId],
    )
    return { questRows, collectedRows, unlockedRows }
  })

  const modes = Object.fromEntries(
    MODES.map((m) => [m, { quests: 0, completed: 0, collected: 0, unlocked: 0 }]),
  ) as AccountSummary['modes']

  for (const r of rows.questRows) {
    const k = r.mode as Mode
    if (!modes[k]) continue
    modes[k].quests = Number(r.quests ?? 0)
    modes[k].completed = Number(r.completed ?? 0)
  }
  for (const r of rows.collectedRows) {
    const k = r.mode as Mode
    if (modes[k]) modes[k].collected = Number(r.n ?? 0)
  }
  for (const r of rows.unlockedRows) {
    const k = r.mode as Mode
    if (modes[k]) modes[k].unlocked = Number(r.n ?? 0)
  }

  const empty = MODES.every((m) => modes[m].quests === 0 && modes[m].collected === 0)
  return { empty, modes }
}
