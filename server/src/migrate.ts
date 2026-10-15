import fs from 'node:fs/promises'
import path from 'node:path'
import type { RowDataPacket } from 'mysql2'
import { createMultiStatementConnection } from './db.js'
import { paths } from './config.js'

interface MigrationRow extends RowDataPacket {
  version: string
}

/**
 * 迁移执行器：按文件名排序应用 sql/ 下未被记录的 .sql 文件。
 * 不包事务 —— MySQL 的 DDL 会隐式提交，包事务只会造成「原子」的错觉；
 * 建表语句统一使用 IF NOT EXISTS，可重复执行。
 */
export async function runMigrations(): Promise<string[]> {
  const conn = await createMultiStatementConnection()
  const applied: string[] = []
  try {
    await conn.query(
      `CREATE TABLE IF NOT EXISTS schema_migrations (
         version    VARCHAR(128) NOT NULL,
         applied_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
         PRIMARY KEY (version)
       ) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4`,
    )
    const [rows] = await conn.query<MigrationRow[]>('SELECT version FROM schema_migrations')
    const done = new Set(rows.map((r) => r.version))

    let files: string[] = []
    try {
      files = (await fs.readdir(paths.sqlDir)).filter((f) => f.endsWith('.sql')).sort()
    } catch {
      return applied
    }

    for (const file of files) {
      if (done.has(file)) continue
      const sql = await fs.readFile(path.join(paths.sqlDir, file), 'utf8')
      try {
        await conn.query(sql)
      } catch (e) {
        throw new Error(`迁移 ${file} 执行失败：${e instanceof Error ? e.message : String(e)}`)
      }
      await conn.query('INSERT INTO schema_migrations (version) VALUES (?)', [file])
      applied.push(file)
      console.log(`[db] 已应用迁移 ${file}`)
    }
  } finally {
    await conn.end()
  }
  return applied
}
