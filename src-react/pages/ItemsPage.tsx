import { useEffect, useMemo, useState } from 'react'
import { useStore } from '../store'
import { getItems, getQuestGraph } from '../tauri'
import { isMobile } from '../platform'
import type { ItemInfo, QuestGraph, ItemRef } from '../types'

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

  const jumpToQuest = (questId: string) => {
    setGraphTab('chain')
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
                <span className="text-[12px] text-muted/70 font-mono break-all">
                  {item.id}
                </span>
              </div>
            </div>
          </div>
        </div>

        {/* 需求列表 */}
        <div className="px-5 py-4 overflow-y-auto flex-1 min-h-0">
          <div className="flex items-center gap-2 mb-3">
            <span className="text-[14px] font-medium text-[#e6edf3]">需要的任务</span>
            <span className="text-[13px] text-muted">
              {usage.length > 0 ? `共 ${usage.length} 个` : '暂无任何任务需要此物品'}
            </span>
          </div>

          {sorted.length === 0 ? (
            <div className="text-[13px] text-muted leading-relaxed">
              当前数据集中没有任务需要提交或使用此物品。
            </div>
          ) : (
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
          )}
        </div>

        {/* 底部提示 */}
        <div className="px-5 py-3 border-t border-line">
          <span className="text-[12px] text-muted">
            数量为当前数据集中该任务对此物品的总需求（已合并同一任务的多个目标）。
          </span>
        </div>
      </div>
    </div>
  )
}

export function ItemsPage() {
  const [items, setItems] = useState<ItemInfo[]>([])
  const [graph, setGraph] = useState<QuestGraph | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [cat, setCat] = useState<string>('全部')
  const [selected, setSelected] = useState<ItemInfo | null>(null)
  // 分页：当前已渲染数量（搜索 / 切换分类时回到首页）
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE)

  const mobile = isMobile()

  // 物品目录 + 任务图谱（用于聚合需求）各拉一次
  useEffect(() => {
    let alive = true
    setLoading(true)
    Promise.all([getItems(), getQuestGraph()])
      .then(([it, g]) => {
        if (!alive) return
        // 全局过滤掉未分类物品（游戏中正常获取不到的）
        setItems(it.filter((x) => catOf(x) !== UNCATEGORIZED))
        setGraph(g)
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

  // 分类下拉选项
  const categories = useMemo(() => {
    const set = new Set<string>()
    for (const it of items) set.add(catOf(it))
    return Array.from(set).sort((a, b) => a.localeCompare(b, 'zh'))
  }, [items])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return items.filter((it) => {
      if (cat !== '全部' && catOf(it) !== cat) return false
      if (!q) return true
      return (
        it.name.toLowerCase().includes(q) || it.id.toLowerCase().includes(q)
      )
    })
  }, [items, query, cat])

  // 搜索词 / 分类变化后回到第一页
  useEffect(() => {
    setVisibleCount(PAGE_SIZE)
  }, [query, cat])

  const paged = useMemo(
    () => filtered.slice(0, visibleCount),
    [filtered, visibleCount],
  )

  const selectedUsage = useMemo(
    () => (selected ? usageMap.get(selected.id) ?? [] : []),
    [selected, usageMap],
  )

  return (
    <div className="h-full flex flex-col">
      {/* 头部：标题 + 搜索 + 分类筛选 */}
      <div className="shrink-0 px-4 pt-4 pb-3 space-y-3">
        <div className="flex items-center gap-3 flex-wrap">
          <h1 className="text-[17px] font-medium">物品</h1>
          <span className="text-[14px] text-muted">
            共 {items.length} 个
            {filtered.length !== items.length && (
              <span className="ml-1">· 筛选 {filtered.length}</span>
            )}
          </span>
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索物品名称 / id…"
            className="flex-1 min-w-[180px] bg-ink-700 border border-line rounded px-3 py-1.5 text-[13px] text-[#e6edf3] placeholder:text-muted/60 focus:border-amber/60 outline-none"
          />
          <select
            value={cat}
            onChange={(e) => setCat(e.target.value)}
            title="按物品类型筛选"
            className="bg-ink-700 border border-line text-[13px] rounded px-2 py-1.5 text-muted"
          >
            <option value="全部">全部类型</option>
            {categories.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </div>

        {error && <div className="text-[14px] text-red-400">{error}</div>}
      </div>

      {/* 列表 */}
      <div className="flex-1 min-h-0 overflow-y-auto px-4 pb-4">
        {loading && (
          <div className="text-[14px] text-muted py-6">加载物品与任务需求…</div>
        )}
        {!loading && filtered.length === 0 && !error && (
          <div className="text-[14px] text-muted py-6">没有匹配的物品。</div>
        )}

        {filtered.length > 0 && (
          <>
          <ul
            className={`grid gap-3 ${
              mobile
                ? 'grid-cols-1'
                : 'grid-cols-[repeat(auto-fill,minmax(300px,1fr))]'
            }`}
          >
            {paged.map((it) => {
              const demand = usageMap.get(it.id)?.length ?? 0
              return (
                <li key={it.id}>
                  <button
                    onClick={() => setSelected(it)}
                    className="w-full text-left rounded-lg border border-line bg-ink-800 hover:border-amber/60 transition-colors px-4 py-3 flex flex-col items-stretch gap-2 min-w-0"
                  >
                    {/* 第一行：图标 + 名称 */}
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
                    </div>
                    {/* 第二行：左任务数 + 右类型 */}
                    <div className="flex items-center gap-2 min-w-0">
                      {demand > 0 && (
                        <span
                          className="shrink-0 text-[11px] px-1.5 py-[1px] rounded-full bg-amber/15 text-[#d4a174] border border-amber/40"
                          title={`被 ${demand} 个任务需要`}
                        >
                          {demand} 任务
                        </span>
                      )}
                      <span className="ml-auto text-[11px] px-1.5 py-[1px] rounded border border-line text-muted/80 truncate max-w-full">
                        {catOf(it)}
                      </span>
                    </div>
                  </button>
                </li>
              )
            })}
          </ul>
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
