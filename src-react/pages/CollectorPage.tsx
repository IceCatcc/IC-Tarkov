import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useStore, useQuestDetail, dedupeItems } from '../store'
import { getCollectorQuestId, getCollectedItems, setItemCollected } from '../tauri'
import { traderDisplayName } from '../traderMeta'
import type { ItemRef } from '../types'

/** 卡片网格间距（px） */
const GAP = 8
/** 卡片宽度下限：窗口再小也不再压缩，超出部分纵向滚动 */
const CARD_MIN = 96
/** 卡片宽度上限：窗口很大时卡片不再无限放大（剩余空间留在右侧/底部） */
const CARD_MAX = 168
/** 卡片高度 = 卡宽 + 固定部分（内边距 + 图标下方间距 + 两行名称） */
const CARD_EXTRA = 38

/** 已收集标记：卡片前覆盖灰色遮罩 + 居中绿色对勾（对勾随卡片尺寸缩放） */
function CollectedMark({ size }: { size: number }) {
  return (
    <span className="absolute inset-0 z-10 grid place-items-center rounded-lg bg-[#8b949e]/40">
      <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden>
        <path
          d="M4 12.5 9.5 18 20 6.5"
          fill="none"
          stroke="#3fb950"
          strokeWidth="2.6"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </span>
  )
}

function ItemCard({
  item,
  collected,
  busy,
  onToggle,
  width,
}: {
  item: ItemRef
  collected: boolean
  busy: boolean
  onToggle: () => void
  /** 当前卡片宽度（由自适应布局算出），用于等比缩放对勾 */
  width: number
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      disabled={busy}
      title={collected ? '点击取消「已收集」' : '点击标记为已收集'}
      className={`relative flex flex-col items-center gap-1.5 p-2 rounded-lg border transition-colors disabled:opacity-60 ${
        collected
          ? 'border-[#2c4a35] bg-ink-800'
          : 'border-line bg-ink-800 hover:border-amber/60'
      }`}
    >
      {/* 图标随卡片宽度等比缩放（正方形），窗口变大时卡片整体铺开 */}
      <img
        src={`/item-icons/${item.id}.webp`}
        alt=""
        loading="lazy"
        className="w-full aspect-square object-contain shrink-0"
      />
      <span className="text-[13px] leading-tight text-center text-[#c9d1d9] line-clamp-2 min-h-[32px]">
        {item.name}
      </span>
      {/* 战局内标记：右下角浅白色圆圈 + 对勾（沿用游戏内 FIR 图标语义），不占布局 */}
      {item.foundInRaid && (
        <span
          className="absolute bottom-1 right-1 z-20 grid place-items-center w-4 h-4 rounded-full border border-[#d7dde5]/70 bg-[#0d1117]/70"
          title="必须在战局内拾取（Found In Raid）"
        >
          <svg width="10" height="10" viewBox="0 0 24 24" aria-hidden>
            <path
              d="M5 12.5 10 18 19 6.5"
              fill="none"
              stroke="#e6edf3"
              strokeWidth="3.2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </span>
      )}
      {collected && (
        <CollectedMark size={Math.round(Math.min(44, Math.max(22, width * 0.3)))} />
      )}
    </button>
  )
}

export function CollectorPage() {
  const playerQuests = useStore((s) => s.playerQuests)
  const unlockedQuests = useStore((s) => s.unlockedQuests)
  const profile = useStore((s) => s.settings.profile)
  const questMode = useStore((s) => s.questMode)
  const collectedItems = useStore((s) => s.collectedItems)
  const setCollectedItems = useStore((s) => s.setCollectedItems)
  const openWiki = useStore((s) => s.openWiki)

  // 收藏家任务 id：由后端从数据集里定位（已知 id 优先，兜底按名称查找）
  const [questId, setQuestId] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [hideCollected, setHideCollected] = useState(false)

  useEffect(() => {
    let alive = true
    getCollectorQuestId()
      .then((id) => {
        if (!alive) return
        setQuestId(id)
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

  // 已收集进度（后端 collected.json 持久化）
  useEffect(() => {
    getCollectedItems()
      .then(setCollectedItems)
      .catch(() => {})
  }, [setCollectedItems])

  // 任务详情（复用全局详情缓存；objectives 里即 44 件收集品）
  const detail = useQuestDetail(questId)

  const items = useMemo(
    () => dedupeItems((detail?.objectives ?? []).flatMap((o) => o.items ?? [])),
    [detail],
  )
  const collectedSet = useMemo(() => new Set(collectedItems), [collectedItems])
  const doneCount = useMemo(
    () => items.filter((it) => collectedSet.has(it.id)).length,
    [items, collectedSet],
  )

  const completedSet = useMemo(() => {
    const s = new Set<string>()
    for (const q of playerQuests) if (q.status === 'completed') s.add(q.questId)
    return s
  }, [playerQuests])
  const unlockedSet = useMemo(() => new Set(unlockedQuests), [unlockedQuests])

  // 前置任务：pve 模式下优先展示 prereqsPve（后端仅在两种模式不同时填充）
  const prereqs = useMemo(() => {
    if (!detail) return []
    const list =
      questMode === 'pve' && detail.prereqsPve?.length
        ? detail.prereqs.map((p) => ({
            ...p,
            hidden: !detail.prereqsPve!.includes(p.id),
          }))
        : detail.prereqs.map((p) => ({ ...p, hidden: false }))
    return list.filter((p) => !p.hidden)
  }, [detail, questMode])

  const toggle = async (id: string) => {
    setBusyId(id)
    setError(null)
    try {
      const all = await setItemCollected(id, !collectedSet.has(id))
      setCollectedItems(all)
    } catch (e) {
      setError(String(e))
    } finally {
      setBusyId(null)
    }
  }

  const shown = useMemo(
    () => items.filter((it) => !hideCollected || !collectedSet.has(it.id)),
    [items, hideCollected, collectedSet],
  )

  // 卡片区可用尺寸（ResizeObserver）：窗口缩放时重新求解列数与卡宽
  const gridRef = useRef<HTMLDivElement>(null)
  const [box, setBox] = useState({ w: 0, h: 0 })
  useLayoutEffect(() => {
    const el = gridRef.current
    if (!el) return
    const measure = () => setBox({ w: el.clientWidth, h: el.clientHeight })
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [items.length > 0])

  // 自适应：宽度方向严格铺满（列宽 = 剩余宽度均分），并尽量让所有卡片在一屏内放下
  const { cols, cw } = useMemo(() => {
    const n = shown.length
    const W = box.w
    const H = box.h
    if (W <= 0 || n === 0) return { cols: 1, cw: CARD_MIN }
    const cwOf = (c: number) => (W - GAP * (c - 1)) / c
    const totalH = (c: number) =>
      Math.ceil(n / c) * (cwOf(c) + CARD_EXTRA + GAP) - GAP

    // 1) 列数从少到多：卡宽递减，取第一个「纵向放得下」的列数 → 卡片最大
    let fit = 0
    for (let c = 1; c <= n; c++) {
      if (cwOf(c) < CARD_MIN) break
      fit = c
      if (totalH(c) <= H) break
    }
    // 2) 卡宽上限：窗口很大时避免单卡被拉得过宽
    const cap = Math.max(1, Math.ceil((W + GAP) / (CARD_MAX + GAP)))
    let cols = Math.max(fit || 1, cap)
    // 3) 窗口过窄：保证卡宽不小于下限，放不下的部分纵向滚动
    const maxForMin = Math.max(1, Math.floor((W + GAP) / (CARD_MIN + GAP)))
    if (cols > maxForMin) cols = maxForMin
    return { cols, cw: cwOf(cols) }
  }, [box.w, box.h, shown.length])

  return (
    <div className="h-full flex flex-col">
      <div className="shrink-0 px-4 pt-4 pb-3 space-y-3">
        {/* 头部：任务名 + 进度 */}
        <div className="flex items-center gap-3 flex-wrap">
          <h1 className="text-[17px] font-medium">收藏家</h1>
          {detail?.wiki && (
            <button
              onClick={() => openWiki(detail.wiki)}
              className="text-[13px] text-amber hover:underline"
              title="在侧边栏打开 Wiki 资料"
            >
              Wiki ↗
            </button>
          )}
          {detail?.minLevel != null && (
            <span className="text-[13px] text-muted">需要 Lv{detail.minLevel}+</span>
          )}
          <span className="ml-auto text-[14px] text-muted">
            已收集{' '}
            <span className="text-ok font-medium">
              {doneCount}/{items.length || '—'}
            </span>
          </span>
          <label className="flex items-center gap-1.5 text-[13px] text-muted cursor-pointer select-none">
            <input
              type="checkbox"
              checked={hideCollected}
              onChange={(e) => setHideCollected(e.target.checked)}
              className="accent-[#ef9f27]"
            />
            隐藏已收集
          </label>
        </div>

        {/* 进度条 */}
        {items.length > 0 && (
          <div className="h-1.5 rounded-full bg-ink-700 overflow-hidden">
            <div
              className="h-full bg-ok transition-all"
              style={{ width: `${(doneCount / items.length) * 100}%` }}
            />
          </div>
        )}

        {error && <div className="text-[14px] text-red-400">{error}</div>}
      </div>

      {/* 卡片区：独占剩余空间，内部按可用宽高求解列数与卡宽 */}
      <div
        ref={gridRef}
        className="flex-1 min-h-0 overflow-y-auto px-4 pb-4"
      >
        {loading && (
          <div className="text-[14px] text-muted py-6">加载收藏家任务…</div>
        )}
        {!loading && !detail && !error && (
          <div className="text-[14px] text-muted py-6">
            未在数据集中找到「收藏家」任务。请在设置页点击「更新数据」后重试。
          </div>
        )}

        {shown.length > 0 && (
          <div
            className="grid"
            style={{
              gap: `${GAP}px`,
              gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`,
            }}
          >
            {shown.map((it) => (
              <ItemCard
                key={it.id}
                item={it}
                collected={collectedSet.has(it.id)}
                busy={busyId === it.id}
                onToggle={() => toggle(it.id)}
                width={cw}
              />
            ))}
          </div>
        )}
      </div>

      {/* 底部：前置任务 + 等级/好感要求（紧凑两行 chip 条） */}
      <div className="shrink-0 border-t border-line bg-ink-800 px-4 py-2 space-y-1 text-[13px]">
        {/* 前置任务 */}
        <div className="flex items-start gap-2 min-w-0">
          <span className="shrink-0 leading-6 text-muted">
            前置
            {prereqs.length > 0 && (
              <span className="ml-1">
                {prereqs.filter((p) => completedSet.has(p.id)).length}/{prereqs.length}
              </span>
            )}
          </span>
          {prereqs.length === 0 ? (
            <span className="leading-6 text-muted">无</span>
          ) : (
            <div className="flex flex-wrap gap-1 min-w-0">
              {prereqs.map((p) => {
                const done = completedSet.has(p.id)
                const unlocked = !done && unlockedSet.has(p.id)
                return (
                  <span
                    key={p.id}
                    title={unlocked ? '已手动解锁' : undefined}
                    className={`inline-flex items-center gap-1 h-6 px-1.5 rounded border ${
                      done
                        ? 'border-[#2a3a31] bg-[#12161a] text-[#6f7f77]'
                        : 'border-line bg-ink-700 text-[#c9d1d9]'
                    }`}
                  >
                    <span className={done ? 'text-ok' : unlocked ? 'text-amber' : 'text-muted'}>
                      {done ? '✓' : unlocked ? '◐' : '○'}
                    </span>
                    {p.name}
                  </span>
                )
              })}
            </div>
          )}
        </div>

        {/* 等级 / 商人好感要求 */}
        <div className="flex items-start gap-2 min-w-0">
          <span className="shrink-0 leading-6 text-muted">要求</span>
          <div className="flex flex-wrap gap-1 min-w-0 items-center">
            {detail?.minLevel != null && (
              <span
                className={`inline-flex items-center h-6 px-1.5 rounded border ${
                  (profile?.level ?? 1) >= detail.minLevel
                    ? 'border-[#2c4a35] bg-[#12161a] text-[#83a291]'
                    : 'border-[#5c2b2b] bg-[#1a1214] text-red-400'
                }`}
                title={`角色等级需 Lv${detail.minLevel}+，当前 Lv${profile?.level ?? 1}`}
              >
                <span className="mr-1">
                  {(profile?.level ?? 1) >= detail.minLevel ? '✓' : '✗'}
                </span>
                Lv{detail.minLevel}+（当前 Lv{profile?.level ?? 1}）
              </span>
            )}
            {!detail?.traderReqs?.length ? (
              detail?.minLevel == null && <span className="text-muted">无商人要求</span>
            ) : (
              detail.traderReqs.map((r) => {
                const cur = profile?.loyalty?.[r.traderId] ?? 1
                const met = cur >= r.value
                const text =
                  r.reqType === 'level'
                    ? `LL${r.value}（当前 LL${cur}）`
                    : r.reqType === 'reputation'
                      ? `好感 ≥${r.value}`
                      : '额外条件'
                return (
                  <span
                    key={`${r.traderId}-${r.reqType}`}
                    className={`inline-flex items-center h-6 px-1.5 rounded border ${
                      r.reqType !== 'level'
                        ? 'border-line bg-ink-700 text-[#c9d1d9]'
                        : met
                          ? 'border-[#2c4a35] bg-[#12161a] text-[#83a291]'
                          : 'border-[#5c2b2b] bg-[#1a1214] text-red-400'
                    }`}
                  >
                    {traderDisplayName(r.traderId, r.traderName)} {text}
                    {r.reqType === 'level' && (
                      <span className="ml-1">{met ? '✓' : '✗'}</span>
                    )}
                  </span>
                )
              })
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
