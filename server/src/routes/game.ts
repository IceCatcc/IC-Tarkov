/**
 * 游戏静态数据接口（全站共享，不区分用户）：
 * 任务图谱 / 任务详情 / 物品目录 / 地图列表 / 地图标记 / 目标区域 / Boss / 骨架。
 * 对应桌面端 lib.rs 的 get_quest_graph / get_quest_detail / get_items / get_map_markers 等命令。
 */
import type { FastifyInstance } from 'fastify'
import { derived } from '../data/derive.js'
import { readRawJson } from '../data/store.js'
import * as qi from '../data/questIndex.js'

export function registerGameRoutes(app: FastifyInstance): void {
  app.get('/api/graph', async () => qi.getGraph())

  app.get('/api/quests/:questId', async (req, reply) => {
    const { questId } = req.params as { questId: string }
    const detail = qi.getDetail(questId)
    if (!detail) return reply.code(404).send({ error: 'not_found', message: '任务不存在' })
    return detail
  })

  app.get('/api/items', async () => qi.getItems())

  app.get('/api/maps', async () => qi.getMaps())

  app.get('/api/collector-quest-id', async () => qi.collectorQuestId())

  app.get('/api/map/markers', async () => derived.getOr('markers', { version: 1, maps: {} }))

  app.get('/api/map/zones', async () => derived.getOr('zones', { version: 1, tasks: {} }))

  app.get('/api/map/bosses', async () => derived.getOr('bosses', { version: 1, maps: {} }))

  /**
   * 地图骨架：优先取派生文档；没有时直接回退到原始缓存里的 maps-skeleton.json
   * （该文件随仓库携带、不随游戏数据更新，天然可用）。
   */
  app.get('/api/map/skeleton', async () => {
    const fromDerived = derived.get('skeleton')
    if (fromDerived) return fromDerived
    const raw = await readRawJson<unknown>('maps-skeleton.json')
    return raw ?? { version: 1, groups: [] }
  })
}
