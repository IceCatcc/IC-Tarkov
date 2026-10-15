/**
 * 用户进度相关接口：任务进度 / 目标打勾 / 收藏 / 解锁 / 活动流 / 设置以外的状态。
 * 对应桌面端 lib.rs 中的 get_player_quests / set_quest_status / get_collected_items 等命令。
 */
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { currentUser } from '../auth/session.js'
import * as repo from '../repo/userData.js'
import { hub } from '../realtime/hub.js'
import { badRequest, resolveMode } from './helpers.js'

const statusSchema = z.object({
  action: z.enum(['accept', 'complete', 'unlock', 'reset']),
  mode: z.string().optional(),
})

const objectiveSchema = z.object({
  done: z.boolean(),
  mode: z.string().optional(),
})

const collectedSchema = z.object({
  collected: z.boolean(),
  mode: z.string().optional(),
})

export function registerProgressRoutes(app: FastifyInstance): void {
  /** 监控状态：web 端无本地日志监控，恒为未监控；字段形状与桌面端保持一致 */
  app.get('/api/state', async () => ({
    watching: false,
    logDir: '',
    sessions: 0,
    lastScan: null,
    error: null,
  }))

  app.get('/api/stats', async (req) => {
    const me = currentUser(req)
    return repo.getStats(me.id, await resolveMode(req))
  })

  app.get('/api/quests', async (req) => {
    const me = currentUser(req)
    return repo.buildPlayerQuests(me.id, await resolveMode(req))
  })

  /** 手动修改任务状态：accept / complete / unlock / reset */
  app.post('/api/quests/:questId/status', async (req, reply) => {
    const me = currentUser(req)
    const parsed = statusSchema.safeParse(req.body ?? {})
    if (!parsed.success) return badRequest(reply, 'action 参数不合法')
    const { questId } = req.params as { questId: string }
    const mode = await resolveMode(req)
    const res = await repo.setQuestStatus(me.id, mode, questId, parsed.data.action)
    // 同一账号的其它设备/标签页需要刷新任务列表
    hub.emit(me.id, 'quests-changed', { mode, questId, action: parsed.data.action })
    return res
  })

  /** 某任务已打勾的目标 id */
  app.get('/api/quests/:questId/objectives', async (req) => {
    const me = currentUser(req)
    const { questId } = req.params as { questId: string }
    return repo.getObjectivesDone(me.id, await resolveMode(req), questId)
  })

  app.put('/api/quests/:questId/objectives/:objectiveId', async (req, reply) => {
    const me = currentUser(req)
    const parsed = objectiveSchema.safeParse(req.body ?? {})
    if (!parsed.success) return badRequest(reply, 'done 参数不合法')
    const { questId, objectiveId } = req.params as { questId: string; objectiveId: string }
    const mode = await resolveMode(req)
    const ids = await repo.setObjectiveDone(me.id, mode, questId, objectiveId, parsed.data.done)
    hub.emit(me.id, 'objective-changed', { mode, questId, objectivesDone: ids })
    return ids
  })

  /** 一次性取回全部任务的目标打勾（地图页预取用） */
  app.get('/api/objectives', async (req) => {
    const me = currentUser(req)
    return repo.getAllObjectivesDone(me.id, await resolveMode(req))
  })

  app.get('/api/unlocked', async (req) => {
    const me = currentUser(req)
    return repo.getUnlocked(me.id, await resolveMode(req))
  })

  app.get('/api/activity', async (req) => {
    const me = currentUser(req)
    const q = req.query as { limit?: string }
    const limit = Number(q.limit ?? 0)
    return repo.getActivity(me.id, await resolveMode(req), Number.isFinite(limit) ? limit : 0)
  })

  app.get('/api/collected', async (req) => {
    const me = currentUser(req)
    return repo.getCollected(me.id, await resolveMode(req))
  })

  app.put('/api/collected/:itemId', async (req, reply) => {
    const me = currentUser(req)
    const parsed = collectedSchema.safeParse(req.body ?? {})
    if (!parsed.success) return badRequest(reply, 'collected 参数不合法')
    const { itemId } = req.params as { itemId: string }
    const mode = await resolveMode(req)
    const all = await repo.setCollected(me.id, mode, itemId, parsed.data.collected)
    hub.emit(me.id, 'collected-changed', { mode, items: all })
    return all
  })

  /** 会话模式：web 端没有日志检测，直接返回用户保存的查看模式（保证多端一致） */
  app.get('/api/session-mode', async (req) => {
    const me = currentUser(req)
    return repo.getViewMode(me.id)
  })

  app.put('/api/mode', async (req, reply) => {
    const me = currentUser(req)
    const body = req.body as { mode?: string }
    if (!body?.mode) return badRequest(reply, '缺少 mode')
    const mode = await resolveMode(req)
    await repo.setViewMode(me.id, mode)
    return { mode }
  })

  app.get('/api/current-map', async (req) => {
    const me = currentUser(req)
    return repo.getCurrentMap(me.id, await resolveMode(req))
  })
}
