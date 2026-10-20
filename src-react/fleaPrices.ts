/**
 * 跳蚤市场实时价格（json.tarkov.dev 的单件物品价格历史端点）。
 *
 * 为什么不用 GraphQL：tarkov.dev 的 GraphQL 已不再维护（本项目从创建起就只用
 * json.tarkov.dev 的静态端点）。价格历史端点是官方仍在维护的数据：
 *
 *   GET https://json.tarkov.dev/regular/prices/{itemId}
 *   -> { data: [{ price, priceMin, timestamp }, ...] }   // 按时间升序，约每 2 小时一个点
 *
 * 取最后一个数据点即「最新一次刷新的跳蚤价格」（price 为该次刷新的均价，
 * priceMin 为该次刷新的最低价）。单件物品 gzip 后约 20KB，因此只查界面要用到的
 * 物品，不拉 17MB 的 items 全量。
 *
 * 设计要点：
 * - 并发上限 CONCURRENCY，避免一次选重物品时几十个请求同时打过去
 * - 内存缓存 TTL 10 分钟：切换物品来回看不会重复请求；点「刷新价格」可强制重查
 * - 单个物品失败不影响其它物品：成功的进 prices，失败的 id 进 failed
 * - 全部失败（断网 / Cloudflare 拦截）由调用方退回数据集里的同步价并提示
 */

const BASE = 'https://json.tarkov.dev'
/** 单件物品请求超时（毫秒） */
const TIMEOUT = 10_000
/** 单个物品最多并发请求数 */
const CONCURRENCY = 6
/** 内存缓存有效期（毫秒） */
const TTL = 10 * 60 * 1000

/** 单件物品的实时价格 */
export interface FleaPriceInfo {
  /** 最新数据点的均价（₽） */
  price: number | null
  /** 最新数据点的最低价（₽） */
  min: number | null
  /** 数据点时间（毫秒时间戳） */
  at: number
  /** 本次拉取时间（毫秒时间戳） */
  fetchedAt: number
}

export interface PriceFetchResult {
  /** id -> 价格（只含成功的） */
  prices: Map<string, FleaPriceInfo>
  /** 拉取失败的 id */
  failed: string[]
}

interface HistoryPoint {
  price?: number | null
  priceMin?: number | null
  timestamp?: number | null
}

const cache = new Map<string, FleaPriceInfo>()

function positive(v: unknown): number | null {
  return typeof v === 'number' && v > 0 ? Math.round(v) : null
}

async function fetchOne(id: string): Promise<FleaPriceInfo> {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), TIMEOUT)
  try {
    const res = await fetch(`${BASE}/regular/prices/${encodeURIComponent(id)}`, {
      signal: ac.signal,
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const json = (await res.json()) as { data?: HistoryPoint[] | null }
    const points = Array.isArray(json.data) ? json.data : []
    if (points.length === 0) throw new Error('没有价格数据')
    // 上游按时间升序，这里仍取 timestamp 最大的那个，避免顺序变化时取错
    let last = points[points.length - 1]
    for (const p of points) {
      if ((p.timestamp ?? 0) > (last.timestamp ?? 0)) last = p
    }
    const info: FleaPriceInfo = {
      price: positive(last.price),
      min: positive(last.priceMin),
      at: last.timestamp ?? Date.now(),
      fetchedAt: Date.now(),
    }
    cache.set(id, info)
    return info
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 批量查询跳蚤实时价格。
 * @param ids 物品 id（自动去重）
 * @param force true = 忽略 10 分钟缓存强制重查（点「刷新价格」时用）
 */
export async function fetchFleaPrices(ids: string[], force = false): Promise<PriceFetchResult> {
  const unique = [...new Set(ids.filter(Boolean))]
  const prices = new Map<string, FleaPriceInfo>()
  const failed: string[] = []
  const pending: string[] = []

  for (const id of unique) {
    const hit = cache.get(id)
    if (!force && hit && Date.now() - hit.fetchedAt < TTL) prices.set(id, hit)
    else pending.push(id)
  }

  let cursor = 0
  const worker = async () => {
    while (cursor < pending.length) {
      const id = pending[cursor]
      cursor += 1
      try {
        prices.set(id, await fetchOne(id))
      } catch {
        failed.push(id)
        // 失败时清掉旧缓存，避免下次误用过期值（旧值仍在 prices 里则以新结果为准）
        cache.delete(id)
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, pending.length) }, worker))
  return { prices, failed }
}
