import { createHash, randomBytes } from 'node:crypto'
import type { FastifyReply, FastifyRequest } from 'fastify'
import type { RowDataPacket } from 'mysql2'
import { config } from '../config.js'
import { execute, queryOne } from '../db.js'

export interface AuthUser {
  id: number
  username: string
}

interface SessionUserRow extends RowDataPacket {
  id: number
  username: string
  expires_at: string
}

declare module 'fastify' {
  interface FastifyRequest {
    user?: AuthUser
  }
}

/** 会话令牌只存 sha256：即便数据库泄露也无法直接拿去登录 */
function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

export function sessionExpiry(): string {
  const d = new Date(Date.now() + config.session.ttlDays * 24 * 3600 * 1000)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(
    d.getMinutes(),
  )}:${pad(d.getSeconds())}`
}

/** 新建会话并写入 Cookie */
export async function createSession(
  userId: number,
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<string> {
  const token = randomBytes(32).toString('base64url')
  await execute(
    `INSERT INTO sessions (token_hash, user_id, expires_at, user_agent, ip)
     VALUES (?, ?, ?, ?, ?)`,
    [
      hashToken(token),
      userId,
      sessionExpiry(),
      (req.headers['user-agent'] ?? '').slice(0, 255),
      (req.ip ?? '').slice(0, 64),
    ],
  )
  reply.setCookie(config.session.cookieName, token, {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure: config.cookieSecure,
    maxAge: config.session.ttlDays * 24 * 3600,
  })
  return token
}

/** 按 Cookie 解析当前用户（无效/过期返回 null，并顺手清理过期会话） */
export async function resolveUser(req: FastifyRequest): Promise<AuthUser | null> {
  const token = req.cookies?.[config.session.cookieName]
  if (!token) return null
  const row = await queryOne<SessionUserRow>(
    `SELECT u.id, u.username, s.expires_at
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ?`,
    [hashToken(token)],
  )
  if (!row) return null
  if (new Date(row.expires_at.replace(' ', 'T')).getTime() < Date.now()) {
    await execute('DELETE FROM sessions WHERE token_hash = ?', [hashToken(token)])
    return null
  }
  return { id: Number(row.id), username: row.username }
}

/** 删除当前会话并清 Cookie */
export async function destroySession(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const token = req.cookies?.[config.session.cookieName]
  if (token) await execute('DELETE FROM sessions WHERE token_hash = ?', [hashToken(token)])
  reply.clearCookie(config.session.cookieName, { path: '/' })
}

/** 全局 preHandler：解析用户但**不**强制登录（供 /api/auth/me 等使用） */
export async function attachUser(req: FastifyRequest): Promise<void> {
  req.user = (await resolveUser(req)) ?? undefined
}

/** 全局 preHandler：要求已登录，未登录直接 401 并短路 */
export async function requireUser(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const user = await resolveUser(req)
  if (!user) {
    await reply.code(401).send({ error: 'unauthorized', message: '请先登录' })
    return
  }
  req.user = user
}

/** 取当前用户，未登录时抛错（在已挂 requireUser 的路由内使用） */
export function currentUser(req: FastifyRequest): AuthUser {
  if (!req.user) throw new Error('未登录')
  return req.user
}

/** 清理过期会话（启动时与定时任务调用） */
export async function purgeExpiredSessions(): Promise<number> {
  const res = await execute('DELETE FROM sessions WHERE expires_at < NOW()')
  return res.affectedRows
}
