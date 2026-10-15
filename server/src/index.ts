import { buildApp } from './app.js'
import { config } from './config.js'
import { closePool, initPool } from './db.js'
import { runMigrations } from './migrate.js'
import { purgeExpiredSessions } from './auth/session.js'
import { derived } from './data/derive.js'
import { ensureDirs, seedFromRepo, status, sync } from './data/store.js'
import { invalidateIndex } from './data/questIndex.js'

async function bootstrap(): Promise<void> {
  console.log('[boot] 连接数据库…')
  await initPool()
  const applied = await runMigrations()
  if (applied.length === 0) console.log('[boot] 数据库结构已是最新')

  const purged = await purgeExpiredSessions()
  if (purged > 0) console.log(`[boot] 已清理 ${purged} 个过期会话`)

  console.log('[boot] 准备游戏数据目录…')
  await ensureDirs()
  await seedFromRepo()
  await derived.load()

  const app = await buildApp()
  await app.listen({ port: config.port, host: config.host })

  // 后台：数据过期且本地已有缓存时静默同步（与桌面端 load_in_background 行为一致）
  void (async () => {
    try {
      const st = await status()
      if (st.stale && st.files.some((f) => f.bytes > 0)) {
        console.log('[data] 检测到数据已过期，后台同步中…')
        const report = await sync(false)
        console.log(`[data] ${report.message}`)
        if (report.updated.length > 0) {
          await derived.rebuild()
          invalidateIndex()
        }
      }
    } catch (e) {
      console.warn(`[data] 后台同步失败：${e instanceof Error ? e.message : String(e)}`)
    }
  })()

  // 定时清理过期会话（每小时）
  const timer = setInterval(
    () => void purgeExpiredSessions().catch(() => {}),
    3600 * 1000,
  )
  timer.unref()

  const shutdown = async (signal: string) => {
    console.log(`[boot] 收到 ${signal}，正在关闭…`)
    clearInterval(timer)
    try {
      await app.close()
    } catch {
      /* 忽略关闭异常 */
    }
    await closePool()
    process.exit(0)
  }
  process.on('SIGINT', () => void shutdown('SIGINT'))
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
}

bootstrap().catch((e) => {
  console.error('[boot] 启动失败：', e)
  process.exit(1)
})
