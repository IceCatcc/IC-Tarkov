/**
 * BTR 路线跟踪：路线 / 到站时序数据与位置推算。
 *
 * 数据来源见 public/data/btr-routes.json（路线与时序参考 eftarkov.com 的 BTR 追踪，
 * 社区实测值；坐标已按 tarkov.dev 底图校准成游戏坐标）。
 *
 * 时间轴统一用「战局剩余秒数」（raid 结束为 0，倒数）：
 * - route.spawnTime：BTR 出现的剩余秒数（部署后开始沿路线跑）
 * - schedule[].arrivalTime / departureTime：到站 / 发车的剩余秒数（递减）
 * 这与参考站一致，便于用户「跳转到某个时间点」。
 */

export interface BtrStop {
  nameZh: string
  x: number
  z: number
}

export interface BtrScheduleEntry {
  stopId: string
  pathIndex: number
  arrivalTime: number
  departureTime: number
}

export interface BtrRoute {
  id: string
  nameZh: string
  group: string
  spawnTime: number
  /** 路线轨迹（游戏坐标 [x, z] 点列，首尾相接循环） */
  path: [number, number][]
  schedule: BtrScheduleEntry[]
}

export interface BtrMapData {
  nameZh: string
  /** 战局时长（秒） */
  raidDuration: number
  /** BTR 出现概率（百分比） */
  spawnChance: number
  /** 每站停留时长（秒）；数据缺失时为 null（以 schedule 为准） */
  stopDuration: number | null
  groups: { key: string; nameZh: string }[]
  stops: Record<string, BtrStop>
  routes: BtrRoute[]
}

export interface BtrDoc {
  version: number
  source: string
  maps: Record<string, BtrMapData>
}

/** 地图 normalizedName -> BTR 数据 key（仅这三张图有 BTR 路线） */
const BTR_MAP_KEYS: Record<string, string> = {
  woods: 'woods',
  'streets-of-tarkov': 'streets',
  lighthouse: 'lighthouse',
}

export function btrKeyOf(normalizedName: string | null | undefined): string | null {
  if (!normalizedName) return null
  return BTR_MAP_KEYS[normalizedName] ?? null
}

/** 路线配色（与参考站一致），按路线在数据中的下标取色 */
export const BTR_ROUTE_COLORS = ['#2563eb', '#16a34a', '#d97706', '#9333ea', '#0891b2']

export function btrColor(index: number): string {
  return BTR_ROUTE_COLORS[((index % BTR_ROUTE_COLORS.length) + BTR_ROUTE_COLORS.length) % BTR_ROUTE_COLORS.length]
}

let cache: BtrDoc | null = null
let pending: Promise<BtrDoc | null> | null = null

/** 读取 BTR 路线数据（一次加载后缓存；失败静默返回 null，不影响地图其他功能） */
export function loadBtrRoutes(): Promise<BtrDoc | null> {
  if (cache) return Promise.resolve(cache)
  if (pending) return pending
  pending = fetch('/data/btr-routes.json')
    .then((r) => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      return r.json() as Promise<BtrDoc>
    })
    .then((doc) => {
      cache = doc
      return doc
    })
    .catch(() => null)
    .finally(() => {
      pending = null
    })
  return pending
}

/* ---------------- 位置推算 ---------------- */

export interface BtrSnapshot {
  kind: 'waiting' | 'stop' | 'travel' | 'finished'
  /** 当前位置（waiting 时为 null） */
  x: number | null
  z: number | null
  /** 停站时的站点 id */
  stopId: string | null
  /** 下一站 id / 中文名 */
  nextStopId: string | null
  nextStopName: string
  /** 等待生成 / 到下一站 / 离开本站的剩余秒数（finished 为 null） */
  eta: number | null
}

interface VItem {
  stopId: string
  idx: number
  v: number
  arrival: number
  departure: number
}

interface VSchedule {
  items: VItem[]
  loopStart: number
}

// 虚拟索引缓存：跨圈时用 cycle*path.length+idx 表示（与参考站一致）
const vcache = new WeakMap<BtrRoute, VSchedule>()

function virtualSchedule(route: BtrRoute): VSchedule {
  const hit = vcache.get(route)
  if (hit) return hit
  const n = route.path.length
  let prev = -1
  let cycle = 0
  const items: VItem[] = []
  for (const s of route.schedule) {
    const idx = s.pathIndex
    if (prev >= 0 && idx >= 0 && idx <= prev) cycle++
    const v = idx < 0 ? -1 : cycle * n + idx
    items.push({
      stopId: s.stopId,
      idx,
      v,
      arrival: s.arrivalTime,
      departure: s.departureTime,
    })
    prev = idx
  }
  const loopStart = items.length && items[0].idx >= 0 ? items[0].idx : 0
  const out = { items, loopStart }
  vcache.set(route, out)
  return out
}

const clamp01 = (v: number) => Math.max(0, Math.min(1, v))

/** 沿 path 的 a..b 段按长度比例插值 */
function interpPath(
  path: [number, number][],
  a: number,
  b: number,
  progress: number,
): { x: number; z: number } | null {
  if (!path.length) return null
  a = Math.max(0, Math.min(path.length - 1, a | 0))
  b = Math.max(a, Math.min(path.length - 1, b | 0))
  const p = clamp01(progress)
  if (a === b) {
    const q = path[a]
    return { x: q[0], z: q[1] }
  }
  let total = 0
  const lens: number[] = []
  for (let i = a + 1; i <= b; i++) {
    const d = Math.hypot(path[i][0] - path[i - 1][0], path[i][1] - path[i - 1][1])
    lens.push(d)
    total += d
  }
  let target = total * p
  let run = 0
  for (let i = a + 1; i <= b; i++) {
    const d = lens[i - a - 1]
    if (run + d >= target) {
      const q = d ? (target - run) / d : 0
      return {
        x: path[i - 1][0] + (path[i][0] - path[i - 1][0]) * q,
        z: path[i - 1][1] + (path[i][1] - path[i - 1][1]) * q,
      }
    }
    run += d
  }
  const last = path[b]
  return { x: last[0], z: last[1] }
}

/**
 * 虚拟索引插值：aVirtual -> bVirtual 可能跨圈。
 * 跨圈时从 aIdx 走到线路末端，再跳到 loopStart（接缝长度 0），继续走到 bIdx；
 * 整圈的部分按 loopStart..末端 累加，与参考站一致。
 */
function interpVirtual(
  path: [number, number][],
  aVirtual: number,
  bVirtual: number,
  progress: number,
  loopStartIndex: number,
): { x: number; z: number } | null {
  if (!path.length || aVirtual < 0 || bVirtual < 0) return null
  const p = clamp01(progress)
  const n = path.length
  const aCycle = Math.floor(aVirtual / n)
  const bCycle = Math.floor(bVirtual / n)
  const aIdx = ((aVirtual % n) + n) % n
  const bIdx = ((bVirtual % n) + n) % n
  const loopStart = Math.max(0, Math.min(n - 1, loopStartIndex | 0))
  if (aCycle === bCycle) return interpPath(path, aIdx, bIdx, p)

  // 收集段：{from,to} 或 jump
  const segs: { from: number; to: number }[] = []
  const addRange = (from: number, to: number) => {
    from = Math.max(0, Math.min(n - 1, from | 0))
    to = Math.max(0, Math.min(n - 1, to | 0))
    for (let i = from + 1; i <= to; i++) segs.push({ from: i - 1, to: i })
  }
  addRange(aIdx, n - 1)
  for (let c = aCycle + 1; c < bCycle; c++) addRange(loopStart, n - 1)
  addRange(loopStart, bIdx)

  const lens = segs.map((s) => Math.hypot(path[s.to][0] - path[s.from][0], path[s.to][1] - path[s.from][1]))
  const total = lens.reduce((a, b) => a + b, 0)
  if (total <= 0) {
    const q = path[bIdx]
    return { x: q[0], z: q[1] }
  }
  let target = total * p
  let run = 0
  for (let i = 0; i < segs.length; i++) {
    const d = lens[i]
    if (run + d >= target) {
      const q = d ? (target - run) / d : 0
      const a = path[segs[i].from]
      const b = path[segs[i].to]
      return { x: a[0] + (b[0] - a[0]) * q, z: a[1] + (b[1] - a[1]) * q }
    }
    run += d
  }
  const q = path[bIdx]
  return { x: q[0], z: q[1] }
}

/**
 * 某条路线在「战局剩余 remain 秒」时的 BTR 状态与**推算坐标**。
 * remain 越大越早（战局刚开始），与游戏内倒计时一致。
 *
 * 注意：坐标只是按「路径点索引 + 停留时长」线性插值出来的估算，本地/在线战局、
 * 实际车速与地图底图的差异都会让它明显偏离（灯塔图会直接画到山体上）。
 * **地图已不再绘制它**，界面改用 `btrLeg` 的检查点列表；这里保留推算逻辑，
 * 供以后拿到准确的路径采样数据时复用。
 */
export function btrSnapshot(map: BtrMapData, route: BtrRoute, remain: number): BtrSnapshot {
  const { items, loopStart } = virtualSchedule(route)
  const usable = items.filter((s) => s.idx >= 0)
  const stops = map.stops
  const stopName = (id: string | null): string => {
    if (!id) return ''
    return stops[id]?.nameZh ?? id
  }
  if (!route.path.length || !usable.length) {
    return { kind: 'finished', x: null, z: null, stopId: null, nextStopId: null, nextStopName: '', eta: null }
  }
  // 还没生成：BTR 部署时间点在战局剩余 spawnTime 秒
  if (remain > route.spawnTime) {
    const first = usable[0]
    return {
      kind: 'waiting',
      x: null,
      z: null,
      stopId: null,
      nextStopId: first.stopId,
      nextStopName: stopName(first.stopId),
      eta: remain - route.spawnTime,
    }
  }
  const first = usable[0]
  // 从部署点开到首站
  if (remain > first.arrival) {
    const total = route.spawnTime - first.arrival
    const done = route.spawnTime - remain
    const progress = total > 0 ? done / total : 1
    const pos = interpVirtual(route.path, 0, first.v, progress, 0)
    return {
      kind: 'travel',
      x: pos?.x ?? null,
      z: pos?.z ?? null,
      stopId: null,
      nextStopId: first.stopId,
      nextStopName: stopName(first.stopId),
      eta: remain - first.arrival,
    }
  }
  for (let i = 0; i < usable.length; i++) {
    const cur = usable[i]
    // 停站中：arrival >= remain > departure
    if (remain <= cur.arrival && remain > cur.departure) {
      const st = stops[cur.stopId]
      return {
        kind: 'stop',
        x: st?.x ?? null,
        z: st?.z ?? null,
        stopId: cur.stopId,
        nextStopId: usable[i + 1]?.stopId ?? null,
        nextStopName: stopName(usable[i + 1]?.stopId ?? null),
        eta: remain - cur.departure,
      }
    }
    const next = usable[i + 1]
    if (next && remain <= cur.departure && remain > next.arrival) {
      const total = cur.departure - next.arrival
      const done = cur.departure - remain
      const progress = total > 0 ? done / total : 1
      const pos = interpVirtual(route.path, cur.v, next.v, progress, loopStart)
      return {
        kind: 'travel',
        x: pos?.x ?? null,
        z: pos?.z ?? null,
        stopId: null,
        nextStopId: next.stopId,
        nextStopName: stopName(next.stopId),
        eta: remain - next.arrival,
      }
    }
  }
  const last = usable[usable.length - 1]
  const st = stops[last.stopId]
  return {
    kind: 'finished',
    x: st?.x ?? null,
    z: st?.z ?? null,
    stopId: last.stopId,
    nextStopId: null,
    nextStopName: '',
    eta: null,
  }
}

/**
 * 某条路线在「战局剩余 remain 秒」时的**检查点进度**（不含坐标）。
 *
 * 面板列表用它，而不是 `btrSnapshot` 的实时坐标：日志/时序只能推算「大概跑到哪一段」，
 * 精确到米的位置容易画到山体或地图外（尤其灯塔图），列表里说清「现在停在哪 / 正在去哪，
 * 多久发车或到站，下一站是什么」对玩家更有用，也不会因为坐标偏差而误导。
 */
export interface BtrLeg {
  /** waiting（还没出现）/ stop（停靠中）/ travel（在途）/ finished（本局跑完） */
  kind: BtrSnapshot['kind']
  /** 上/当前检查点 id（waiting 时为空） */
  fromStopId: string | null
  /** 下一个检查点 id（跑完时为空） */
  toStopId: string | null
  toName: string
  /** 再下一个检查点名称（用于「再下一个」提示） */
  afterName: string
  /**
   * 倒计时含义随 kind 变化：
   * waiting = 距出现；travel = 距到站；stop = 距发车；finished = null
   */
  eta: number | null
}

export function btrLeg(map: BtrMapData, route: BtrRoute, remain: number): BtrLeg {
  const { items } = virtualSchedule(route)
  const usable = items.filter((s) => s.idx >= 0)
  const nm = (id: string | null | undefined): string => (id ? map.stops[id]?.nameZh ?? id : '')
  const empty = (kind: BtrLeg['kind']): BtrLeg => ({
    kind,
    fromStopId: null,
    toStopId: null,
    toName: '',
    afterName: '',
    eta: null,
  })
  if (!route.path.length || !usable.length) return empty('finished')
  const [first, second] = usable
  // 还没出现：BTR 在战局剩余 spawnTime 秒时部署
  if (remain > route.spawnTime) {
    return {
      kind: 'waiting',
      fromStopId: null,
      toStopId: first.stopId,
      toName: nm(first.stopId),
      afterName: nm(second?.stopId),
      eta: remain - route.spawnTime,
    }
  }
  // 从部署点开去首站
  if (remain > first.arrival) {
    return {
      kind: 'travel',
      fromStopId: null,
      toStopId: first.stopId,
      toName: nm(first.stopId),
      afterName: nm(second?.stopId),
      eta: remain - first.arrival,
    }
  }
  for (let i = 0; i < usable.length; i++) {
    const cur = usable[i]
    const next = usable[i + 1]
    const after = usable[i + 2]
    // 停靠中：arrival >= remain > departure
    if (remain <= cur.arrival && remain > cur.departure) {
      return {
        kind: 'stop',
        fromStopId: cur.stopId,
        toStopId: next?.stopId ?? null,
        toName: nm(next?.stopId),
        afterName: nm(after?.stopId),
        eta: remain - cur.departure,
      }
    }
    if (next && remain <= cur.departure && remain > next.arrival) {
      return {
        kind: 'travel',
        fromStopId: cur.stopId,
        toStopId: next.stopId,
        toName: nm(next.stopId),
        afterName: nm(after?.stopId),
        eta: remain - next.arrival,
      }
    }
  }
  const last = usable[usable.length - 1]
  return {
    kind: 'finished',
    fromStopId: last.stopId,
    toStopId: null,
    toName: '',
    afterName: '',
    eta: null,
  }
}

/** 秒 -> mm:ss（负数夹到 0） */
export function fmtClock(sec: number): string {
  const v = Math.max(0, Math.round(sec))
  return `${String(Math.floor(v / 60)).padStart(2, '0')}:${String(v % 60).padStart(2, '0')}`
}
