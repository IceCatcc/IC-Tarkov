import { useEffect, useMemo, useState } from 'react'
import { useStore } from '../store'
import { getItems, getQuestGraph, getCollectorQuestId } from '../tauri'
import { isMobile } from '../platform'
import type { ItemInfo, QuestGraph, ItemRef } from '../types'

/** tarkov.dev 稀有度颜色 (backgroundColor) -> 中文等级 + 展示色 */
const RARITY_MAP: Record<string, { label: string; color: string }> = {
  default: { label: '普通', color: '#9aa4b2' },
  gray: { label: '普通', color: '#9aa4b2' },
  blue: { label: '精良', color: '#4f9dff' },
  yellow: { label: '稀有', color: '#e8c34a' },
  red: { label: '极稀有', color: '#e5534b' },
  black: { label: '传说', color: '#b07cff' },
  violet: { label: '传说', color: '#b07cff' },
}

function rarityOf(it: ItemInfo): { label: string; color: string } | null {
  if (!it.rarity) return null
  return RARITY_MAP[it.rarity] ?? { label: it.rarity, color: '#9aa4b2' }
}

/** 需要按属性自动分档的物品类型：背包按格子（每 5 格）、弹药按穿透（每 10 穿） */
const BAG_CAT = '背包'
const AMMO_CAT = '弹药'

/** 某物品被某任务需要的需求条目（同一任务多个目标引用同物品时已合并） */
interface QuestUsage {
  questId: string
  questName: string
  traderName: string
  modes: string[]
  count: number
  foundInRaid: boolean
}

/** 分类下拉：未分类的统一标签 */
const UNCATEGORIZED = '未分类'
/** 单次最多渲染的物品数（其余点「加载更多」） */
const PAGE_SIZE = 40

/** 把物品类别归一：null / undefined -> 未分类 */
function catOf(it: ItemInfo): string {
  return it.category && it.category.trim() ? it.category : UNCATEGORIZED
}

/**
 * 是否为收藏家（Kappa）任务：id 由后端给出（与收藏家页同源）；
 * 数据集里找不到该任务时回退按中文名判定。
 */
function isCollectorQuest(
  questId: string,
  questName: string,
  collectorId: string | null,
): boolean {
  return collectorId ? questId === collectorId : questName.includes('收藏家')
}

/** 任务需求弹窗 */
function ItemDetailModal({
  item,
  usage,
  onClose,
}: {
  item: ItemInfo
  usage: QuestUsage[]
  onClose: () => void
}) {
  const setPage = useStore((s) => s.setPage)
  const setGraphTab = useStore((s) => s.setGraphTab)
  const setGraphFocusId = useStore((s) => s.setGraphFocusId)

  // 按需求数量降序，方便一眼看到哪个任务要得最多
  const sorted = useMemo(
    () => [...usage].sort((a, b) => b.count - a.count),
    [usage],
  )

  // 跳到任务页定位该任务：走「任务列表」而不是任务链——任务链只画有依赖关系的任务，
  // 独立任务 / 收藏家任务等在里面找不到；列表视图负责切商人、放宽筛选、滚动并高亮
  const jumpToQuest = (questId: string) => {
    setGraphTab('list')
    setGraphFocusId(questId)
    setPage('graph')
    onClose()
  }

  return (
    <div
      className="fixed inset-0 z-[2000] flex items-center justify-center bg-black/60"
      onClick={onClose}
    >
      <div
        className="w-[560px] max-w-[calc((100vw-32px)/var(--ui-scale,1))] max-h-[calc(80dvh/var(--ui-scale,1))] flex flex-col rounded-2xl border border-line bg-ink-800 shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* 头部 */}
        <div className="relative px-5 pt-5 pb-4 border-b border-line bg-gradient-to-b from-ink-700/60 to-transparent">
          <button
            onClick={onClose}
            className="absolute top-3 right-3 w-7 h-7 grid place-items-center rounded-md text-[15px] text-muted hover:text-[#e6edf3] hover:bg-ink-700"
            aria-label="关闭"
          >
            ✕
          </button>
          <div className="pr-8 flex items-start gap-3">
            <span className="shrink-0 w-12 h-12 grid place-items-center rounded-lg bg-ink-900/60 border border-line overflow-hidden">
              <img
                src={`/item-icons/${item.id}.webp`}
                alt=""
                onError={(e) => (e.currentTarget.style.display = 'none')}
                className="w-12 h-12 object-contain"
              />
            </span>
            <div className="min-w-0">
              <h2 className="text-[18px] font-semibold text-[#e6edf3] break-words">
                {item.name}
              </h2>
              <div className="mt-1.5 flex items-center gap-2">
                <span className="inline-flex items-center h-6 px-2 rounded border border-line bg-ink-700 text-[12px] text-muted">
                  {catOf(item)}
                </span>
                {rarityOf(item) && (
                  <span
                    className="inline-flex items-center h-6 px-2 rounded border text-[12px]"
                    style={{
                      color: rarityOf(item)!.color,
                      borderColor: `${rarityOf(item)!.color}66`,
                    }}
                  >
                    {rarityOf(item)!.label}
                  </span>
                )}
                <span className="text-[12px] text-muted/70 font-mono break-all">
                  {item.id}
                </span>
              </div>
            </div>
          </div>
        </div>

        {item.description && (
          <div className="px-5 py-3 border-b border-line">
            <div className="text-[13px] text-muted mb-1">物品描述</div>
            <p className="text-[13px] leading-relaxed text-[#c9d1d9] whitespace-pre-line">
              {item.description}
            </p>
          </div>
        )}

        {usage.length > 0 && (
          <>
            {/* 需求列表 */}
            <div className="px-5 py-4 overflow-y-auto flex-1 min-h-0">
              <div className="flex items-center gap-2 mb-3">
                <span className="text-[14px] font-medium text-[#e6edf3]">需要的任务</span>
                <span className="text-[13px] text-muted">共 {usage.length} 个</span>
              </div>

              <ul className="space-y-2">
                {sorted.map((u) => (
                  <li key={u.questId}>
                    <button
                      onClick={() => jumpToQuest(u.questId)}
                      title="跳转到任务链查看详情"
                      className="w-full text-left rounded-lg border border-line bg-ink-900/60 hover:border-amber/60 hover:bg-ink-700/60 transition-colors px-3 py-2.5"
                    >
                      <div className="flex items-center gap-2 min-w-0">
                        <span className="min-w-0 flex-1 truncate text-[14px] text-[#c9d1d9]">
                          {u.questName}
                        </span>
                        <span className="shrink-0 text-[14px] font-medium text-amber">
                          ×{u.count}
                        </span>
                      </div>
                      <div className="mt-1 flex items-center gap-1.5 flex-wrap">
                        {u.traderName && (
                          <span className="text-[12px] text-muted">{u.traderName}</span>
                        )}
                        {u.modes?.map((m) => (
                          <span
                            key={m}
                            className="text-[11px] px-1.5 py-[1px] rounded border border-line text-muted/80 uppercase"
                          >
                            {m}
                          </span>
                        ))}
                        {u.foundInRaid && (
                          <span
                            className="text-[11px] px-1.5 py-[1px] rounded border border-[#d7dde5]/40 text-[#d7dde5]/80"
                            title="必须在战局内拾取（Found In Raid）"
                          >
                            战局内
                          </span>
                        )}
                      </div>
                    </button>
                  </li>
                ))}
              </ul>
            </div>

            {/* 底部提示 */}
            <div className="px-5 py-3 border-t border-line">
              <span className="text-[12px] text-muted">
                数量为当前数据集中该任务对此物品的总需求（已合并同一任务的多个目标）。
              </span>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

/** 物品卡片（列表项） */
function ItemCard({
  it,
  demand,
  onSelect,
}: {
  it: ItemInfo
  demand: number
  onSelect: (it: ItemInfo) => void
}) {
  return (
    <li>
      <button
        onClick={() => onSelect(it)}
        className="relative overflow-hidden w-full text-left rounded-lg border border-line bg-ink-800 hover:border-amber/60 transition-colors px-4 py-3 flex flex-col items-stretch gap-2 min-w-0"
      >
        {/* 左侧稀有度描边（卡片左边一小段） */}
        {rarityOf(it) && (
          <span
            className="absolute left-0 top-1/2 -translate-y-1/2 w-[3px] h-1/2 rounded-r"
            style={{ background: rarityOf(it)!.color }}
            title={`稀有度：${rarityOf(it)!.label}`}
          />
        )}
        {/* 第一行：图标 + 名称 + 右上角任务数 */}
        <div className="flex items-center gap-3 min-w-0">
          <span className="shrink-0 w-10 h-10 grid place-items-center rounded bg-ink-900/60 overflow-hidden">
            <img
              src={`/item-icons/${it.id}.webp`}
              alt=""
              loading="lazy"
              onError={(e) => (e.currentTarget.style.display = 'none')}
              className="w-10 h-10 object-contain"
            />
          </span>
          <span className="min-w-0 flex-1 truncate text-[16px] font-medium text-[#e6edf3]">
            {it.name}
          </span>
          {demand > 0 && (
            <span
              className="shrink-0 text-[11px] px-1.5 py-[1px] rounded-full bg-amber/15 text-[#d4a174] border border-amber/40"
              title={`被 ${demand} 个任务需要`}
            >
              {demand} 任务
            </span>
          )}
        </div>
        {/* 描述固定 2 行高：超出截断，不足也占满（12px × leading-snug 1.375 × 2 = 33px），
            否则同一行的卡片会因描述长短不一而参差不齐 */}
        <div className="min-w-0 h-[33px] text-[12px] leading-snug text-muted/80 line-clamp-2">
          {it.description}
        </div>
      </button>
    </li>
  )
}

export function ItemsPage() {
  const [items, setItems] = useState<ItemInfo[]>([])
  const [graph, setGraph] = useState<QuestGraph | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [cat, setCat] = useState<string>('')
  const [caliberFilter, setCaliberFilter] = useState('')
  // 只显示被任务需要的物品（任务上交 / 任务目标物品；不含收藏家任务）
  const [questOnly, setQuestOnly] = useState(false)
  // 收藏家（Kappa）任务 id：由后端定位，用于把它排除在「任务所需」之外
  const [collectorId, setCollectorId] = useState<string | null>(null)
  const [selected, setSelected] = useState<ItemInfo | null>(null)
  // 分页：当前已渲染数量（搜索 / 切换分类时回到首页）
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE)

  const mobile = isMobile()

  // 物品目录 + 任务图谱（用于聚合需求）各拉一次
  useEffect(() => {
    let alive = true
    setLoading(true)
    Promise.all([getItems(), getQuestGraph(), getCollectorQuestId()])
      .then(([it, g, cid]) => {
        if (!alive) return
        // 全局过滤掉未分类物品（游戏中正常获取不到的）
        setItems(it.filter((x) => catOf(x) !== UNCATEGORIZED))
        setGraph(g)
        setCollectorId(cid)
        setLoading(false)
      })
      .catch((e) => {
        if (!alive) return
        setError(String(e))
        setLoading(false)
      })
    return () => {
      alive = false
    }
  }, [])

  // 任务需求聚合：itemId -> 需要它的任务列表（同任务同物品的数量已合并）
  const usageMap = useMemo(() => {
    const map = new Map<string, QuestUsage[]>()
    if (!graph) return map
    for (const node of graph.nodes) {
      const perItem = new Map<string, { count: number; foundInRaid: boolean }>()
      for (const it of node.turnIns as ItemRef[]) {
        const cur = perItem.get(it.id) ?? { count: 0, foundInRaid: false }
        cur.count += it.count ?? 1
        if (it.foundInRaid) cur.foundInRaid = true
        perItem.set(it.id, cur)
      }
      for (const [itemId, agg] of perItem) {
        const arr = map.get(itemId) ?? []
        arr.push({
          questId: node.id,
          questName: node.name,
          traderName: node.traderName,
          modes: node.modes ?? [],
          count: agg.count,
          foundInRaid: agg.foundInRaid,
        })
        map.set(itemId, arr)
      }
    }
    return map
  }, [graph])

  // 「仅任务所需」用的物品集合：排除收藏家（Kappa）任务——它要上百种物品，
  // 混进来会把列表淹掉，收藏家需求由「收藏家」页专门管理
  const questUsageIds = useMemo(() => {
    const set = new Set<string>()
    if (!graph) return set
    for (const node of graph.nodes) {
      if (isCollectorQuest(node.id, node.name, collectorId)) continue
      for (const it of node.turnIns as ItemRef[]) set.add(it.id)
    }
    return set
  }, [graph, collectorId])

  // 分类下拉选项
  const categories = useMemo(() => {
    const set = new Set<string>()
    for (const it of items) set.add(catOf(it))
    return Array.from(set).sort((a, b) => a.localeCompare(b, 'zh'))
  }, [items])

  // 类型筛选默认选中第一个分类（不提供「全部」同时显示）
  useEffect(() => {
    if (categories.length > 0 && (!cat || !categories.includes(cat))) {
      setCat(categories[0])
    }
  }, [categories, cat])

  // 弹药口径选项（仅弹药类型有意义）
  const caliberOptions = useMemo(() => {
    const set = new Set<string>()
    for (const it of items) {
      if (catOf(it) === AMMO_CAT && it.caliber) set.add(it.caliber)
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b, 'en'))
  }, [items])

  // 切换类型时清空口径筛选
  useEffect(() => {
    setCaliberFilter('')
  }, [cat])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return items.filter((it) => {
      if (questOnly && !questUsageIds.has(it.id)) return false
      if (cat && catOf(it) !== cat) return false
      if (cat === AMMO_CAT && caliberFilter && it.caliber !== caliberFilter) return false
      if (!q) return true
      return (
        it.name.toLowerCase().includes(q) || it.id.toLowerCase().includes(q)
      )
    })
  }, [items, query, cat, caliberFilter, questOnly, questUsageIds])

  // 排序：背包按格子降序、弹药按穿透降序、其它按名称
  const sortedItems = useMemo(() => {
    const arr = [...filtered]
    if (cat === BAG_CAT) {
      arr.sort(
        (a, b) =>
          (b.slots ?? -1) - (a.slots ?? -1) || a.name.localeCompare(b.name, 'zh'),
      )
    } else if (cat === AMMO_CAT) {
      arr.sort(
        (a, b) =>
          (b.penetration ?? -1) - (a.penetration ?? -1) ||
          a.name.localeCompare(b.name, 'zh'),
      )
    } else {
      arr.sort((a, b) => a.name.localeCompare(b.name, 'zh'))
    }
    return arr
  }, [filtered, cat])

  // 搜索词 / 分类 / 口径 / 任务所需开关变化后回到第一页
  useEffect(() => {
    setVisibleCount(PAGE_SIZE)
  }, [query, cat, caliberFilter, questOnly])

  const paged = useMemo(
    () => sortedItems.slice(0, visibleCount),
    [sortedItems, visibleCount],
  )

  // 分档：背包按每 5 格、弹药按每 10 穿分组成带标题的段（档从大到小）；其它类型不分组
  const groups = useMemo(() => {
    if (cat !== BAG_CAT && cat !== AMMO_CAT) return null
    const isBag = cat === BAG_CAT
    const step = isBag ? 5 : 10
    const map = new Map<number, ItemInfo[]>()
    for (const it of paged) {
      const v = isBag ? it.slots : it.penetration
      const bucket = v == null ? -1 : Math.floor(v / step) * step
      const arr = map.get(bucket)
      if (arr) arr.push(it)
      else map.set(bucket, [it])
    }
    return Array.from(map.entries())
      .sort((a, b) => b[0] - a[0])
      .map(([bucket, list]) => ({
        key: String(bucket),
        label:
          bucket < 0
            ? '未知'
            : isBag
              ? `${bucket}–${bucket + step - 1} 格`
              : `${bucket}–${bucket + step - 1} 穿`,
        items: list,
      }))
  }, [cat, paged])

  const selectedUsage = useMemo(
    () => (selected ? usageMap.get(selected.id) ?? [] : []),
    [selected, usageMap],
  )

  return (
    <div className="h-full flex flex-col">
      {/* 头部：标题 + 搜索 + 类型（弹药另有口径） */}
      <div className="shrink-0 px-4 pt-4 pb-3 space-y-3">
        <div className="flex items-center gap-3 flex-wrap">
          <h1 className="text-[17px] font-medium">物品</h1>
          <span className="text-[14px] text-muted">
            共 {filtered.length} 个
          </span>
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索物品名称 / id…"
            className="flex-1 min-w-[180px] bg-ink-700 border border-line rounded px-3 py-1.5 text-[13px] text-[#e6edf3] placeholder:text-muted/60 focus:border-amber/60 outline-none"
          />
          {/* 只看被任务需要的物品（任务上交 / 目标物品；不含收藏家任务） */}
          <button
            onClick={() => setQuestOnly((v) => !v)}
            role="switch"
            aria-checked={questOnly}
            title="只显示被任务需要的物品（任务上交与任务目标物品）。不含收藏家（Kappa）任务：它要上百种物品，会淹没列表，其需求见「收藏家」页。"
            className={`shrink-0 inline-flex items-center gap-1.5 px-3 py-1.5 rounded border text-[13px] transition-colors ${
              questOnly
                ? 'bg-amber/15 text-[#d4a174] border-amber/40'
                : 'bg-ink-700 text-muted border-line hover:border-amber/50'
            }`}
          >
            <span
              className={`w-3.5 h-3.5 shrink-0 grid place-items-center rounded-[3px] border ${
                questOnly ? 'border-amber/80 bg-amber/25' : 'border-line'
              }`}
            >
              {questOnly && (
                <svg
                  viewBox="0 0 16 16"
                  className="w-2.5 h-2.5"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.5"
                >
                  <path d="M3 8.5 6.2 11.7 13 5" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              )}
            </span>
            仅任务所需（除 Kappa）
          </button>
        </div>

        {/* 类型 tab：默认选中第一个分类，无「全部」选项 */}
        <div className="flex flex-wrap gap-1.5 mb-3">
          {categories.map((c) => (
            <button
              key={c}
              onClick={() => setCat(c)}
              className={`px-3 py-1.5 rounded-full text-[13px] border transition-colors ${
                cat === c
                  ? 'bg-amber/15 text-[#d4a174] border-amber/40'
                  : 'bg-ink-700 text-muted border-line hover:border-amber/50'
              }`}
            >
              {c}
            </button>
          ))}
        </div>

        {/* 弹药：口径筛选 */}
        {cat === AMMO_CAT && caliberOptions.length > 0 && (
          <div className="flex flex-wrap gap-1.5 mb-3">
            <button
              onClick={() => setCaliberFilter('')}
              className={`px-3 py-1.5 rounded-full text-[13px] border transition-colors ${
                caliberFilter === ''
                  ? 'bg-amber/15 text-[#d4a174] border-amber/40'
                  : 'bg-ink-700 text-muted border-line hover:border-amber/50'
              }`}
            >
              全部口径
            </button>
            {caliberOptions.map((c) => (
              <button
                key={c}
                onClick={() => setCaliberFilter(c)}
                className={`px-3 py-1.5 rounded-full text-[13px] border transition-colors ${
                  caliberFilter === c
                    ? 'bg-amber/15 text-[#d4a174] border-amber/40'
                    : 'bg-ink-700 text-muted border-line hover:border-amber/50'
                }`}
              >
                {c}
              </button>
            ))}
          </div>
        )}

        {error && <div className="text-[14px] text-red-400">{error}</div>}
      </div>

      {/* 列表 */}
      <div className="flex-1 min-h-0 overflow-y-auto px-4 pb-4">
        {loading && (
          <div className="text-[14px] text-muted py-6">加载物品与任务需求…</div>
        )}
        {!loading && filtered.length === 0 && !error && (
          <div className="text-[14px] text-muted py-6">
            {questOnly
              ? '当前类型下没有任务所需的物品（不含收藏家任务），可切换类型或关闭「仅任务所需（除 Kappa）」。'
              : '没有匹配的物品。'}
          </div>
        )}

        {filtered.length > 0 && (
          <>
            {groups ? (
              <div className="space-y-4">
                {groups.map((g) => (
                  <div key={g.key}>
                    {/* 分档标题：吸顶，滚到哪一档都看得见 */}
                    <div className="sticky top-0 z-10 py-1.5">
                      <span className="inline-flex items-baseline bg-ink-900/90 backdrop-blur-sm rounded px-2 py-0.5 text-[14px] font-semibold text-[#e6edf3]">
                        {g.label}
                        <span className="text-muted font-normal ml-1">· {g.items.length}</span>
                      </span>
                    </div>
                    <ul
                      className={`grid gap-3 ${
                        mobile
                          ? 'grid-cols-1'
                          : 'grid-cols-[repeat(auto-fill,minmax(300px,1fr))]'
                      }`}
                    >
                      {g.items.map((it) => (
                        <ItemCard
                          key={it.id}
                          it={it}
                          demand={usageMap.get(it.id)?.length ?? 0}
                          onSelect={setSelected}
                        />
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
            ) : (
              <ul
                className={`grid gap-3 ${
                  mobile
                    ? 'grid-cols-1'
                    : 'grid-cols-[repeat(auto-fill,minmax(300px,1fr))]'
                }`}
              >
                {paged.map((it) => (
                  <ItemCard
                    key={it.id}
                    it={it}
                    demand={usageMap.get(it.id)?.length ?? 0}
                    onSelect={setSelected}
                  />
                ))}
              </ul>
            )}

            {visibleCount < filtered.length && (
              <div className="flex justify-center pt-3">
                <button
                  onClick={() =>
                    setVisibleCount((c) => Math.min(c + PAGE_SIZE, filtered.length))
                  }
                  className="px-4 py-2 rounded-lg border border-line bg-ink-700 hover:border-amber/60 text-[13px] text-[#c9d1d9] transition-colors"
                >
                  加载更多（剩余 {filtered.length - visibleCount} 个）
                </button>
              </div>
            )}
          </>
        )}
      </div>

      {selected && (
        <ItemDetailModal
          item={selected}
          usage={selectedUsage}
          onClose={() => setSelected(null)}
        />
      )}
    </div>
  )
}
