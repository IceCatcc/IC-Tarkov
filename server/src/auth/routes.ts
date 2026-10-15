import type { FastifyInstance, FastifyReply } from 'fastify'
import type { ResultSetHeader, RowDataPacket } from 'mysql2'
import { z } from 'zod'
import { execute, queryOne, tx } from '../db.js'
import { hashPassword, verifyPassword } from './password.js'
import {
  attachUser,
  createSession,
  currentUser,
  destroySession,
  requireUser,
} from './session.js'

/** 用户名字符集：中英文、数字、下划线、连字符 */
const USERNAME_RE = /^[A-Za-z0-9_\-\u4e00-\u9fa5]{3,32}$/

const registerSchema = z.object({
  username: z.string().trim().regex(USERNAME_RE, '用户名需为 3-32 位中英文 / 数字 / 下划线 / 连字符'),
  password: z.string().min(6, '密码至少 6 位').max(128, '密码过长'),
})

const loginSchema = z.object({
  username: z.string().trim().min(1),
  password: z.string().min(1),
})

interface UserRow extends RowDataPacket {
  id: number
  username: string
  password_hash: string
}

function badRequest(reply: FastifyReply, message: string) {
  return reply.code(400).send({ error: 'bad_request', message })
}

export function registerAuthRoutes(app: FastifyInstance): void {
  app.post('/api/auth/register', async (req, reply) => {
    const parsed = registerSchema.safeParse(req.body)
    if (!parsed.success) return badRequest(reply, parsed.error.issues[0]?.message ?? '参数不合法')
    const { username, password } = parsed.data
    const ci = username.toLowerCase()

    const exists = await queryOne<RowDataPacket & { id: number }>(
      'SELECT id FROM users WHERE username_ci = ?',
      [ci],
    )
    if (exists) return reply.code(409).send({ error: 'conflict', message: '该用户名已被注册' })

    const hash = await hashPassword(password)
    const userId = await tx(async (conn) => {
      const [res] = await conn.execute<ResultSetHeader>(
        'INSERT INTO users (username, username_ci, password_hash) VALUES (?, ?, ?)',
        [username, ci, hash],
      )
      const id = res.insertId
      await conn.execute('INSERT INTO user_settings (user_id, ui_prefs) VALUES (?, JSON_OBJECT())', [id])
      return id
    })

    await createSession(userId, req, reply)
    return { user: { id: userId, username } }
  })

  app.post('/api/auth/login', async (req, reply) => {
    const parsed = loginSchema.safeParse(req.body)
    if (!parsed.success) return badRequest(reply, '参数不合法')
    const { username, password } = parsed.data

    const row = await queryOne<UserRow>(
      'SELECT id, username, password_hash FROM users WHERE username_ci = ?',
      [username.toLowerCase()],
    )
    // 用户名不存在与口令错误返回同一提示，避免用户名枚举
    if (!row || !(await verifyPassword(password, row.password_hash))) {
      return reply.code(401).send({ error: 'unauthorized', message: '用户名或密码错误' })
    }
    await createSession(Number(row.id), req, reply)
    return { user: { id: Number(row.id), username: row.username } }
  })

  app.post('/api/auth/logout', async (req, reply) => {
    await destroySession(req, reply)
    return { ok: true }
  })

  /** 当前登录状态：未登录返回 user: null（而非 401），便于前端首屏判断 */
  app.get('/api/auth/me', { preHandler: attachUser }, async (req) => {
    return { user: req.user ? { id: req.user.id, username: req.user.username } : null }
  })

  /** 修改密码：需登录 + 校验旧口令；成功后吊销其它会话 */
  const changeSchema = z.object({
    oldPassword: z.string().min(1),
    newPassword: z.string().min(6).max(128),
  })
  app.post('/api/auth/password', { preHandler: requireUser }, async (req, reply) => {
    const parsed = changeSchema.safeParse(req.body)
    if (!parsed.success) return badRequest(reply, parsed.error.issues[0]?.message ?? '参数不合法')
    const me = currentUser(req)
    const row = await queryOne<UserRow>('SELECT id, username, password_hash FROM users WHERE id = ?', [
      me.id,
    ])
    if (!row || !(await verifyPassword(parsed.data.oldPassword, row.password_hash))) {
      return reply.code(400).send({ error: 'bad_request', message: '原密码不正确' })
    }
    await execute('UPDATE users SET password_hash = ? WHERE id = ?', [
      await hashPassword(parsed.data.newPassword),
      me.id,
    ])
    // 保留当前会话，踢掉其它设备
    const keep = req.cookies?.['ict_sid'] ?? ''
    await execute(
      'DELETE FROM sessions WHERE user_id = ? AND token_hash <> SHA2(?, 256)',
      [me.id, keep],
    )
    return { ok: true }
  })
}
