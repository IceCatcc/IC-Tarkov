import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { currentUser } from '../auth/session.js'
import * as repo from '../repo/userData.js'
import { badRequest } from './helpers.js'

const schema = z.object({
  /** UI 偏好（图谱筛选 / 地图图标 / 缩放 / Wiki 设置等），与桌面端 uiPrefs 同构 */
  uiPrefs: z.record(z.unknown()).optional(),
})

export function registerSettingsRoutes(app: FastifyInstance): void {
  app.get('/api/settings', async (req) => {
    const me = currentUser(req)
    return repo.getSettings(me.id)
  })

  /**
   * 保存设置。web 端没有日志 / 截图目录，目录相关字段一律忽略，
   * 只做 uiPrefs 的合并写入（同桌面端 save_settings 的 merge 语义）。
   */
  app.put('/api/settings', async (req, reply) => {
    const me = currentUser(req)
    const parsed = schema.safeParse(req.body ?? {})
    if (!parsed.success) return badRequest(reply, '参数不合法')
    if (parsed.data.uiPrefs) {
      const next = await repo.saveUiPrefs(me.id, parsed.data.uiPrefs)
      return next
    }
    return repo.getSettings(me.id)
  })
}
