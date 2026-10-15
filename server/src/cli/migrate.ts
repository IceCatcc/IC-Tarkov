/** 独立迁移命令：npm run migrate（不改数据，只建表 / 升级结构） */
import { closePool, initPool } from '../db.js'
import { runMigrations } from '../migrate.js'

try {
  await initPool()
  const applied = await runMigrations()
  console.log(applied.length === 0 ? '没有待应用的迁移' : `已应用 ${applied.length} 个迁移`)
} catch (e) {
  console.error('迁移失败：', e)
  process.exitCode = 1
} finally {
  await closePool()
}
