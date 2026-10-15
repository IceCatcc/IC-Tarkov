/**
 * WebSocket 实时通道，替代桌面端 Tauri 的事件系统。
 *
 * 客户端与服务端之间的帧格式：
 *   服务端 → 客户端：{ "type": "<事件名>", "payload": <任意> }
 * 事件名与桌面端 app.emit 的名字保持一致（quest-event / collected-changed /
 * objective-changed / map-changed / session-mode / watcher-state / data-reloaded），
 * 前端只需把 listen(name, cb) 换成 WS 的按 name 分发。
 *
 * 客户端 → 服务端：目前只有心跳 { "type": "ping" }（用于保活与探测连接）。
 */
import type { FastifyInstance } from 'fastify'
import { resolveUser } from '../auth/session.js'
import { hub } from '../realtime/hub.js'

export function registerWsRoutes(app: FastifyInstance): void {
  app.get('/api/ws', { websocket: true }, async (socket, req) => {
    // 走与 HTTP 相同的 Cookie 会话鉴权
    const user = await resolveUser(req)
    if (!user) {
      socket.close(4401, 'unauthorized')
      return
    }
    hub.add(user.id, socket)
    socket.send(JSON.stringify({ type: 'hello', payload: { userId: user.id } }))

    socket.on('message', (raw: Buffer) => {
      try {
        const msg = JSON.parse(raw.toString()) as { type?: string }
        if (msg.type === 'ping') {
          socket.send(JSON.stringify({ type: 'pong', payload: Date.now() }))
        }
      } catch {
        /* 非 JSON 帧直接忽略 */
      }
    })
  })
}
