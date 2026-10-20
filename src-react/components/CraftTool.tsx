import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { getCrafts, getDataStatus, refreshGameData } from '../tauri'
import { fetchFleaPrices, type FleaPriceInfo } from '../fleaPrices'
import type { CraftInfo, CraftItem, DataStatus } from '../types'

/** 搜索建议最多渲染的条数（其余继续输入缩小范围） */
const SUGGEST_LIMIT = 30
/** 初始「可制作物品」最多渲染的条数 */
const PRODUCT_LIMIT = 120

const MONEY_FMT = new Intl.NumberFormat('zh-CN')

/** 金额：跳蚤均价（₽）；无价格显示占位符 */
function money(v: number | null | undefined): string {
  if (v === null || v === undefined) return '—'
  return `${MONEY_FMT.format(Math.round(v))} ₽`
}

/** 制作时长：秒 -> 「1 小时 6 分」 */
function fmtDuration(sec: number): string {
  if (!sec || sec <= 0) return '—'
  const h = Math.floor(sec / 3600)
  const m = Math.round((sec % 3600) / 60)
  if (h > 0) return m > 0 ? `${h} 小时 ${m} 分` : `${h} 小时`
  return `${m} 分`
}

/** 上游未本地化的物品：中文名缺失时后端退化成 24 位 id，这里换成可读的占位名 */
function displayName(it: { id: string; name: string }): string {
  if (/^[0-9a-f]{24}$/i.test(it.name)) return `未知物品（${it.id.slice(0, 8)}…）`
  return it.name
}

/** 数据更新时间（epoch 秒） -> 「10-20 11:38」 */
function fmtTime(sec: number): string {
  const d = new Date(sec * 1000)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** 搜索候选物品（出现在任意配方里的物品，带「可制作 / 用作材料」计数） */
interface Candidate {
  id: string
  name: string
  category?: string | null
  /** 作为产物的配方数 */
  asProduct: number
  /** 作为材料的配方数 */
  asIngredient: number
}

/** 取某件物品的价格（实时价优先，实时接口不可用时退回数据集里的价格） */
type PriceResolver = (it: CraftItem) => number | null

/** 配方的经济性估算：材料成本 / 产物价值 / 利润 / 时薪 */
function economics(c: CraftInfo, priceOf: PriceResolver) {
  let cost = 0
  // 缺跳蚤价的消耗类材料数：>0 时成本不完整，不给出利润
  let missing = 0
  for (const it of c.required) {
    if (it.tool) continue
    const p = priceOf(it)
    if (p === null) {
      missing += 1
      continue
    }
    cost += p * Math.max(1, it.count)
  }
  const productPrice = priceOf(c.product)
  const value = productPrice === null ? null : productPrice * Math.max(1, c.product.count)
  const costKnown = missing === 0
  const profit = costKnown && value !== null ? value - cost : null
  const hourly = profit !== null && c.duration > 0 ? profit / (c.duration / 3600) : null
  return { cost: costKnown ? cost : null, value, profit, hourly, missing }
}

function ItemIcon({ id, size }: { id: string; size: number }) {
  return (
    <span
      className="shrink-0 grid place-items-center rounded bg-ink-900/60 overflow-hidden"
      style={{ width: size, height: size }}
    >
      <img
        src={`/item-icons/${id}.webp`}
        alt=""
        loading="lazy"
        onError={(e) => (e.currentTarget.style.display = 'none')}
        style={{ width: size, height: size }}
        className="object-contain"
      />
    </span>
  )
}

/** 材料行：图标 + 名称 + 数量×单价 + 小计（工具类不消耗，不计入成本） */
function MaterialRow({
  it,
  highlight,
  price,
}: {
  it: CraftItem
  highlight: boolean
  /** 当前使用的价格（实时价 / 数据集价） */
  price: number | null
}) {
  const subtotal = it.tool || price === null ? null : price * Math.max(1, it.count)
  return (
    <li
      className={`flex items-center gap-2.5 px-2 py-1.5 rounded ${
        highlight ? 'bg-amber/10' : ''
      }`}
    >
      <ItemIcon id={it.id} size={30} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5 min-w-0">
          <span className="text-[13px] text-[#e6edf3] truncate" title={it.name}>
            {displayName(it)}
          </span>
          {it.tool && (
            <span
              className="shrink-0 text-[10px] px-1 py-[1px] rounded border border-line text-muted/80"
              title="工具类材料：制作时不消耗"
            >
              工具
            </span>
          )}
          {it.quest && (
            <span
              className="shrink-0 text-[10px] px-1 py-[1px] rounded border border-amber/40 text-[#d4a174]"
              title="任务限定材料：需要先完成任务才能获得"
            >
              任务
            </span>
          )}
        </div>
        <div className="text-[11px] text-muted/70 tabular-nums">
          {it.count} 个
          {it.tool ? ' · 不消耗' : ` × ${money(price)}`}
        </div>
      </div>
      <div className="shrink-0 text-[13px] tabular-nums text-[#c9d1d9]">
        {it.tool ? '—' : money(subtotal)}
      </div>
    </li>
  )
}

/** 单条配方卡片 */
function RecipeCard({
  craft,
  highlightId,
  priceOf,
}: {
  craft: CraftInfo
  highlightId?: string
  priceOf: PriceResolver
}) {
  const eco = economics(craft, priceOf)
  const productPrice = priceOf(craft.product)
  return (
    <div className="rounded-lg border border-line bg-ink-800 overflow-hidden">
      {/* 头部：设施 + 等级 + 时长 + 利润 */}
      <div className="flex items-center gap-2 flex-wrap px-3 py-2 border-b border-line/70 bg-ink-900/40">
        <span className="text-[13px] text-[#e6edf3]">{craft.station}</span>
        <span className="text-[11px] px-1.5 py-[1px] rounded border border-line text-muted/80">
          Lv{craft.level}
        </span>
        <span className="text-[12px] text-muted/80">耗时 {fmtDuration(craft.duration)}</span>
        <span className="flex-1" />
        {eco.profit !== null ? (
          <span
            className={`text-[13px] font-medium tabular-nums ${
              eco.profit >= 0 ? 'text-ok' : 'text-red-400'
            }`}
            title="按材料与产物的跳蚤 24h 均价估算（不含手续费）"
          >
            利润 {eco.profit >= 0 ? '+' : ''}
            {money(eco.profit)}
          </span>
        ) : (
          <span className="text-[12px] text-muted/60" title="有材料没有跳蚤价，无法估算利润">
            利润 —
          </span>
        )}
      </div>

      {/* 左：产物；右：配方（材料 + 合计）。窄窗口自动改为上下排列 */}
      <div className="p-2 flex flex-col md:flex-row md:items-start gap-2">
        <div className="md:w-[38%] md:shrink-0 flex items-start gap-2.5 px-2 py-1.5">
          <ItemIcon id={craft.product.id} size={44} />
          <div className="min-w-0 flex-1">
            <div
              className="text-[13px] leading-snug text-[#e6edf3] break-words"
              title={craft.product.name}
            >
              {displayName(craft.product)}
            </div>
            <div className="mt-0.5 text-[11px] text-muted/70 tabular-nums">
              ×{craft.product.count} · 单价 {money(productPrice)}
            </div>
            <div className="mt-0.5 text-[12px] tabular-nums text-[#e6edf3]">
              产物价值 {money(eco.value)}
            </div>
          </div>
        </div>

        <div className="flex-1 min-w-0 md:border-l md:border-line/60 md:pl-2">
          <div className="px-2 pb-1 text-[11px] text-muted/60">配方</div>
          <ul>
            {craft.required.map((it, i) => (
              <MaterialRow
                key={`${it.id}-${i}`}
                it={it}
                highlight={it.id === highlightId}
                price={priceOf(it)}
              />
            ))}
            {craft.required.length === 0 && (
              <li className="px-2 py-1.5 text-[12px] text-muted/60">无材料</li>
            )}
          </ul>

          <div className="mt-1 px-2 pt-2 border-t border-line/60 flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px] text-muted">
            <span>
              材料成本 <span className="text-[#c9d1d9] tabular-nums">{money(eco.cost)}</span>
            </span>
            {eco.hourly !== null && (
              <span>
                时薪{' '}
                <span className="text-[#c9d1d9] tabular-nums">
                  {money(eco.hourly)}
                  /时
                </span>
              </span>
            )}
            {eco.missing > 0 && (
              <span className="text-amber/80">
                {eco.missing} 种材料无跳蚤价，成本未计入
              </span>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

/** 配方查询：按物品名查「怎么制作它」与「它参与了哪些配方」 */
export function CraftTool() {
  const [crafts, setCrafts] = useState<CraftInfo[]>([])
  const [status, setStatus] = useState<DataStatus | null>(null)
  const [loading, setLoading] = useState(true)
  // 实时价格：只查当前选中物品涉及的条目；失败时退回数据集里的价格
  const [live, setLive] = useState<Map<string, FleaPriceInfo> | null>(null)
  const [priceState, setPriceState] = useState<'idle' | 'loading' | 'ok' | 'error'>('idle')
  /** 未取到实时价的物品数（网络个别失败，用数据集价格补齐） */
  const [priceFailed, setPriceFailed] = useState(0)
  /** 代价数据点时间（上游最后一次刷新价格的时间） */
  const [priceAt, setPriceAt] = useState<Date | null>(null)
  // 递增即触发重新拉取实时价格；forceRef 决定这一轮是否跳过缓存
  const [priceTick, setPriceTick] = useState(0)
  const forceRef = useRef(false)
  // 实时接口不可用时，可用数据集更新兜底（较重，仅在提示里提供）
  const [dataBusy, setDataBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<{ id: string; name: string } | null>(null)

  const load = useCallback(async () => {
    const [cs, st] = await Promise.all([
      getCrafts(),
      // 数据状态只用于展示「价格更新于」，取不到不影响查询
      getDataStatus().catch(() => null),
    ])
    setCrafts(cs)
    setStatus(st)
  }, [])

  useEffect(() => {
    let alive = true
    setLoading(true)
    load()
      .catch((e) => {
        if (alive) setError(String(e))
      })
      .finally(() => {
        if (alive) setLoading(false)
      })
    return () => {
      alive = false
    }
  }, [load])

  // 候选物品 + 正反向索引
  const { candidates, byProduct, byIngredient } = useMemo(() => {
    const cand = new Map<string, Candidate>()
    const product = new Map<string, CraftInfo[]>()
    const ingredient = new Map<string, CraftInfo[]>()
    const touch = (it: CraftItem): Candidate => {
      let c = cand.get(it.id)
      if (!c) {
        c = { id: it.id, name: it.name, category: it.category, asProduct: 0, asIngredient: 0 }
        cand.set(it.id, c)
      }
      return c
    }
    for (const c of crafts) {
      const p = product.get(c.product.id) ?? []
      p.push(c)
      product.set(c.product.id, p)
      touch(c.product).asProduct += 1
      for (const it of c.required) {
        const arr = ingredient.get(it.id) ?? []
        arr.push(c)
        ingredient.set(it.id, arr)
        touch(it).asIngredient += 1
      }
    }
    return {
      candidates: [...cand.values()].sort((a, b) => a.name.localeCompare(b.name, 'zh-CN')),
      byProduct: product,
      byIngredient: ingredient,
    }
  }, [crafts])

  const trimmed = query.trim()
  const suggestions = useMemo(() => {
    if (!trimmed) return []
    const q = trimmed.toLowerCase()
    return candidates
      .filter((c) => c.name.toLowerCase().includes(q) || c.id.toLowerCase() === q)
      .slice(0, SUGGEST_LIMIT)
  }, [candidates, trimmed])

  const productCandidates = useMemo(
    () => candidates.filter((c) => c.asProduct > 0),
    [candidates],
  )
  const products = useMemo(
    () => productCandidates.slice(0, PRODUCT_LIMIT),
    [productCandidates],
  )

  const onSelect = (c: { id: string; name: string }) => {
    setSelected({ id: c.id, name: c.name })
    setQuery('')
  }

  const asProductRecipes = useMemo(
    () => (selected ? byProduct.get(selected.id) ?? [] : []),
    [selected, byProduct],
  )
  const asIngredientRecipes = useMemo(
    () => (selected ? byIngredient.get(selected.id) ?? [] : []),
    [selected, byIngredient],
  )

  // 当前选中物品涉及的物品 id（产物 + 全部材料），实时价格按这批 id 查询
  const priceIds = useMemo(() => {
    const set = new Set<string>()
    for (const c of [...asProductRecipes, ...asIngredientRecipes]) {
      set.add(c.product.id)
      for (const it of c.required) set.add(it.id)
    }
    return [...set]
  }, [asProductRecipes, asIngredientRecipes])

  // 选中物品变化 / 点「刷新价格」时拉取实时价格
  useEffect(() => {
    if (!selected || priceIds.length === 0) {
      setLive(null)
      setPriceState('idle')
      setPriceFailed(0)
      setPriceAt(null)
      return
    }
    let alive = true
    const force = forceRef.current
    forceRef.current = false
    setPriceState('loading')
    setPriceFailed(0)
    fetchFleaPrices(priceIds, force)
      .then(({ prices, failed }) => {
        if (!alive) return
        setLive(prices)
        setPriceFailed(failed.length)
        if (prices.size === 0) {
          // 全部失败：整块退回数据集同步价
          setPriceState('error')
          setPriceAt(null)
          return
        }
        setPriceState('ok')
        // 展示最新的数据点时间（上游约每 2 小时刷新一次）
        const latest = Math.max(...[...prices.values()].map((p) => p.at))
        setPriceAt(new Date(latest))
      })
      .catch(() => {
        // fetchFleaPrices 内部已逐项兜底，这里只处理意料之外的异常
        if (!alive) return
        setLive(null)
        setPriceState('error')
      })
    return () => {
      alive = false
    }
  }, [selected, priceIds, priceTick])

  /** 价格解析：实时价优先；某个物品没取到时退回数据集里的价格 */
  const priceOf = useCallback<PriceResolver>(
    (it) => {
      const p = live?.get(it.id)
      if (p) return p.price ?? p.min
      return it.price ?? null
    },
    [live],
  )

  /** 数据集更新（实时接口不可用时的兜底）：顺带刷新配方里的静态价格 */
  const onUpdateData = async () => {
    setDataBusy(true)
    setError(null)
    try {
      // 后端逐项带 ETag 比对 tarkov.dev：内容没变的端点不下载，随后重建派生索引
      await refreshGameData()
      await load()
      setPriceTick((n) => n + 1)
    } catch (e) {
      setError(String(e))
    } finally {
      setDataBusy(false)
    }
  }

  return (
    <div className="space-y-3">
      {/* 搜索 + 刷新价格 */}
      <div className="flex items-center gap-2 flex-wrap">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="搜索物品名（可作产物或材料），如「布洛芬」「私酒」…"
          className="flex-1 min-w-[200px] bg-ink-700 border border-line rounded px-3 py-1.5 text-[13px] text-[#e6edf3] placeholder:text-muted/60 focus:border-amber/60 outline-none"
        />
        <button
          onClick={() => {
            forceRef.current = true
            setPriceTick((n) => n + 1)
          }}
          disabled={!selected || priceState === 'loading'}
          title={
            selected
              ? '重新查询 json.tarkov.dev 的跳蚤价格（忽略 10 分钟缓存）'
              : '选择物品后可刷新其配方与产物的实时价格'
          }
          className="shrink-0 px-3 py-1.5 rounded border border-line text-[13px] text-[#e6edf3] hover:bg-ink-700 disabled:opacity-50"
        >
          {priceState === 'loading' ? '查询中…' : '刷新价格'}
        </button>
      </div>

      {error && <div className="text-[12px] text-red-400 break-all">{error}</div>}

      {loading ? (
        <div className="text-[13px] text-muted py-6">加载配方数据…</div>
      ) : crafts.length === 0 ? (
        <div className="text-[13px] text-muted py-6">
          当前数据包里没有藏身处配方数据。请在「设置 → 游戏数据」更新一次数据后重试。
        </div>
      ) : (
        <>
          {/* 搜索建议：输入时列出匹配物品（可制作 / 可作材料） */}
          {trimmed.length > 0 && (
            <div className="rounded-lg border border-line bg-ink-800 overflow-hidden">
              {suggestions.length === 0 ? (
                <div className="px-3 py-2 text-[12px] text-muted">没有匹配的物品（仅能查到参与藏身处配方的物品）</div>
              ) : (
                <ul className="max-h-64 overflow-y-auto divide-y divide-line/40">
                  {suggestions.map((c) => (
                    <li key={c.id}>
                      <button
                        onClick={() => onSelect(c)}
                        className="w-full text-left flex items-center gap-2.5 px-2.5 py-1.5 hover:bg-ink-700/70"
                      >
                        <ItemIcon id={c.id} size={28} />
                        <span className="min-w-0 flex-1 text-[13px] text-[#e6edf3] truncate">
                          {displayName(c)}
                        </span>
                        {c.asProduct > 0 && (
                          <span className="shrink-0 text-[10px] px-1 py-[1px] rounded border border-amber/40 text-[#d4a174]">
                            可制作 {c.asProduct}
                          </span>
                        )}
                        {c.asIngredient > 0 && (
                          <span className="shrink-0 text-[10px] px-1 py-[1px] rounded border border-line text-muted/80">
                            材料 {c.asIngredient}
                          </span>
                        )}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}

          {/* 详情：制作它 / 它参与的配方 */}
          {selected ? (
            <div className="space-y-3">
              <div className="flex items-center gap-2.5">
                <ItemIcon id={selected.id} size={40} />
                <div className="min-w-0 flex-1">
                  <div className="text-[15px] text-[#e6edf3] truncate">{displayName(selected)}</div>
                  <div className="text-[11px] text-muted/70">
                    {asProductRecipes.length > 0
                      ? `藏身处可制作 ${asProductRecipes.length} 种配方`
                      : '不是藏身处产物'}
                    {' · '}
                    {asIngredientRecipes.length > 0
                      ? `参与 ${asIngredientRecipes.length} 个配方`
                      : '未参与其它配方'}
                  </div>
                </div>
                <button
                  onClick={() => setSelected(null)}
                  className="shrink-0 px-2.5 py-1 rounded border border-line text-[12px] text-muted hover:bg-ink-700"
                >
                  清除
                </button>
              </div>

              {/* 价格状态：实时 / 加载中 / 接口不可用时退回数据集的同步价 */}
              <div className="text-[11px] text-muted/70">
                {priceState === 'loading' && '正在查询跳蚤市场实时价格…'}
                {priceState === 'ok' && (
                  <span className="text-ok/80">
                    实时价格：数据时间 {priceAt ? fmtTime(priceAt.getTime() / 1000) : '—'}
                    <span className="ml-2 text-muted/50">（跳蚤均价，不含手续费）</span>
                    {priceFailed > 0 && (
                      <span className="ml-2 text-amber/80">
                        另有 {priceFailed} 项未取到，已用同步价
                      </span>
                    )}
                  </span>
                )}
                {priceState === 'error' && (
                  <>
                    <span className="text-amber/80">
                      实时价格接口暂不可用，当前显示
                      {status?.updatedAt ? ` ${fmtTime(status.updatedAt)} 同步` : '上次同步'}
                      的游戏数据价格。
                    </span>
                    <button
                      onClick={onUpdateData}
                      disabled={dataBusy}
                      className="ml-2 underline decoration-dotted underline-offset-2 hover:text-[#e6edf3] disabled:opacity-50"
                      title="重新比对 tarkov.dev 静态数据（体积较大，含跳蚤均价）"
                    >
                      {dataBusy ? '更新中…' : '更新游戏数据'}
                    </button>
                  </>
                )}
              </div>

              <section className="space-y-2">
                <h2 className="text-[13px] text-muted">制作它（作为产物）</h2>
                {asProductRecipes.length === 0 ? (
                  <div className="text-[12px] text-muted/70">
                    藏身处配方里没有产出该物品的配方。
                  </div>
                ) : (
                  asProductRecipes.map((c) => (
                    <RecipeCard key={c.id} craft={c} priceOf={priceOf} />
                  ))
                )}
              </section>

              <section className="space-y-2">
                <h2 className="text-[13px] text-muted">它参与的配方（作为材料）</h2>
                {asIngredientRecipes.length === 0 ? (
                  <div className="text-[12px] text-muted/70">没有配方把它当材料。</div>
                ) : (
                  asIngredientRecipes.map((c) => (
                    <RecipeCard
                      key={c.id}
                      craft={c}
                      highlightId={selected.id}
                      priceOf={priceOf}
                    />
                  ))
                )}
              </section>
            </div>
          ) : (
            // 未选物品：直接列出可制作的物品，点一下看配方
            trimmed.length === 0 && (
              <div className="space-y-2">
                <h2 className="text-[13px] text-muted">
                  藏身处可制作物品（{productCandidates.length}）
                  {productCandidates.length > PRODUCT_LIMIT && (
                    <span className="ml-2 text-[11px] text-muted/60">
                      仅显示前 {PRODUCT_LIMIT} 个，可用搜索查找
                    </span>
                  )}
                </h2>
                <ul className="grid gap-2 [grid-template-columns:repeat(auto-fill,minmax(190px,1fr))]">
                  {products.map((c) => (
                    <li key={c.id}>
                      <button
                        onClick={() => onSelect(c)}
                        className="w-full flex items-center gap-2 px-2.5 py-2 rounded-lg border border-line bg-ink-800 hover:border-amber/60 text-left"
                      >
                        <ItemIcon id={c.id} size={30} />
                        <span className="min-w-0 flex-1 text-[13px] text-[#e6edf3] truncate">
                          {displayName(c)}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )
          )}

          {/* 价格口径说明（选中物品时状态在上方，这里只在不看配方时提示） */}
          {!selected && (
            <div className="text-[11px] text-muted/60">
              选择物品后会向 json.tarkov.dev 查询该配方材料与产物的跳蚤市场实时价格；
              接口不可用时退回上次同步的游戏数据价格
              {status?.updatedAt ? `（${fmtTime(status.updatedAt)}）` : ''}。
              利润为估算值，不含跳蚤手续费，任务限定材料可能无法直接购买。
            </div>
          )}
        </>
      )}
    </div>
  )
}
