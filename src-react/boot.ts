/**
 * 启动步骤提示（「读取中 xx」）。
 *
 * 资料读取已与界面进程分离、跑在后端线程里，这里把两边的步骤汇总成一条时间线：
 * - 后端：经 `startup-step` 事件与 `get_startup_state` 命令上报
 *   （读取任务进度 / 读取游戏数据 / 检查数据更新）
 * - 前端：初始化链的每一步自行上报（读取界面设置 / 扫描日志 / 加载任务列表）
 *
 * 后端步骤全部完成后 `bootReady()` 才 resolve，前端据此再调用依赖数据集的命令；
 * 前端初始化链跑完调用 `finishBoot()` 收起遮罩。
 */
import { listen } from '@tauri-apps/api/event'
import { getStartupState, type StartupState } from './tauri'

export interface BootStep {
  /** 步骤键：同一键原地更新文案（不新增行） */
  step: string
  label: string
}

export interface BootSnapshot {
  steps: BootStep[]
  /** 前端初始化链已全部完成（遮罩可以收起） */
  finished: boolean
  /** 后端资料读取失败信息（失败也会放行，只是数据为空） */
  error: string | null
}

/** 兜底轮询间隔：事件负责实时文案，轮询负责兜住漏事件与后端异常 */
const POLL_MS = 250
/** 后端迟迟不上报完成时的兜底放行时长，避免界面被遮罩永久挡住 */
const READY_TIMEOUT_MS = 120_000

let snapshot: BootSnapshot = { steps: [], finished: false, error: null }
const listeners = new Set<() => void>()
let readyPromise: Promise<void> | null = null
let settleReady: (() => void) | null = null

/** 广播：换成全新的快照对象（React 依据引用变化重渲染），再通知订阅者 */
function notify(): void {
  snapshot = { ...snapshot, steps: snapshot.steps.map((s) => ({ ...s })) }
  listeners.forEach((fn) => fn())
}

/** 写入一个后端步骤（同一步骤键内只更新文案） */
function applyBackendStep(p: StartupState): void {
  let changed = false
  if (p.error && p.error !== snapshot.error) {
    snapshot.error = p.error
    changed = true
  }
  if (p.step && p.label) {
    const last = snapshot.steps[snapshot.steps.length - 1]
    if (last && last.step === p.step) {
      if (last.label !== p.label) {
        last.label = p.label
        changed = true
      }
    } else {
      snapshot.steps.push({ step: p.step, label: p.label })
      changed = true
    }
  }
  if (changed) notify()
  if (p.done) settleReady?.()
}

/** 前端自己的启动步骤（与后端步骤共用同一条时间线） */
export function reportStep(step: string, label: string): void {
  const last = snapshot.steps[snapshot.steps.length - 1]
  if (last && last.step === step) {
    if (last.label === label) return
    last.label = label
  } else {
    snapshot.steps.push({ step, label })
  }
  notify()
}

/** 前端初始化链结束：收起启动遮罩 */
export function finishBoot(): void {
  if (snapshot.finished) return
  snapshot.finished = true
  notify()
}

export function bootSnapshot(): BootSnapshot {
  return snapshot
}

export function subscribeBoot(fn: () => void): () => void {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}

/**
 * 等待后端资料读取完成（成功/失败都算完成）。
 * 只应调用一次逻辑入口；重复调用复用同一个 Promise。
 */
export function bootReady(): Promise<void> {
  if (readyPromise) return readyPromise
  readyPromise = new Promise<void>((resolve) => {
    settleReady = resolve
    const deadline = Date.now() + READY_TIMEOUT_MS
    // 先挂监听再查询状态，避免「查询返回未完成 → 监听注册完成」之间漏掉完成事件
    void listen<StartupState>('startup-step', (e) => applyBackendStep(e.payload)).catch(() => {})
    const tick = async (): Promise<void> => {
      try {
        const st = await getStartupState()
        applyBackendStep(st)
        if (st.done) return
      } catch {
        // 后端没有该命令或调用失败：不再阻塞界面
        settleReady?.()
        return
      }
      if (Date.now() > deadline) {
        settleReady?.()
        return
      }
      window.setTimeout(() => void tick(), POLL_MS)
    }
    void tick()
  })
  return readyPromise
}
