/**
 * 局域网同步：手机端（前端）WebSocket 客户端。
 *
 * 连接电脑端本地服务（P1 的 axum 服务），约定协议：
 * - 收到 `{ type: "event", event, payload }`：把后端事件重新派发为本地 Tauri 事件，
 *   复用 `tauri.ts::initTauri` 已有的监听（统一事件源，避免逻辑分叉）。
 * - 收到 `{ type: "snapshot", payload }`：payload 为 Snapshot JSON 字符串（settings + Persisted），
 *   调用后端 `applySnapshot` 写盘 + 载入内存 + 重启 watcher，再刷新前端 store。
 * 连接后先发 `{ type: "pull" }` 拉全量快照，之后持续收增量事件。
 *
 * 连接配置持久化到 localStorage，启动自动重连（指数退避），重连失败仅轻量提示不阻塞。
 */
import { emit } from '@tauri-apps/api/event'
import { useStore } from './store'
import {
  applySnapshot,
  getPlayerQuests,
  getUnlocked,
  getCollectedItems,
  getSettings,
} from './tauri'

export interface ParsedConnect {
  hosts: string[]
  port: number
  token: string
}

const STORE_KEY = 'ic-tarkov.lanConnect.v1'

export type LanConnStatus = 'disconnected' | 'connecting' | 'connected'

let ws: WebSocket | null = null
let status: LanConnStatus = 'disconnected'
let autoConnect = false
let current: ParsedConnect | null = null
let retryTimer: ReturnType<typeof setTimeout> | undefined
let retries = 0
let hbTimer: ReturnType<typeof setInterval> | undefined
const statusListeners = new Set<(s: LanConnStatus) => void>()

// 应用层心跳：防止局域网 AP/NAT 空闲超时踢掉 WS（服务端忽略未知 type，仅保活）
function startHeartbeat(sock: WebSocket): void {
  stopHeartbeat()
  hbTimer = setInterval(() => {
    try {
      sock.send(JSON.stringify({ type: 'ping' }))
    } catch {
      /* ignore */
    }
  }, 25000)
}
function stopHeartbeat(): void {
  if (hbTimer) {
    clearInterval(hbTimer)
    hbTimer = undefined
  }
}

export function getLanConnStatus(): LanConnStatus {
  return status
}

export function onLanStatus(cb: (s: LanConnStatus) => void): () => void {
  statusListeners.add(cb)
  return () => {
    statusListeners.delete(cb)
  }
}

function setStatus(s: LanConnStatus): void {
  status = s
  statusListeners.forEach((c) => c(s))
}

export function getLanConnect(): ParsedConnect | null {
  return current
}

export function saveLanConnect(c: ParsedConnect): void {
  current = c
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(c))
  } catch {
    /* ignore */
  }
}

export function loadLanConnect(): ParsedConnect | null {
  try {
    const v = localStorage.getItem(STORE_KEY)
    if (v) {
      const p = JSON.parse(v) as ParsedConnect
      if (p && Array.isArray(p.hosts) && p.port && p.token) return p
    }
  } catch {
    /* ignore */
  }
  return null
}

export function clearLanConnect(): void {
  current = null
  try {
    localStorage.removeItem(STORE_KEY)
  } catch {
    /* ignore */
  }
}

/** 解析 `ictarkov://connect?hosts=1.2.3.4,5.6.7.8&port=9527&token=xxx` 深链 */
export function parseConnectUrl(raw: string): ParsedConnect | null {
  const s = raw.trim()
  if (!s) return null
  const m = s.match(/^ictarkov:\/\/connect\??(.*)$/i)
  if (!m) return null
  const q = new URLSearchParams(m[1])
  const hosts = (q.get('hosts') || '')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean)
  const port = Number(q.get('port') || '')
  const token = q.get('token') || ''
  if (hosts.length && port > 0 && token) return { hosts, port, token }
  return null
}

/** 已连接时向电脑端发送反向同步指令（未连接则静默丢弃） */
export function sendLanMsg(msg: Record<string, unknown>): void {
  if (ws && status === 'connected') {
    try {
      ws.send(JSON.stringify(msg))
    } catch {
      /* ignore */
    }
  }
}

export function disconnectLan(): void {
  if (retryTimer) {
    clearTimeout(retryTimer)
    retryTimer = undefined
  }
  stopHeartbeat()
  retries = 0
  autoConnect = false
  if (ws) {
    ws.onclose = null
    try {
      ws.close()
    } catch {
      /* ignore */
    }
    ws = null
  }
  setStatus('disconnected')
}

function tryConnectOne(host: string, port: number, token: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const url = `ws://${host}:${port}/ws?token=${encodeURIComponent(token)}`
    let sock: WebSocket
    try {
      sock = new WebSocket(url)
    } catch (e) {
      reject(e)
      return
    }
    const to = setTimeout(() => {
      sock.onerror = null
      try {
        sock.close()
      } catch {
        /* ignore */
      }
      reject(new Error('timeout'))
    }, 4000)
    sock.onopen = () => {
      clearTimeout(to)
      resolve(sock)
    }
    sock.onerror = () => {
      clearTimeout(to)
      reject(new Error('error'))
    }
  })
}

export async function connectLan(c: ParsedConnect, opts?: { auto?: boolean }): Promise<void> {
  if (opts?.auto) autoConnect = true
  saveLanConnect(c)
  setStatus('connecting')
  let sock: WebSocket | null = null
  for (const host of c.hosts) {
    try {
      sock = await tryConnectOne(host, c.port, c.token)
      break
    } catch {
      /* 尝试下一个 host */
    }
  }
  if (!sock) {
    setStatus('disconnected')
    if (autoConnect) scheduleRetry(c)
    else useStore.getState().pushToast('无法连接电脑端', 'info')
    return
  }
  ws = sock
  retries = 0
  setStatus('connected')
  startHeartbeat(sock)
  useStore.getState().pushToast('已连接到电脑端', 'done')
  sock.onmessage = (ev) => {
    void handleMessage(typeof ev.data === 'string' ? ev.data : '')
  }
  sock.onerror = () => {
    /* 由 onclose 统一处理 */
  }
  sock.onclose = () => {
    if (ws === sock) {
      ws = null
      stopHeartbeat()
      setStatus('disconnected')
      if (autoConnect) scheduleRetry(c)
    }
  }
  // 连上即拉全量快照（首帧数据）
  try {
    sock.send(JSON.stringify({ type: 'pull' }))
  } catch {
    /* ignore */
  }
}

function scheduleRetry(c: ParsedConnect): void {
  // 无限重连（指数退避，封顶 30s）：局域网同步应持续自动恢复
  retries += 1
  const delay = Math.min(30000, 2000 * 2 ** (retries - 1))
  if (retries === 1) {
    useStore.getState().pushToast('与电脑端连接断开，正在自动重连…', 'info')
  }
  retryTimer = setTimeout(() => {
    void connectLan(c, { auto: true })
  }, delay)
}

interface WsMsg {
  type?: string
  event?: string
  payload?: unknown
}

async function handleMessage(data: string): Promise<void> {
  if (!data) return
  let msg: WsMsg
  try {
    msg = JSON.parse(data)
  } catch {
    return
  }
  if (msg.type === 'event') {
    const ev = msg.event
    if (!ev) return
    let payload: unknown = msg.payload
    if (typeof msg.payload === 'string') {
      try {
        payload = JSON.parse(msg.payload)
      } catch {
        /* 保留原始字符串 */
      }
    }
    try {
      // 统一事件源：重新派发为本地 Tauri 事件，复用 initTauri 已有监听
      emit(ev, payload)
    } catch {
      /* ignore */
    }
  } else if (msg.type === 'snapshot') {
    const json = typeof msg.payload === 'string' ? msg.payload : JSON.stringify(msg.payload)
    try {
      await applySnapshot(json)
      await reloadLocalData()
      useStore.getState().pushToast('已同步电脑端数据', 'done')
    } catch (e) {
      useStore.getState().pushToast('快照应用失败：' + String(e), 'info')
    }
  }
}

/** 从后端重载用户数据到 store（快照应用后调用；lan-sync-updated 也会触发） */
export async function reloadLocalData(): Promise<void> {
  const { seedPlayerQuests, setUnlockedQuests, setCollectedItems, setSettings, applyUiPrefs } =
    useStore.getState()
  try {
    const [quests, unlocked, collected, settings] = await Promise.all([
      getPlayerQuests(),
      getUnlocked(),
      getCollectedItems(),
      getSettings(),
    ])
    seedPlayerQuests(quests)
    setUnlockedQuests(unlocked)
    setCollectedItems(collected)
    setSettings(settings)
    if (settings.uiPrefs && Object.keys(settings.uiPrefs).length > 0) applyUiPrefs(settings.uiPrefs)
  } catch {
    /* ignore */
  }
}

/** 启动自动重连已保存的电脑端连接（无配置则静默） */
export function startLanAutoConnect(): void {
  const saved = loadLanConnect()
  if (saved) void connectLan(saved, { auto: true })
}

/** 粗略判断当前是否移动端（实现在 platform.ts，此处转发保持兼容） */
export { isMobile } from './platform'
