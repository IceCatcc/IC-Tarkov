/**
 * 游戏数据缓存状态与刷新（对应桌面端 get_data_status / refresh_game_data）。
 * 刷新是全局操作：任何登录用户都能触发，但同一时刻只有一个任务在跑。
 */
import type { FastifyInstance } from 'fastify'
import { derived } from '../data/derive.js'
import * as store from '../data/store.js'
import { invalidateIndex } from '../data/questIndex.js'

let lastRefreshAt = 0

export function registerDataRoutes(app: FastifyInstance): void {
  app.get('/api/data/status', async () => {
    const base = await store.status()
    const stats = derived.stats()
    return {
      ...base,
      questCount: stats.quests,
      mapCount: stats.maps,
      derivedReady: stats.ready,
      derivedMissing: stats.missing,
      derivedBuiltAt: stats.builtAt,
    }
  })

  app.post('/api/data/refresh', async (req, reply) => {
    if (store.isSyncing()) {
      return reply.code(409).send({ error: 'busy', message: '数据更新正在进行中' })
    }
    const body = (req.body ?? {}) as { force?: boolean }
    const report = await store.sync(!!body.force)
    if (report.updated.length > 0) {
      // 原始数据变了 → 重建派生索引（dataset.rs 移植前为空操作）
      await derived.rebuild()
      invalidateIndex()
      lastRefreshAt = Date.now()
    }
    return { ...report, builtAt: lastRefreshAt }
  })
}
