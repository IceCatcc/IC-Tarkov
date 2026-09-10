import { useEffect, useMemo, useState } from 'react'
import { useStore, useQuestDetail } from '../store'
import { traderImage } from '../traderImages'
import { TRADERS, TRADER_ZH, traderDisplayName } from '../traderMeta'
import { llLabel, questLoyaltyLevel, type GraphNode, type ItemRef } from '../types'

type ItemState = 'completed' | 'in_progress' | 'available' | 'locked'

interface BoardItem {
  n: GraphNode
  state: ItemState
  /** 前置任务（名称 + 是否已完成）：卡片上直接显示名称并可点击跳转 */
  preReqs: { id: string; name: string; done: boolean }[]
}

const STATE_CHIP: Record<ItemState, string> = {
  completed: 'bg-[#1b1f24] border-done text-muted',
  in_progress: 'bg-blue-soft border-blue text-blue',
  available: 'bg-amber/15 border-amber/60 text-[#d4a174]',
  locked: 'bg-ink-700 border-line text-muted',
}
const STATE_TEXT: Record<ItemState, string> = {
  completed: '已完成',
  in_progress: '进行中',
  available: '待接取',
  locked: '未解锁',
}

function dedupeItems(items: ItemRef[]): ItemRef[] {
  const m = new Map<string, ItemRef>()
  for (const it of items) {
    const prev = m.get(it.id)
    const c = it.count ?? 1
    if (!prev || (prev.count ?? 1) < c) m.set(it.id, { ...it })
  }
  return Array.from(m.values())
}

/**
 * 任务列表视图：左侧竖排商人筛选（与监控页一致的样式），右侧按忠诚等级（LL）分组，
 * 组内按「需求等级」（任务要求的玩家等级）升序 -> 名称排序，每张卡展示更多信息。
 */
export function QuestBoardView() {
  const graph = useStore((s) => s.graph)
  const playerQuests = useStore((s) => s.playerQuests)
  const unlockedQuests = useStore((s) => s.unlockedQuests)
  const questMode = useStore((s) => s.questMode)
  const search = useStore((s) => s.searchGraph)
  const hideLegacy = useStore((s) => s.hideLegacyGraph)
  const showPrestige = useStore((s) => s.showPrestigeGraph)
  const showCompleted = useStore((s) => s.showCompletedGraph)
  // null = 全部商人
  const [trader, setTrader] = useState<string | null>(null)
  // 分页：每张卡会按需拉取任务详情，一次铺开全部（500+）会瞬间发出大量请求
  const [limit, setLimit] = useState(60)

  const items = useMemo<BoardItem[]>(() => {
    if (!graph) return []
    const statusOf = new Map<string, 'in_progress' | 'completed'>()
    const completed = new Set<string>()
    for (const q of playerQuests) {
      statusOf.set(q.questId, q.status)
      if (q.status === 'completed') completed.add(q.questId)
    }
    const unlocked = new Set<string>(unlockedQuests)
    // 模式感知前置：pve 模式下优先用 prereqsPve
    const prereqsOf = (n: GraphNode): string[] =>
      questMode === 'pve' && n.prereqsPve?.length ? n.prereqsPve : n.prereqs ?? []
    // id -> 任务名（前置任务直接显示名称用）
    const nodeName = new Map<string, string>()
    for (const x of graph.nodes) nodeName.set(x.id, x.name)
    const q = search.trim().toLowerCase()
    const out: BoardItem[] = []
    for (const n of graph.nodes) {
      if (n.modes && n.modes.length > 0 && !n.modes.includes(questMode)) continue
      if (hideLegacy && n.legacy) continue
      if (!showPrestige && n.prestigeLevel != null) continue
      if (!showCompleted && statusOf.get(n.id) === 'completed') continue
      if (q && !n.name.toLowerCase().includes(q)) continue
      const st = statusOf.get(n.id)
      let state: ItemState = 'locked'
      if (st === 'completed') state = 'completed'
      else if (st === 'in_progress') state = 'in_progress'
      else if (unlocked.has(n.id) || prereqsOf(n).every((p) => completed.has(p))) state = 'available'
      const preReqs = prereqsOf(n).map((p) => ({
        id: p,
        name: nodeName.get(p) ?? p,
        done: completed.has(p),
      }))
      out.push({ n, state, preReqs })
    }
    return out
  }, [graph, playerQuests, unlockedQuests, questMode, search, hideLegacy, showPrestige, showCompleted])

  // 商人列表：按 TRADERS 顺序（未收录的排最后，按名称）
  const traders = useMemo(() => {
    const m = new Map<string, { id: string; name: string; count: number }>()
    for (const { n } of items) {
      const id = n.traderId || 'unknown'
      const e = m.get(id) ?? { id, name: n.traderName || '未知', count: 0 }
      e.count += 1
      m.set(id, e)
    }
    const order = new Map(TRADERS.map((t, i) => [t.id, i]))
    return Array.from(m.values()).sort(
      (a, b) => (order.get(a.id) ?? 99) - (order.get(b.id) ?? 99) || a.name.localeCompare(b.name),
    )
  }, [items])

  // 左列已经没有「全部」入口：未指定时默认选中第一个商人
  const activeTrader = trader ?? traders[0]?.id ?? null

  // 点击卡片上的前置任务名：定位到那个任务（它可能挂在别的商人名下，先切过去）
  const [focusId, setFocusId] = useState<string | null>(null)
  const jumpTo = (id: string) => {
    const target = items.find((x) => x.n.id === id)
    const tid = target ? target.n.traderId || 'unknown' : null
    if (tid && tid !== activeTrader) {
      setTrader(tid)
      setLimit(300) // 目标可能排在分页之外，放大上限保证能渲染到
    }
    setFocusId(id)
  }
  useEffect(() => {
    if (!focusId) return
    document
      .getElementById(`qb-${focusId}`)
      ?.scrollIntoView({ block: 'center', behavior: 'smooth' })
  }, [focusId, trader, limit])

  // 选中商人 -> 按 LL 分组 -> 组内按需求等级（玩家等级）-> 名称
  const groups = useMemo(() => {
    const list = activeTrader
      ? items.filter((x) => (x.n.traderId || 'unknown') === activeTrader)
      : items
    const m = new Map<number, BoardItem[]>()
    for (const it of list) {
      const ll = questLoyaltyLevel(it.n)
      const arr = m.get(ll) ?? []
      arr.push(it)
      m.set(ll, arr)
    }
    return Array.from(m.keys())
      .sort((a, b) => a - b)
      .map((ll) => ({
        ll,
        items: m
          .get(ll)!
          .slice()
          .sort(
            (a, b) =>
              (a.n.minLevel ?? 1) - (b.n.minLevel ?? 1) || a.n.name.localeCompare(b.n.name),
          ),
      }))
      }, [items, activeTrader])

      // 只渲染「前 limit 张」，保持分组结构；total 用于判断是否还有更多
  const { shownGroups, total } = useMemo(() => {
    let used = 0
    const out = groups.map((g) => {
      const room = Math.max(0, limit - used)
      used += g.items.length
      return { ...g, items: g.items.slice(0, room) }
    })
    return { shownGroups: out, total: used }
  }, [groups, limit])

  return (
    <div className="h-full flex min-h-0">
      {/* 左侧商人筛选：竖排头像（样式与监控页一致） */}
      <nav className="shrink-0 w-[72px] h-full overflow-y-auto flex flex-col items-stretch gap-1.5 py-2 px-1.5 border-r border-line bg-ink-900">
        {traders.map((t) => {
          const avatar = traderImage(t.id)
          const label = TRADER_ZH[t.id] ?? t.name
          const active = activeTrader === t.id
          return (
            <button
              key={t.id}
              onClick={() => {
                setTrader(t.id)
                setLimit(60)
              }}
              title={traderDisplayName(t.id, t.name)}
              className={`flex flex-col items-center gap-1 py-1.5 rounded-lg border transition-colors ${
                active ? 'bg-amber-soft border-amber' : 'border-transparent hover:bg-ink-800'
              }`}
            >
              {avatar ? (
                <img
                  src={avatar}
                  alt=""
                  className={`w-10 h-10 rounded-full object-cover border ${
                    active ? 'border-amber' : 'border-line'
                  }`}
                />
              ) : (
                <span
                  className={`w-10 h-10 rounded-full flex items-center justify-center border text-[15px] ${
                    active ? 'border-amber text-amber bg-ink-800' : 'border-line text-muted bg-ink-800'
                  }`}
                >
                  {label.slice(0, 1)}
                </span>
              )}
              <span
                className={`max-w-full truncate text-[11px] leading-none ${
                  active ? 'text-amber font-medium' : 'text-muted'
                }`}
              >
                {label}
              </span>
            </button>
          )
        })}
      </nav>

      {/* 右侧：LL 分组 + 卡片 */}
      <div className="flex-1 min-w-0 h-full overflow-y-auto px-4 py-3">
        {groups.length === 0 ? (
          <div className="text-[14px] text-muted py-10 text-center">没有符合条件的任务</div>
        ) : (
          shownGroups.map((g) => (
            <div key={g.ll} className="mb-4">
              {/* 吸顶分组标题：只给文字加底衬（不铺整条背景），滚动时不显得像一条胶带 */}
              <div className="sticky top-0 z-10 py-1.5">
                <span className="inline-flex items-baseline bg-ink-900/90 backdrop-blur-sm rounded px-2 py-0.5 text-[14px] font-semibold text-[#e6edf3]">
                  {llLabel(g.ll)}
                  <span className="text-muted font-normal ml-1">· {g.items.length}</span>
                </span>
              </div>
              <div className="space-y-2">
                {g.items.map((it) => (
                  <QuestBoardCard
                    key={it.n.id}
                    n={it.n}
                    state={it.state}
                    preReqs={it.preReqs}
                    focused={focusId === it.n.id}
                    onJump={jumpTo}
                  />
                ))}
              </div>
            </div>
          ))
        )}
        {total > limit && (
          <div className="flex justify-center py-3">
            <button
              onClick={() => setLimit((v) => v + 60)}
              className="px-4 py-1.5 rounded border border-line text-[14px] text-muted hover:text-[#e6edf3] hover:bg-ink-700"
            >
              加载更多（还有 {total - limit} 个）
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

function QuestBoardCard({
  n,
  state,
  preReqs,
  focused,
  onJump,
}: {
  n: GraphNode
  state: ItemState
  preReqs: { id: string; name: string; done: boolean }[]
  focused: boolean
  onJump: (id: string) => void
}) {
  const openWiki = useStore((s) => s.openWiki)
  const wikiUrlFor = useStore((s) => s.wikiUrlFor)
  const profile = useStore((s) => s.settings.profile)
  const detail = useQuestDetail(n.id)
  const url = wikiUrlFor(n.id)
  const avatar = traderImage(n.traderId)
  const traderLabel = traderDisplayName(n.traderId, n.traderName)
  const ll = questLoyaltyLevel(n)
  // 所需物品：详情中跨目标去重；详情未就绪时回退到节点自带的上交物品
  const items = detail
    ? dedupeItems((detail.objectives ?? []).flatMap((o) => o.items ?? []))
    : dedupeItems(n.turnIns ?? [])
  const loyalty = profile?.loyalty ?? {}

  return (
    <div
      id={`qb-${n.id}`}
      className={`bg-ink-800 border rounded-xl p-4 transition-colors ${
        focused ? 'border-amber ring-2 ring-amber/40' : 'border-line'
      } ${url ? 'cursor-pointer hover:border-amber/60' : ''}`}
      onClick={() => url && openWiki(url)}
      title={url ? '点击查看资料' : undefined}
    >
      {/* 第一行：头像 + 任务名 + 关键需求（忠诚等级 / 等级 / 前置）+ 状态 */}
      <div className="flex items-center gap-2 min-w-0">
        {avatar && (
          <img
            src={avatar}
            alt={traderLabel}
            className="w-6 h-6 rounded-full object-cover border border-line shrink-0"
          />
        )}
        <span className="text-[18px] font-semibold truncate min-w-0 flex-1">{n.name}</span>
        {ll > 0 && (
          <span
            className="shrink-0 px-1.5 py-0.5 rounded border text-[12px] border-amber/40 bg-amber/15 text-amber"
            title="该任务要求的商人忠诚等级"
          >
            LL{ll}
          </span>
        )}
        {n.minLevel != null && n.minLevel > 0 && (
          <span className="shrink-0 px-1.5 py-0.5 rounded border border-line text-[12px] text-muted">
            Lv{n.minLevel}+
          </span>
        )}
        {preReqs.slice(0, 2).map((p) => (
          <span
            key={p.id}
            onClick={(e) => {
              e.stopPropagation()
              onJump(p.id)
            }}
            title={`跳转到前置任务：${p.name}`}
            className={`shrink-0 max-w-[130px] truncate px-1.5 py-0.5 rounded border text-[12px] cursor-pointer hover:border-amber/60 ${
              p.done ? 'border-ok/50 bg-ok/10 text-ok' : 'border-line text-muted'
            }`}
          >
            前置 · {p.name}
          </span>
        ))}
        {preReqs.length > 2 && (
          <span className="shrink-0 px-1.5 py-0.5 rounded border border-line text-[12px] text-muted">
            +{preReqs.length - 2}
          </span>
        )}
        <span
          className={`ml-auto px-2 py-0.5 rounded-full text-[13px] border shrink-0 ${STATE_CHIP[state]}`}
        >
          {STATE_TEXT[state]}
        </span>
      </div>

      {/* 第二行：商人 / 地图（等级与前置已提到首行） */}
      <div className="mt-1 flex items-center gap-2 text-[12px] text-muted flex-wrap">
        <span>{traderLabel}</span>
        {n.mapName && <span>{n.mapName}</span>}
      </div>

      {/* 条件徽章：非发布者商人的忠诚等级 / 好感 / 转生 / 赛季 / 模式 */}
      {(n.traderReqs ?? []).length > 0 ||
      n.prestigeLevel != null ||
      n.legacy ||
      (n.modes && n.modes.length > 0 && n.modes.length < 2) ? (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {n.traderReqs?.map((r, i) => {
            const met =
              r.reqType === 'reputation'
                ? (loyalty[r.traderId] ?? 1) >= r.value
                : (loyalty[r.traderId] ?? 1) >= r.value
            return (
              <span
                key={`${r.traderId}-${i}`}
                className={`px-1.5 py-0.5 rounded border text-[12px] ${
                  met
                    ? 'border-ok/50 bg-ok/10 text-ok'
                    : 'border-red-500/40 bg-red-500/10 text-red-300'
                }`}
              >
                {traderDisplayName(r.traderId, r.traderName)}{' '}
                {r.reqType === 'reputation' ? `好感 ≥ ${r.value}` : `LL${r.value}`}
              </span>
            )
          })}
          {n.prestigeLevel != null && (
            <span className="px-1.5 py-0.5 rounded border border-amber/40 bg-amber/15 text-amber text-[12px]">
              转生 {n.prestigeLevel}
            </span>
          )}
          {n.legacy && (
            <span className="px-1.5 py-0.5 rounded border border-line text-[12px] text-muted">
              赛季任务
            </span>
          )}
          {n.modes && n.modes.length > 0 && !n.modes.includes('pve') && (
            <span className="px-1.5 py-0.5 rounded border border-red-500/40 bg-red-500/15 text-red-300 text-[12px]">
              仅 PvP
            </span>
          )}
          {n.modes && n.modes.length > 0 && !n.modes.includes('pvp') && (
            <span className="px-1.5 py-0.5 rounded border border-amber/40 bg-amber/15 text-amber text-[12px]">
              仅 PvE
            </span>
          )}
        </div>
      ) : null}

      {/* 目标 */}
      {detail?.objectives?.length ? (
        <div className="mt-3 pt-3 border-t border-line">
          <ul className="space-y-1 text-[14px] text-[#c9d1d9]">
            {detail.objectives.map((o, i) => (
              <li key={i} className="leading-snug">
                - {o.description}
                {o.count != null && o.count > 0 && (
                  <span className="text-amber">（{o.count}）</span>
                )}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {/* 所需物品：只占一行，放不下的省略 */}
      {items.length > 0 && (
        <div className="mt-3 pt-3 border-t border-line">
          <div className="flex items-center gap-1.5 overflow-hidden">
            {items.slice(0, 8).map((it) => (
              <span
                key={it.id}
                className="inline-flex items-center gap-1 rounded bg-ink-700 border border-line pl-0.5 pr-1.5 py-0.5"
                title={`${it.name}${it.count ? ` ×${it.count}` : ''}`}
              >
                <img
                  src={`/item-icons/${it.id}.webp`}
                  alt=""
                  loading="lazy"
                  className="w-3.5 h-3.5 object-contain"
                />
                <span className="truncate max-w-[110px] text-[14px]">{it.name}</span>
                {it.count != null && it.count > 0 && (
                  <span className="text-amber shrink-0">×{it.count}</span>
                )}
              </span>
            ))}
            {items.length > 8 && (
              <span className="text-[14px] text-muted shrink-0">+{items.length - 8}</span>
            )}
          </div>
        </div>
      )}

      {/* 奖励 */}
      {detail?.rewards?.length ? (
        <div className="mt-3 pt-3 border-t border-line">
          <div className="text-[14px] text-[#c9d1d9]">
            {detail.rewards.map((r, i) => (
              <span key={i}>
                {r.name} ×{r.count}
                {i < detail.rewards.length - 1 ? '、' : ''}
              </span>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  )
}
