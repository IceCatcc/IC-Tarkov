/**
 * 按用户 + 模式隔离的用户数据访问层。
 * 对应桌面端的 store.rs / persist.rs —— 那里是内存 HashMap + JSON 文件，这里是 MySQL 表。
 */
import type { RowDataPacket } from 'mysql2'
import { execute, query, queryOne, tx } from '../db.js'
import { normMode, type ActivityRow, type Mode, type PlayerQuest } from '../types.js'
import * as qi from '../data/questIndex.js'
import { nowSql } from '../util/time.js'

/** 活动流上限，与桌面端 store.rs 的 ACTIVITY_CAP 一致 */
const ACTIVITY_CAP = 800

export interface QuestEntry {
  acceptedAt: string | null
  completedAt: string | null
}

/* ---------------- 任务进度 ---------------- */

export async function loadQuestEntries(userId: number, mode: Mode): Promise<Map<string, QuestEntry>> {
  const rows = await query<RowDataPacket & { quest_id: string; accepted_at: string | null; completed_at: string | null }>(
    'SELECT quest_id, accepted_at, completed_at FROM quest_entries WHERE user_id = ? AND `mode` = ?',
    [userId, mode],
  )
  return new Map(rows.map((r) => [r.quest_id, { acceptedAt: r.accepted_at, completedAt: r.completed_at }]))
}

/** 只记录「目标打勾」、既未接取也未完成的条目不算玩家任务 */
export async function buildPlayerQuests(userId: number, mode: Mode): Promise<PlayerQuest[]> {
  const entries = await loadQuestEntries(userId, mode)
  const completed = new Set<string>()
  for (const [id, e] of entries) if (e.completedAt) completed.add(id)
  const failed = qi.failedQuests(completed)

  const out: PlayerQuest[] = []
  for (const [questId, entry] of entries) {
    if (!entry.acceptedAt && !entry.completedAt) continue
    const info = qi.resolveAccept(questId)
    const status = entry.completedAt ? 'completed' : failed.has(questId) ? 'failed' : 'in_progress'
    out.push({
      questId,
      name: info.name,
      traderId: info.traderId,
      traderName: info.traderName,
      acceptedAt: entry.acceptedAt,
      completedAt: entry.completedAt,
      status,
      wiki: info.wiki,
      minLevel: info.minLevel,
      maps: qi.questMaps(questId),
    })
  }
  // 最新接取在前（与桌面端一致）
  out.sort((a, b) => (b.acceptedAt ?? '').localeCompare(a.acceptedAt ?? ''))
  return out
}

export async function getUnlocked(userId: number, mode: Mode): Promise<string[]> {
  const rows = await query<RowDataPacket & { quest_id: string }>(
    'SELECT quest_id FROM unlocked_quests WHERE user_id = ? AND `mode` = ?',
    [userId, mode],
  )
  return rows.map((r) => r.quest_id)
}

/** 活动流（最新的在前）；limit 为 0 表示不限制 */
export async function getActivity(userId: number, mode: Mode, limit = 0): Promise<ActivityRow[]> {
  const sql =
    'SELECT id, ts, kind, quest_id, quest_name, body, wiki FROM activities ' +
    'WHERE user_id = ? AND `mode` = ? ORDER BY id DESC' + (limit > 0 ? ` LIMIT ${Number(limit)}` : '')
  const rows = await query<RowDataPacket & {
    id: number
    ts: string
    kind: ActivityRow['kind']
    quest_id: string
    quest_name: string
    body: string
    wiki: string | null
  }>(sql, [userId, mode])
  return rows.map((r) => ({
    id: String(r.id),
    ts: r.ts,
    kind: r.kind,
    questId: r.quest_id,
    questName: r.quest_name,
    text: r.body,
    wiki: r.wiki,
  }))
}

export interface NewActivity {
  /** 确定性去重键（同桌面端 ActivityRow.id，如 `acc|<任务id>`、`unl|<任务id>|<时间>`） */
  key: string
  ts: string
  kind: ActivityRow['kind']
  questId: string
  questName: string
  text: string
  wiki?: string | null
}

/** 执行器：事务内传入绑定的 conn，否则走连接池 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Executor = (sql: string, params: any[]) => Promise<unknown>

const poolExec: Executor = (sql, params) => execute(sql, params)

/** 追加一条活动；event_key 重复时忽略（幂等），并保持每模式最多 ACTIVITY_CAP 条 */
export async function pushActivity(
  userId: number,
  mode: Mode,
  row: NewActivity,
  exec: Executor = poolExec,
): Promise<void> {
  await exec(
    `INSERT IGNORE INTO activities (user_id, \`mode\`, event_key, ts, kind, quest_id, quest_name, body, wiki)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [userId, mode, row.key, row.ts, row.kind, row.questId, row.questName, row.text, row.wiki ?? null],
  )
  // 裁剪：只保留最近 ACTIVITY_CAP 条（DELETE 引用同表需用派生表绕过 MySQL 限制）
  await exec(
    `DELETE FROM activities
      WHERE user_id = ? AND \`mode\` = ?
        AND id NOT IN (
          SELECT id FROM (
            SELECT id FROM activities WHERE user_id = ? AND \`mode\` = ? ORDER BY id DESC LIMIT ${ACTIVITY_CAP}
          ) AS keep_rows
        )`,
    [userId, mode, userId, mode],
  )
}

/** 事务内的执行器包装 */
function connExec(conn: import('mysql2/promise').PoolConnection): Executor {
  return (sql, params) => conn.execute(sql, params)
}

/* ---------------- 目标打勾 ---------------- */

export async function getObjectivesDone(
  userId: number,
  mode: Mode,
  questId: string,
): Promise<string[]> {
  const rows = await query<RowDataPacket & { objective_id: string }>(
    'SELECT objective_id FROM quest_objectives_done WHERE user_id = ? AND `mode` = ? AND quest_id = ?',
    [userId, mode, questId],
  )
  return rows.map((r) => r.objective_id)
}

/** 全部任务的目标打勾：questId -> objectiveId[]（地图页一次性预取用） */
export async function getAllObjectivesDone(
  userId: number,
  mode: Mode,
): Promise<Record<string, string[]>> {
  const rows = await query<RowDataPacket & { quest_id: string; objective_id: string }>(
    'SELECT quest_id, objective_id FROM quest_objectives_done WHERE user_id = ? AND `mode` = ?',
    [userId, mode],
  )
  const out: Record<string, string[]> = {}
  for (const r of rows) (out[r.quest_id] ??= []).push(r.objective_id)
  return out
}

export async function setObjectiveDone(
  userId: number,
  mode: Mode,
  questId: string,
  objectiveId: string,
  done: boolean,
): Promise<string[]> {
  if (done) {
    await execute(
      `INSERT IGNORE INTO quest_objectives_done (user_id, \`mode\`, quest_id, objective_id)
       VALUES (?, ?, ?, ?)`,
      [userId, mode, questId, objectiveId],
    )
  } else {
    await execute(
      'DELETE FROM quest_objectives_done WHERE user_id = ? AND `mode` = ? AND quest_id = ? AND objective_id = ?',
      [userId, mode, questId, objectiveId],
    )
  }
  return getObjectivesDone(userId, mode, questId)
}

/* ---------------- 收藏家 ---------------- */

export async function getCollected(userId: number, mode: Mode): Promise<string[]> {
  const rows = await query<RowDataPacket & { item_id: string }>(
    'SELECT item_id FROM collected_items WHERE user_id = ? AND `mode` = ?',
    [userId, mode],
  )
  return rows.map((r) => r.item_id)
}

export async function setCollected(
  userId: number,
  mode: Mode,
  itemId: string,
  collected: boolean,
): Promise<string[]> {
  if (collected) {
    await execute(
      'INSERT IGNORE INTO collected_items (user_id, `mode`, item_id) VALUES (?, ?, ?)',
      [userId, mode, itemId],
    )
  } else {
    await execute('DELETE FROM collected_items WHERE user_id = ? AND `mode` = ? AND item_id = ?', [
      userId,
      mode,
      itemId,
    ])
  }
  return getCollected(userId, mode)
}

/* ---------------- 手动修改任务状态 ---------------- */

export interface StatusResult {
  quests: PlayerQuest[]
  unlocked: string[]
}

/**
 * 手动修改任务状态，语义与桌面端 set_quest_status 完全一致：
 * - accept   ：完成该任务链的全部前置，并把本任务标记为已接取
 * - complete ：标记为已完成（未接取时同时补上接取时间）
 * - unlock   ：把本任务及其未完成的前置标记为「已解锁」
 * - reset    ：清空接取/完成时间与目标打勾，并取消解锁标记
 */
export async function setQuestStatus(
  userId: number,
  mode: Mode,
  questId: string,
  action: 'accept' | 'complete' | 'unlock' | 'reset',
): Promise<StatusResult> {
  const ts = nowSql()
  const activities: NewActivity[] = []

  await tx(async (conn) => {
    const exec = connExec(conn)

    const markCompleted = async (id: string, via: string) => {
      const row = await queryOneOn<EntryRow>(
        conn,
        'SELECT accepted_at, completed_at FROM quest_entries WHERE user_id = ? AND `mode` = ? AND quest_id = ?',
        [userId, mode, id],
      )
      if (row?.completed_at) return
      await conn.execute(
        `INSERT INTO quest_entries (user_id, \`mode\`, quest_id, accepted_at, completed_at)
         VALUES (?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE accepted_at = COALESCE(accepted_at, VALUES(accepted_at)), completed_at = VALUES(completed_at)`,
        [userId, mode, id, ts, ts],
      )
      const name = qi.resolveName(id)
      activities.push({
        key: `cmp|${id}|${via}|${ts}`,
        ts,
        kind: 'complete',
        questId: id,
        questName: name,
        text: via === 'manual' ? `手动完成：${name}` : `手动完成（接取前置）：${name}`,
      })
    }

    const markAccepted = async (id: string) => {
      await conn.execute(
        `INSERT INTO quest_entries (user_id, \`mode\`, quest_id, accepted_at)
         VALUES (?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE accepted_at = COALESCE(accepted_at, VALUES(accepted_at))`,
        [userId, mode, id, ts],
      )
    }

    switch (action) {
      case 'accept': {
        for (const pid of qi.prereqsClosure(questId)) await markCompleted(pid, 'prereq')
        await markAccepted(questId)
        const name = qi.resolveName(questId)
        activities.push({
          key: `acc|${questId}|manual|${ts}`,
          ts,
          kind: 'accept',
          questId,
          questName: name,
          text: `手动接取：${name}`,
        })
        break
      }
      case 'complete': {
        await markCompleted(questId, 'manual')
        break
      }
      case 'unlock': {
        const targets = [questId, ...qi.prereqsClosure(questId)]
        for (const id of targets) {
          const row = await queryOneOn<EntryRow>(
            conn,
            'SELECT accepted_at, completed_at FROM quest_entries WHERE user_id = ? AND `mode` = ? AND quest_id = ?',
            [userId, mode, id],
          )
          if (row?.completed_at) continue
          await conn.execute(
            'INSERT IGNORE INTO unlocked_quests (user_id, `mode`, quest_id) VALUES (?, ?, ?)',
            [userId, mode, id],
          )
          const name = qi.resolveName(id)
          activities.push({
            key: `unl|${id}|${ts}`,
            ts,
            kind: 'progress',
            questId: id,
            questName: name,
            text: `手动解锁：${name}`,
          })
        }
        break
      }
      case 'reset': {
        await conn.execute(
          'UPDATE quest_entries SET accepted_at = NULL, completed_at = NULL WHERE user_id = ? AND `mode` = ? AND quest_id = ?',
          [userId, mode, questId],
        )
        await conn.execute(
          'DELETE FROM quest_objectives_done WHERE user_id = ? AND `mode` = ? AND quest_id = ?',
          [userId, mode, questId],
        )
        await conn.execute(
          'DELETE FROM unlocked_quests WHERE user_id = ? AND `mode` = ? AND quest_id = ?',
          [userId, mode, questId],
        )
        const name = qi.resolveName(questId)
        activities.push({
          key: `rst|${questId}|manual|${ts}`,
          ts,
          kind: 'progress',
          questId,
          questName: name,
          text: `手动重置为未接取：${name}`,
        })
        break
      }
    }

    for (const a of activities) await pushActivity(userId, mode, a, exec)
  })

  return {
    quests: await buildPlayerQuests(userId, mode),
    unlocked: await getUnlocked(userId, mode),
  }
}

/** 日志检测到接取 / 完成时写入进度（幂等，供日志上传等入口复用） */
export async function applyDetectedEvent(
  userId: number,
  mode: Mode,
  kind: 'accept' | 'complete',
  questId: string,
  ts: string,
  source: string,
): Promise<void> {
  const name = qi.resolveName(questId)
  await tx(async (conn) => {
    const exec = connExec(conn)
    if (kind === 'accept') {
      await conn.execute(
        `INSERT INTO quest_entries (user_id, \`mode\`, quest_id, accepted_at) VALUES (?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE accepted_at = COALESCE(accepted_at, VALUES(accepted_at))`,
        [userId, mode, questId, ts],
      )
    } else {
      await conn.execute(
        `INSERT INTO quest_entries (user_id, \`mode\`, quest_id, accepted_at, completed_at) VALUES (?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE accepted_at = COALESCE(accepted_at, VALUES(accepted_at)), completed_at = COALESCE(completed_at, VALUES(completed_at))`,
        [userId, mode, questId, ts, ts],
      )
    }
    await pushActivity(
      userId,
      mode,
      {
        key: `${kind === 'accept' ? 'acc' : 'cmp'}|${questId}`,
        ts,
        kind,
        questId,
        questName: name,
        text: kind === 'accept' ? `接取任务：${name}` : `完成任务：${name}`,
      },
      exec,
    )
  })
  void source
}

/* ---------------- 当前地图 / 视野模式 ---------------- */

export async function getCurrentMap(userId: number, mode: Mode): Promise<string | null> {
  const row = await queryOne<RowDataPacket & { current_map: string | null }>(
    'SELECT current_map FROM user_mode_state WHERE user_id = ? AND `mode` = ?',
    [userId, mode],
  )
  return row?.current_map ?? null
}

export async function setCurrentMap(userId: number, mode: Mode, map: string | null): Promise<void> {
  await execute(
    `INSERT INTO user_mode_state (user_id, \`mode\`, current_map) VALUES (?, ?, ?)
     ON DUPLICATE KEY UPDATE current_map = VALUES(current_map)`,
    [userId, mode, map],
  )
}

export async function getViewMode(userId: number): Promise<Mode> {
  const row = await queryOne<RowDataPacket & { view_mode: string }>(
    'SELECT view_mode FROM user_settings WHERE user_id = ?',
    [userId],
  )
  return normMode(row?.view_mode)
}

export async function setViewMode(userId: number, mode: Mode): Promise<void> {
  await execute(
    `INSERT INTO user_settings (user_id, ui_prefs, view_mode) VALUES (?, JSON_OBJECT(), ?)
     ON DUPLICATE KEY UPDATE view_mode = VALUES(view_mode)`,
    [userId, mode],
  )
}

/* ---------------- 设置（UI 偏好） ---------------- */

export interface SettingsRow {
  logDir: string
  screenshotDir: string
  deleteScreenshots: boolean
  keepScreenOn: boolean
  uiPrefs: Record<string, unknown>
}

export async function getSettings(userId: number): Promise<SettingsRow> {
  const row = await queryOne<RowDataPacket & { ui_prefs: unknown }>(
    'SELECT ui_prefs FROM user_settings WHERE user_id = ?',
    [userId],
  )
  let prefs: Record<string, unknown> = {}
  if (row?.ui_prefs) {
    prefs =
      typeof row.ui_prefs === 'string'
        ? (JSON.parse(row.ui_prefs) as Record<string, unknown>)
        : (row.ui_prefs as Record<string, unknown>)
  }
  // 日志 / 截图目录属桌面端本地能力，web 端恒为空值，仅保持字段形状兼容前端
  return { logDir: '', screenshotDir: '', deleteScreenshots: false, keepScreenOn: false, uiPrefs: prefs }
}

/** 合并写入 UI 偏好（与桌面端一致：merge 而非整表替换，保留后端内部字段） */
export async function saveUiPrefs(
  userId: number,
  prefs: Record<string, unknown>,
): Promise<SettingsRow> {
  await execute(
    `INSERT INTO user_settings (user_id, ui_prefs) VALUES (?, CAST(? AS JSON))
     ON DUPLICATE KEY UPDATE ui_prefs = JSON_MERGE_PATCH(ui_prefs, CAST(? AS JSON))`,
    [userId, JSON.stringify(prefs), JSON.stringify(prefs)],
  )
  return getSettings(userId)
}

/* ---------------- 统计 ---------------- */

export async function getStats(userId: number, mode: Mode): Promise<{ inProgress: number; completed: number }> {
  const rows = await query<RowDataPacket & { in_progress: number; completed: number }>(
    `SELECT
       SUM(CASE WHEN completed_at IS NULL AND accepted_at IS NOT NULL THEN 1 ELSE 0 END) AS in_progress,
       SUM(CASE WHEN completed_at IS NOT NULL THEN 1 ELSE 0 END) AS completed
     FROM quest_entries WHERE user_id = ? AND \`mode\` = ?`,
    [userId, mode],
  )
  const r = rows[0]
  return { inProgress: Number(r?.in_progress ?? 0), completed: Number(r?.completed ?? 0) }
}

/* ---------------- 内部工具 ---------------- */

interface EntryRow extends RowDataPacket {
  accepted_at: string | null
  completed_at: string | null
}

async function queryOneOn<T extends RowDataPacket>(
  conn: import('mysql2/promise').PoolConnection,
  sql: string,
  params: unknown[],
): Promise<T | null> {
  const [rows] = await conn.query<T[]>(sql, params)
  return rows.length > 0 ? rows[0] : null
}
