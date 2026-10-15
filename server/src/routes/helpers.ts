import type { FastifyReply, FastifyRequest } from 'fastify'
import { normMode, type Mode } from '../types.js'
import { currentUser } from '../auth/session.js'
import * as repo from '../repo/userData.js'

/**
 * 解析本次请求要操作的任务模式：
 * 优先级 显式参数（?mode= / body.mode） > 用户保存的「查看模式」 > pvp
 */
export async function resolveMode(req: FastifyRequest): Promise<Mode> {
  const q = req.query as Record<string, unknown> | undefined
  const b = req.body as Record<string, unknown> | undefined
  const explicit = q?.mode ?? b?.mode
  if (typeof explicit === 'string' && explicit.trim()) return normMode(explicit)
  return repo.getViewMode(currentUser(req).id)
}

export function badRequest(reply: FastifyReply, message: string) {
  return reply.code(400).send({ error: 'bad_request', message })
}

/** 统一的业务错误响应（400） */
export function fail(reply: FastifyReply, message: string) {
  return badRequest(reply, message)
}
