import mysql from 'mysql2/promise'
import type { Pool, PoolConnection, RowDataPacket, ResultSetHeader } from 'mysql2/promise'
import { config } from './config.js'

let pool: Pool | null = null

/** 首次连接时按需建库（DB_AUTO_CREATE=true） */
async function ensureDatabase(): Promise<void> {
  if (!config.db.autoCreate) return
  const conn = await mysql.createConnection({
    host: config.db.host,
    port: config.db.port,
    user: config.db.user,
    password: config.db.password,
  })
  try {
    await conn.query(
      `CREATE DATABASE IF NOT EXISTS \`${config.db.database}\`
       CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
    )
  } finally {
    await conn.end()
  }
}

export async function initPool(): Promise<void> {
  await ensureDatabase()
  pool = mysql.createPool({
    host: config.db.host,
    port: config.db.port,
    user: config.db.user,
    password: config.db.password,
    database: config.db.database,
    waitForConnections: true,
    connectionLimit: config.db.poolSize,
    charset: 'utf8mb4',
    timezone: 'local',
    // DATETIME 一律以字符串返回，避免驱动把 'YYYY-MM-DD HH:mm:ss' 转成 Date 后再被 JSON 序列化成 ISO
    dateStrings: true,
  })
  // 尽早暴露连接问题
  const conn = await pool.getConnection()
  conn.release()
}

export function getPool(): Pool {
  if (!pool) throw new Error('数据库连接池尚未初始化')
  return pool
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end()
    pool = null
  }
}

/** 查询多行 */
export async function query<T extends RowDataPacket = RowDataPacket>(
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  const [rows] = await getPool().query<T[]>(sql, params)
  return rows
}

/** 查询单行（无结果返回 null） */
export async function queryOne<T extends RowDataPacket = RowDataPacket>(
  sql: string,
  params: unknown[] = [],
): Promise<T | null> {
  const rows = await query<T>(sql, params)
  return rows.length > 0 ? rows[0] : null
}

/** 执行写入，返回受影响行数与自增 id */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function execute(sql: string, params: any[] = []): Promise<ResultSetHeader> {
  const [res] = await getPool().execute<ResultSetHeader>(sql, params)
  return res
}

/**
 * 事务包装：回调内的所有操作使用同一连接。
 * 抛出异常即回滚。
 */
export async function tx<T>(fn: (conn: PoolConnection) => Promise<T>): Promise<T> {
  const conn = await getPool().getConnection()
  try {
    await conn.beginTransaction()
    const out = await fn(conn)
    await conn.commit()
    return out
  } catch (e) {
    try {
      await conn.rollback()
    } catch {
      /* 回滚失败时保留原始异常 */
    }
    throw e
  } finally {
    conn.release()
  }
}

/** 创建一条启用多语句的独立连接（仅迁移脚本使用） */
export async function createMultiStatementConnection(): Promise<PoolConnection> {
  const conn = await mysql.createConnection({
    host: config.db.host,
    port: config.db.port,
    user: config.db.user,
    password: config.db.password,
    database: config.db.database,
    multipleStatements: true,
    charset: 'utf8mb4',
    dateStrings: true,
  })
  return conn as unknown as PoolConnection
}
