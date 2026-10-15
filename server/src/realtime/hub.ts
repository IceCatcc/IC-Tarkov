import type { WebSocket } from 'ws'

/**
 * 实时事件中心：按用户分组推送。
 * 对应桌面端 Tauri 的 `app.emit(...)` —— 事件名与载荷保持一致，
 * 前端只需把 `listen(name, cb)` 换成 WebSocket 的按 name 回调。
 */
class Hub {
  private readonly clients = new Map<number, Set<WebSocket>>()

  add(userId: number, socket: WebSocket): void {
    let set = this.clients.get(userId)
    if (!set) {
      set = new Set()
      this.clients.set(userId, set)
    }
    set.add(socket)
    socket.on('close', () => this.remove(userId, socket))
    socket.on('error', () => this.remove(userId, socket))
  }

  remove(userId: number, socket: WebSocket): void {
    const set = this.clients.get(userId)
    if (!set) return
    set.delete(socket)
    if (set.size === 0) this.clients.delete(userId)
  }

  /** 向某用户的所有在线连接推送一个事件 */
  emit(userId: number, type: string, payload: unknown): void {
    const set = this.clients.get(userId)
    if (!set || set.size === 0) return
    const frame = JSON.stringify({ type, payload })
    for (const socket of set) {
      // 1 = OPEN
      if (socket.readyState === 1) {
        try {
          socket.send(frame)
        } catch {
          this.remove(userId, socket)
        }
      }
    }
  }

  connectionCount(userId: number): number {
    return this.clients.get(userId)?.size ?? 0
  }
}

export const hub = new Hub()
