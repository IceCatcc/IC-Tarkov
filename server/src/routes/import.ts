/**
 * 数据导入：把桌面端已有的本地数据（导出包 zip 或单个 JSON）迁到当前账号。
 *
 * 请求：multipart/form-data
 *   - file  一个或多个文件（zip / quest_state.*.json / collected.*.json / settings.json）
 *   - mode  可选，`replace`（默认，覆盖）或 `merge`（补充）
 *
 * 响应：逐模式的导入统计 + 解析告警，供前端回显。
 */
import type { FastifyInstance } from 'fastify'
import { currentUser } from '../auth/session.js'
import { extractFiles, extractSingleFile, isKnownFile, type ParsedFile } from '../import/parse.js'
import { accountSummary, importForUser } from '../repo/importData.js'
import { hub } from '../realtime/hub.js'
import { badRequest } from './helpers.js'

/** 单个上传文件的大小上限（导出包通常几百 KB，17MB 的原始数据不在此接口） */
const MAX_FILE_BYTES = 32 * 1024 * 1024

export function registerImportRoutes(app: FastifyInstance): void {
  /** 账号数据概览：登录后据此判断是否需要引导导入 */
  app.get('/api/account/summary', async (req) => accountSummary(currentUser(req).id))

  app.post('/api/import', async (req, reply) => {
    const me = currentUser(req)
    if (!req.isMultipart()) {
      return badRequest(reply, '请以 multipart/form-data 上传数据文件')
    }

    let replace = true
    const files: ParsedFile[] = []

    try {
      for await (const part of req.parts()) {
        if (part.type === 'file') {
          const buf = await part.toBuffer()
          if (buf.length === 0) continue
          if (buf.length > MAX_FILE_BYTES) {
            return badRequest(reply, `文件过大：${part.filename ?? ''}（上限 32MB）`)
          }
          const bytes = new Uint8Array(buf)
          if (bytes[0] === 0x50 && bytes[1] === 0x4b) {
            // zip：包内文件名决定归属
            files.push(...extractFiles(bytes))
          } else {
            // 单个 JSON：文件名可识别就按文件名，否则交给内容猜测
            const name = part.filename ?? ''
            const text = buf.toString('utf8')
            files.push(...(isKnownFile(name) ? extractSingleFile(name, text) : extractSingleFile('', text)))
          }
        } else if (part.fieldname === 'mode') {
          replace = String(part.value) !== 'merge'
        }
      }
    } catch (e) {
      return badRequest(reply, `读取上传内容失败：${e instanceof Error ? e.message : String(e)}`)
    }

    if (files.length === 0) return badRequest(reply, '没有收到任何数据文件')

    let outcome
    try {
      outcome = await importForUser(me.id, files, { replace })
    } catch (e) {
      return badRequest(reply, e instanceof Error ? e.message : String(e))
    }

    // 同一账号的其它设备需要整批刷新
    hub.emit(me.id, 'data-imported', { replace, modes: outcome.modes })
    hub.emit(me.id, 'quests-changed', {})

    return outcome
  })
}
