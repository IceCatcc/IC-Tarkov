import { useEffect, useMemo, useState } from 'react'
import type { MouseEvent as ReactMouseEvent, WheelEvent as ReactWheelEvent } from 'react'
import { useStore } from '../store'
import { getQuestGraph, getQuestDetail, openUrl } from '../tauri'
import type { GraphNode } from '../types'

const COL_W = 250
const ROW_H = 92
const NODE_W = 200
const NODE_H = 64
const BAND_GAP = 48

export function QuestGraphPage() {
  const graph = useStore((s) => s.graph)
  const setGraph = useStore((s) => s.setGraph)
  const playerQuests = useStore((s) => s.playerQuests)
  const selectedId = useStore((s) => s.selectedId)
  const detail = useStore((s) => s.detail)
  const setSelected = useStore((s) => s.setSelected)
  const traderFilter = useStore((s) => s.traderFilterGraph)
  const setTraderFilter = useStore((s) => s.setTraderFilterGraph)
  const search = useStore((s) => s.searchGraph)
  const setSearch = useStore((s) => s.setSearchGraph)

  const [view, setView] = useState({ x: 40, y: 40, scale: 0.7 })
  const [drag, setDrag] = useState<{ x: number; y: number; vx: number; vy: number } | null>(null)

  useEffect(() => {
    if (!graph) getQuestGraph().then(setGraph).catch(console.error)
  }, [graph, setGraph])

  const statusMap = useMemo(() => {
    const m: Record<string, 'in_progress' | 'completed'> = {}
    for (const q of playerQuests) m[q.questId] = q.status
    return m
  }, [playerQuests])

  const traders = useMemo(
    () =>
      Array.from(new Set((graph?.nodes ?? []).map((n) => n.traderName || '未知')))
        .filter(Boolean)
        .sort(),
    [graph],
  )

  // 布局：每个商人一条水平泳道；泳道内按前置深度从左到右分层
  const { positions, visible, width, height, bands } = useMemo(() => {
    if (!graph)
      return {
        positions: {} as Record<string, { x: number; y: number }>,
        visible: new Set<string>(),
        width: 0,
        height: 0,
        bands: [] as { name: string; y: number }[],
      }
    const nodeMap: Record<string, GraphNode> = {}
    for (const n of graph.nodes) nodeMap[n.id] = n

    // 全局深度（最长前置链，带环保护）
    const depthCache: Record<string, number> = {}
    const inStack = new Set<string>()
    const calcDepth = (id: string): number => {
      if (id in depthCache) return depthCache[id]
      const n = nodeMap[id]
      if (!n || n.prereqs.length === 0) {
        depthCache[id] = 0
        return 0
      }
      if (inStack.has(id)) {
        depthCache[id] = 0
        return 0
      }
      inStack.add(id)
      let d = 0
      for (const p of n.prereqs) d = Math.max(d, calcDepth(p) + 1)
      inStack.delete(id)
      depthCache[id] = d
      return d
    }

    let maxDepth = 0
    for (const n of graph.nodes) maxDepth = Math.max(maxDepth, calcDepth(n.id))

    // 可见性过滤
    const q = search.trim().toLowerCase()
    const vis = new Set<string>()
    for (const n of graph.nodes) {
      if (traderFilter && n.traderName !== traderFilter) continue
      if (q && !n.name.toLowerCase().includes(q)) continue
      vis.add(n.id)
    }

    // 按商人分组 → 泳道
    const byTrader: Record<string, string[]> = {}
    for (const n of graph.nodes) {
      if (!vis.has(n.id)) continue
      const key = n.traderName || '未知'
      ;(byTrader[key] ||= []).push(n.id)
    }
    const traderNames = Object.keys(byTrader)
      .sort()
      .filter((name) => traders.includes(name))
    // 把可能遗漏的商人补上（防御）
    for (const name of Object.keys(byTrader)) if (!traderNames.includes(name)) traderNames.push(name)

    const positions: Record<string, { x: number; y: number }> = {}
    const bands: { name: string; y: number }[] = []
    let yCursor = 8
    for (const name of traderNames) {
      const ids = byTrader[name]
      bands.push({ name, y: yCursor })
      let innerY = yCursor + 28 // 泳道标签占一行高度
      const cols: Record<number, string[]> = {}
      let maxRowsInBand = 0
      for (const id of ids) {
        const d = depthCache[id]
        ;(cols[d] ||= []).push(id)
      }
      for (const dStr of Object.keys(cols)) {
        const d = Number(dStr)
        const colIds = cols[d].sort((a, b) =>
          (nodeMap[a]?.name ?? '').localeCompare(nodeMap[b]?.name ?? ''),
        )
        colIds.forEach((id, i) => {
          positions[id] = { x: d * COL_W + 20, y: innerY + i * ROW_H }
        })
        maxRowsInBand = Math.max(maxRowsInBand, colIds.length)
      }
      yCursor = innerY + maxRowsInBand * ROW_H + BAND_GAP
    }

    return {
      positions,
      visible: vis,
      width: (maxDepth + 1) * COL_W + 40,
      height: Math.max(yCursor, 100),
      bands,
    }
  }, [graph, traderFilter, search, traders])

  const edges = useMemo(() => {
    if (!graph) return []
    return graph.edges
      .filter((e) => visible.has(e.from) && visible.has(e.to))
      .map((e) => {
        const a = positions[e.from]
        const b = positions[e.to]
        return {
          id: `${e.from}->${e.to}`,
          x1: a.x + NODE_W,
          y1: a.y + NODE_H / 2,
          x2: b.x,
          y2: b.y + NODE_H / 2,
        }
      })
  }, [graph, visible, positions])

  const onWheel = (e: ReactWheelEvent) => {
    e.preventDefault()
    setView((v) => {
      const factor = e.deltaY < 0 ? 1.1 : 0.9
      const ns = Math.min(2, Math.max(0.2, v.scale * factor))
      return { ...v, scale: ns }
    })
  }
  const onMouseDown = (e: ReactMouseEvent) => {
    setDrag({ x: e.clientX, y: e.clientY, vx: view.x, vy: view.y })
  }
  const onMouseMove = (e: ReactMouseEvent) => {
    if (!drag) return
    setView((v) => ({ ...v, x: drag.vx + (e.clientX - drag.x), y: drag.vy + (e.clientY - drag.y) }))
  }
  const onMouseUp = () => setDrag(null)

  const select = (id: string) => {
    setSelected(id, null)
    getQuestDetail(id)
      .then((d) => setSelected(id, d ?? null))
      .catch(() => setSelected(id, null))
  }

  if (!graph) {
    return <div className="p-6 text-muted text-[13px]">加载任务图谱…</div>
  }

  return (
    <div className="h-full flex flex-col relative">
      {/* 工具栏 */}
      <div className="h-11 shrink-0 flex items-center gap-2 px-4 bg-ink-800 border-b border-line relative z-30">
        <span className="text-[12px] text-muted">商人</span>
        <select
          value={traderFilter}
          onChange={(e) => setTraderFilter(e.target.value)}
          className="bg-ink-700 border border-line text-[12px] rounded px-2 py-1 text-[#e6edf3]"
        >
          <option value="">全部商人</option>
          {traders.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="搜索任务名…"
          className="bg-ink-700 border border-line text-[12px] rounded px-2 py-1 text-[#e6edf3] w-48 placeholder:text-muted"
        />
        <span className="text-[11px] text-muted ml-2">共 {visible.size} 个任务</span>
        <div className="ml-auto flex items-center gap-3 text-[11px]">
          <span className="flex items-center gap-1">
            <span className="w-3 h-3 rounded bg-blue border border-blue" /> 进行中
          </span>
          <span className="flex items-center gap-1">
            <span className="w-3 h-3 rounded bg-[#1b1f24] border border-done" /> 已完成
          </span>
          <span className="flex items-center gap-1">
            <span className="w-3 h-3 rounded bg-ink-800 border border-line" /> 未接取
          </span>
          <button
            onClick={() => setView({ x: 40, y: 40, scale: 0.7 })}
            className="px-2 py-1 rounded border border-line text-[#e6edf3] hover:bg-ink-700"
          >
            重置视图
          </button>
        </div>
      </div>

      {/* 画布（relative 确保内部绝对定位内容被裁剪在本区域内，不再穿透到工具栏） */}
      <div
        className="relative flex-1 min-h-0 overflow-hidden bg-ink-900 cursor-grab active:cursor-grabbing"
        onWheel={onWheel}
        onMouseDown={onMouseDown}
        onMouseMove={onMouseMove}
        onMouseUp={onMouseUp}
        onMouseLeave={onMouseUp}
      >
        <div
          className="absolute left-0 top-0 origin-top-left"
          style={{
            transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})`,
            width,
            height,
          }}
        >
          <svg className="absolute left-0 top-0 pointer-events-none" width={width} height={height}>
            {edges.map((e) => (
              <line
                key={e.id}
                x1={e.x1}
                y1={e.y1}
                x2={e.x2}
                y2={e.y2}
                stroke="#30363d"
                strokeWidth={1.2}
              />
            ))}
          </svg>

          {/* 商人泳道标签 */}
          {bands.map((b) => (
            <div
              key={b.name}
              className="absolute text-[13px] font-medium text-amber/90 tracking-wide select-none"
              style={{ left: 22, top: b.y }}
            >
              {b.name}
            </div>
          ))}

          {graph.nodes
            .filter((n) => visible.has(n.id))
            .map((n) => {
              const pos = positions[n.id]
              if (!pos) return null
              const st = statusMap[n.id]
              const selected = selectedId === n.id
              const cls =
                st === 'completed'
                  ? 'bg-[#1b1f24] border-done text-muted'
                  : st === 'in_progress'
                    ? 'bg-blue-soft border-blue text-[#cfe3ff]'
                    : 'bg-ink-800 border-line text-[#c9d1d9]'
              return (
                <div
                  key={n.id}
                  onClick={(e) => {
                    e.stopPropagation()
                    select(n.id)
                  }}
                  onMouseDown={(e) => e.stopPropagation()}
                  className={`absolute rounded-lg border px-3 py-2 cursor-pointer hover:border-amber text-[12px] ${cls} ${
                    selected ? 'ring-2 ring-amber' : ''
                  }`}
                  style={{ left: pos.x, top: pos.y, width: NODE_W, minHeight: NODE_H }}
                >
                  <div className="font-medium leading-tight truncate">{n.name}</div>
                  <div className="text-[10px] opacity-70 mt-0.5 truncate">
                    {n.minLevel ? `Lv${n.minLevel}` : ''}
                  </div>
                </div>
              )
            })}
        </div>

        {/* 概览面板（点击节点后显示）—— 阻止事件穿透到画布拖拽/缩放 */}
        {selectedId && (
          <div
            onMouseDown={(e) => e.stopPropagation()}
            onWheel={(e) => e.stopPropagation()}
            className="absolute right-3 top-3 w-[300px] max-h-[85%] overflow-y-auto bg-ink-800 border border-line rounded-xl p-4 shadow-xl z-40 cursor-default"
          >
            <button
              onClick={(e) => {
                e.stopPropagation()
                setSelected(null, null)
              }}
              className="absolute right-3 top-3 text-muted hover:text-[#e6edf3] text-[12px]"
            >
              ✕
            </button>
            {detail ? (
              <>
                <div className="text-[15px] font-medium pr-6">{detail.name}</div>
                <div className="text-[11px] text-muted mt-1">
                  商人 {detail.traderName}
                  {detail.minLevel ? ` · 最低等级 ${detail.minLevel}` : ''}
                  {statusMap[detail.id]
                    ? ` · ${statusMap[detail.id] === 'completed' ? '已完成' : '进行中'}`
                    : ''}
                </div>

                {detail.objectives.length > 0 && (
                  <div className="mt-3">
                    <div className="text-[11px] text-muted mb-1">目标</div>
                    <ul className="list-disc list-inside text-[12px] text-[#c9d1d9] space-y-1">
                      {detail.objectives.map((o, i) => (
                        <li key={i}>{o}</li>
                      ))}
                    </ul>
                  </div>
                )}

                {detail.rewards.length > 0 && (
                  <div className="mt-3">
                    <div className="text-[11px] text-muted mb-1">奖励</div>
                    <div className="text-[12px] text-[#c9d1d9]">
                      {detail.rewards.map((r, i) => (
                        <span key={i}>
                          {r.name} ×{r.count}
                          {i < detail.rewards.length - 1 ? '、' : ''}
                        </span>
                      ))}
                    </div>
                  </div>
                )}

                {detail.prereqs.length > 0 && (
                  <div className="mt-3">
                    <div className="text-[11px] text-muted mb-1">前置任务</div>
                    <div className="text-[12px] text-[#c9d1d9] space-y-0.5">
                      {detail.prereqs.map((p) => (
                        <div key={p.id} className="truncate">
                          · {p.name}
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                <button
                  onClick={(e) => {
                    e.stopPropagation()
                    openUrl(detail.wiki)
                  }}
                  className="mt-4 w-full text-center text-[12px] text-amber border border-amber rounded py-1.5 hover:bg-amber-soft"
                >
                  打开 Wiki ↗
                </button>
              </>
            ) : (
              <div className="text-[12px] text-muted">加载中…</div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
