import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { MouseEvent as ReactMouseEvent, WheelEvent as ReactWheelEvent } from 'react'
import { useStore } from '../store'
import { getQuestGraph, getQuestDetail } from '../tauri'
import { traderImage } from '../traderImages'
import { TRADER_UNLOCK_QUEST, traderDisplayName } from '../traderMeta'
import type { GraphNode, ItemRef } from '../types'


const ROW_H = 104
const NODE_W = 204
const NODE_H = 78
const BAND_GAP = 26

// 网格布局常量（布局与绘制共用）
const SUB_G = 10 // 小列间距
const ZONE_PAD_IN = 20 // 大列内边距
const ROWS_CAP = 3 // 每个小列的最大行数（超出则开新小列，行数永久封顶）
const GRID_TOP = 38 // 顶部等级标尺高度（屏幕像素）
const BAND_X = 78 // 网格整体右移量：左侧为外置商人头像的固定屏幕沟槽
const TOP_GAP = 14 // 泳道顶边到第一行卡片的间距

type NodeState = 'completed' | 'in_progress' | 'available' | 'locked'

// 头像条排最后面的商人（竞技场裁判、BTR 司机）
const BAR_LAST_TRADERS = ['6617beeaa9cfa777ca915b7c', '656f0f98d80a697f855d34b1']

// 视口边界留白（屏幕像素）
const VIEW_PAD = 48

// 视口边界钳制：世界内容不允许被移出「边界 + VIEW_PAD」范围；内容小于视口时居中
function clampView(
  v: { scale: number; x: number; y: number },
  width: number,
  height: number,
  cw: number,
  ch: number,
): { x: number; y: number } {
  const minX = cw - VIEW_PAD - width * v.scale
  const maxX = VIEW_PAD
  const minY = ch - VIEW_PAD - height * v.scale
  const maxY = VIEW_PAD
  return {
    x: minX > maxX ? (minX + maxX) / 2 : Math.min(maxX, Math.max(minX, v.x)),
    y: minY > maxY ? (minY + maxY) / 2 : Math.min(maxY, Math.max(minY, v.y)),
  }
}

// —— Canvas 调色板（与原 DOM 版一致）——
const STATE_STYLE: Record<NodeState, { bg: string; border: string; text: string }> = {
  completed: { bg: '#14261b', border: '#2ea043', text: '#86e29b' },
  in_progress: { bg: '#0e2438', border: '#58a6ff', text: '#a8d1ff' },
  available: { bg: '#2b2310', border: '#ef9f27', text: '#ffd08a' },
  locked: { bg: '#131920', border: '#30363d', text: '#8b949e' },
}
const SPECIAL_BORDER = '#a371f7'

// —— 图片缓存（本地图标，异步加载完成后随下一帧自动出现）——
const imgCache = new Map<string, HTMLImageElement>()
function getImage(src: string): HTMLImageElement {
  let im = imgCache.get(src)
  if (!im) {
    im = new Image()
    im.src = src
    imgCache.set(src, im)
  }
  return im
}
function imgReady(im: HTMLImageElement): boolean {
  return im.complete && im.naturalWidth > 0
}

function rr(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
) {
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.arcTo(x + w, y, x + w, y + h, r)
  ctx.arcTo(x + w, y + h, x, y + h, r)
  ctx.arcTo(x, y + h, x, y, r)
  ctx.arcTo(x, y, x + w, y, r)
  ctx.closePath()
}

function truncateText(ctx: CanvasRenderingContext2D, text: string, maxW: number): string {
  if (ctx.measureText(text).width <= maxW) return text
  let s = text
  while (s.length > 1 && ctx.measureText(s + '…').width > maxW) s = s.slice(0, -1)
  return s + '…'
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

// 地图展示名：后端已由缓存 map_meta.json 解析为官方中文（node.mapName）
function mapLabel(n: GraphNode): string {
  return n.mapName || n.map || ''
}

export function QuestGraphPage() {
  const graph = useStore((s) => s.graph)
  const setGraph = useStore((s) => s.setGraph)
  const playerQuests = useStore((s) => s.playerQuests)
  const selectedId = useStore((s) => s.selectedId)
  const detail = useStore((s) => s.detail)
  const setSelected = useStore((s) => s.setSelected)
  const search = useStore((s) => s.searchGraph)
  const setSearch = useStore((s) => s.setSearchGraph)
  const disabledTraders = useStore((s) => s.disabledTradersGraph)
  const toggleTrader = useStore((s) => s.toggleTraderGraph)
  const mapSel = useStore((s) => s.mapSelGraph)
  const setMapSel = useStore((s) => s.setMapSelGraph)
  const openWiki = useStore((s) => s.openWiki)
  const hideLegacy = useStore((s) => s.hideLegacyGraph)
  const setHideLegacy = useStore((s) => s.setHideLegacyGraph)
  const repMet = useStore((s) => s.repMetGraph)
  const setRepMet = useStore((s) => s.setRepMetGraph)
  const lvlMet = useStore((s) => s.lvlMetGraph)
  const setLvlMet = useStore((s) => s.setLvlMetGraph)
  const profile = useStore((s) => s.settings.profile)
  const focusMode = useStore((s) => s.focusGraph)
  const setFocusMode = useStore((s) => s.setFocusGraph)

  const [view, setView] = useState({ x: 30, y: 30, scale: 0.65 })
  const dragRef = useRef<{ sx: number; sy: number; vx: number; vy: number; moved: boolean } | null>(
    null,
  )
  // 悬浮目标：仅在变化时写入 state，避免 mousemove 高频重渲染
  const [hover, setHover] = useState<{ id: string; icon: number } | null>(null)
  const [tipXY, setTipXY] = useState<{ x: number; y: number } | null>(null)
  const [cursor, setCursor] = useState<'grab' | 'grabbing' | 'pointer'>('grab')
  const [, setImgTick] = useState(0) // 图片加载完成时触发一次重绘

  const canvasRef = useRef<HTMLCanvasElement>(null)
  const miniRef = useRef<HTMLCanvasElement>(null)
  const miniDragRef = useRef(false)
  // rAF 每帧绘制函数句柄（必须在早退 return 之前声明，保证 Hooks 顺序稳定）
  const frameRef = useRef<() => void>(() => {})
  const [csize, setCsize] = useState({ w: 0, h: 0 })

  // 持续 rAF 绘制循环（硬件加速合成，单画布 ~2000 图元 ≈1ms/帧）。
  // 必须与其它 Hooks 一样位于条件 return 之前，否则触发 Hooks 顺序错误。
  useEffect(() => {
    let raf = 0
    const loop = () => {
      frameRef.current()
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [])

  useEffect(() => {
    const el = canvasRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setCsize({ w: el.clientWidth, h: el.clientHeight }))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // 画布物理像素尺寸跟随容器与 DPR
  useEffect(() => {
    const dpr = window.devicePixelRatio || 1
    const cv = canvasRef.current
    if (cv && csize.w > 0) {
      cv.width = Math.round(csize.w * dpr)
      cv.height = Math.round(csize.h * dpr)
    }
    setImgTick((t) => t + 1)
  }, [csize])

  useEffect(() => {
    if (!graph) getQuestGraph().then(setGraph).catch(console.error)
  }, [graph, setGraph])

  // 玩家状态
  const { statusMap, completedSet } = useMemo(() => {
    const sm: Record<string, 'in_progress' | 'completed'> = {}
    const cs = new Set<string>()
    for (const q of playerQuests) {
      sm[q.questId] = q.status
      if (q.status === 'completed') cs.add(q.questId)
    }
    return { statusMap: sm, completedSet: cs }
  }, [playerQuests])

  const classify = (n: GraphNode): NodeState => {
    const st = statusMap[n.id]
    if (st === 'completed') return 'completed'
    if (st === 'in_progress') return 'in_progress'
    if (n.prereqs.every((p) => completedSet.has(p))) return 'available'
    return 'locked'
  }

  // 商人头像条数据（竞技场/BTR 排最后）
  const traderBar = useMemo(() => {
    const m = new Map<string, string>()
    for (const n of graph?.nodes ?? []) {
      if (!m.has(n.traderId)) m.set(n.traderId || 'unknown', n.traderName || '未知')
    }
    return Array.from(m.entries())
      .map(([id, name]) => ({ id, name }))
      .sort((a, b) => {
        const ia = BAR_LAST_TRADERS.indexOf(a.id)
        const ib = BAR_LAST_TRADERS.indexOf(b.id)
        if (ia >= 0 || ib >= 0) {
          if (ia >= 0 && ib >= 0) return ia - ib
          return ia >= 0 ? 1 : -1
        }
        return traderDisplayName(a.id, a.name).localeCompare(traderDisplayName(b.id, b.name))
      })
  }, [graph])

  // —— 过滤 + 聚焦 + 布局（商人泳道 / 等级分区网格 / 轨道复用）——
  const { positions, visible, width, height, bands, zones } = useMemo(() => {
    const empty = {
      positions: {} as Record<string, { x: number; y: number }>,
      visible: new Set<string>(),
      width: 0,
      height: 0,
      bands: [] as { id: string; name: string; y: number; h: number }[],
      zones: [] as { left: number; right: number; label: string; subs: number[] }[],
    }
    if (!graph) return empty
    const nodeMap: Record<string, GraphNode> = {}
    for (const n of graph.nodes) nodeMap[n.id] = n

    const q = search.trim().toLowerCase()
    const vis = new Set<string>()
    for (const n of graph.nodes) {
      if (hideLegacy && n.legacy) continue
      if (disabledTraders[n.traderId]) continue
      // 地图单选筛选：非空时仅显示命中地图的任务（__none__=未指定）
      if (mapSel && (n.map ?? '__none__') !== mapSel) continue
      if (q && !n.name.toLowerCase().includes(q)) continue
      vis.add(n.id)
    }

    // 按名称搜索时无视好感和等级、前置筛选
    if (!q && (lvlMet || repMet)) {
      for (const n of graph.nodes) {
        if (!vis.has(n.id)) continue
        const ll = profile?.loyalty?.[n.traderId] ?? 1
        if (repMet && ll === 0) {
          vis.delete(n.id)
          continue
        }
        if (lvlMet && (n.minLevel ?? 1) > Math.max(1, profile?.level ?? 1)) {
          vis.delete(n.id)
          continue
        }
        if (repMet) {
          for (const r of n.traderReqs ?? []) {
            if (r.reqType === 'level' && (profile?.loyalty?.[r.traderId] ?? 1) < r.value) {
              vis.delete(n.id)
              break
            }
          }
        }
      }
    }

    // 只看可达：玩家状态节点 ∪ 可接取 ∪ 其下游一级（搜索时忽略）
    if (!q && focusMode) {
      const keep = new Set<string>()
      const frontier: string[] = []
      for (const n of graph.nodes) {
        if (!vis.has(n.id)) continue
        if (statusMap[n.id]) {
          keep.add(n.id)
          if (statusMap[n.id] !== 'completed') frontier.push(n.id)
        } else if (n.prereqs.length > 0 && n.prereqs.every((p) => completedSet.has(p))) {
          keep.add(n.id)
          frontier.push(n.id)
        }
      }
      vis.clear()
      for (const id of keep) vis.add(id)

      const succ = new Map<string, string[]>()
      for (const e of graph.edges) {
        if (!keep.has(e.from)) continue
        ;(succ.get(e.from) ?? succ.set(e.from, []).get(e.from)!).push(e.to)
      }
      for (const a of frontier) {
        for (const t of succ.get(a) ?? []) {
          if (!vis.has(t)) vis.add(t)
        }
      }
    }

    // —— 分区分配：以解锁等级为基准，拓扑松弛保证「前置分区 < 后继分区」（含商人解锁隐性边），
    //     松弛产生的稀疏整数稠密化为连续分区号，消除大量空置区域 ——
    const colOf = new Map<string, number>()
    for (const id of vis) {
      const lv = nodeMap[id]?.minLevel ?? 1
      colOf.set(id, Math.max(0, (lv < 1 ? 1 : lv) - 1))
    }
    // 隐性依赖：商人由任务 A 解锁时，该商人的任务必须排在 A 右侧
    const extraEdges: [string, string][] = []
    for (const n of graph.nodes) {
      if (!vis.has(n.id)) continue
      const uq = TRADER_UNLOCK_QUEST[n.traderId]
      if (uq && uq !== n.id && vis.has(uq)) extraEdges.push([uq, n.id])
    }
    for (let iter = 0; iter < 300; iter++) {
      let changed = false
      const relax = (from: string, to: string) => {
        if (!vis.has(from) || !vis.has(to)) return
        const cf = colOf.get(from)!
        const ct = colOf.get(to)!
        if (ct <= cf) {
          colOf.set(to, cf + 1)
          changed = true
        }
      }
      for (const e of graph.edges) relax(e.from, e.to)
      for (const [from, to] of extraEdges) relax(from, to)
      if (!changed) break
    }

    // 分区桶：同分区内按忠诚等级要求升序 -> 名称排序（LL 影响区内次序与轨道先后）
    const buckets = new Map<number, { id: string; ll: number; lvReal: number }[]>()
    for (const n of graph.nodes) {
      if (!vis.has(n.id)) continue
      const key = colOf.get(n.id)!
      const ll =
        Math.max(0, ...(n.traderReqs ?? []).filter((r) => r.reqType === 'level').map((r) => r.value)) || 0
      let b = buckets.get(key)
      if (!b) {
        b = []
        buckets.set(key, b)
      }
      b.push({ id: n.id, ll, lvReal: n.minLevel ?? 1 })
    }
    const zoneKeys = Array.from(buckets.keys()).sort((a, b) => a - b)
    const repLv = new Map<number, number>() // 稠密分区号 -> 代表性解锁等级
    zoneKeys.forEach((k, i) => {
      repLv.set(i, Math.min(...buckets.get(k)!.map((x) => x.lvReal)))
    })

    // 全局任务序列：分区升序 -> 忠诚等级要求升序 -> 名称
    interface SeqItem {
      id: string
      R: number
    }
    const seq: SeqItem[] = []
    const seqIdxOf = new Map<string, number>()
    for (let r = 0; r < zoneKeys.length; r++) {
      const items = buckets.get(zoneKeys[r])!
      items.sort(
        (a, b) =>
          a.ll - b.ll ||
          (nodeMap[a.id]?.name ?? '').localeCompare(nodeMap[b.id]?.name ?? ''),
      )
      for (const it of items) {
        seqIdxOf.set(it.id, seq.length)
        seq.push({ id: it.id, R: r })
      }
    }
    const ROf = new Map<string, number>()
    for (const s of seq) ROf.set(s.id, s.R)

    // —— 网格几何：每个等级一个大列；列内「无限小列」；
    //     小列内最多堆叠 ROWS_CAP 张卡，超出则换下一小列 —— 行数被永久封顶，
    //     数量再多的同等级任务也只会向右扩展，而不是把第一列挤成一根长柱。
    interface Group {
      id: string
      name: string
      ids: string[]
    }
    const groups = new Map<string, Group>()
    for (const n of graph.nodes) {
      if (!vis.has(n.id)) continue
      const key = n.traderId || n.traderName || 'unknown'
      let g = groups.get(key)
      if (!g) {
        g = { id: key, name: n.traderName || '未知', ids: [] }
        groups.set(key, g)
      }
      g.ids.push(n.id)
    }

    // (商人, 分区) -> 卡片数 -> 各分区需要的小列数取各商人最大值
    const subColsOf = new Map<number, number>() // 分区号 -> 大列的小列数
    {
      const perPair = new Map<string, number>()
      for (const n of graph.nodes) {
        if (!vis.has(n.id)) continue
        const bid = n.traderId || 'unknown'
        const key = `${bid}|${ROf.get(n.id)}`
        perPair.set(key, (perPair.get(key) ?? 0) + 1)
      }
      for (const [key, c] of perPair) {
        const r = Number(key.split('|')[1])
        const sc = Math.ceil(c / ROWS_CAP)
        subColsOf.set(r, Math.max(subColsOf.get(r) ?? 1, sc))
      }
    }

    const zoneLeft = new Map<number, number>()
    const zones: { left: number; right: number; label: string; subs: number[] }[] = []
    {
      // 网格整体右移，给外置商人头像列留出屏幕固定宽度的空白沟槽
      let acc = BAND_X
      for (let r = 0; r < zoneKeys.length; r++) {
        zoneLeft.set(r, acc)
        const sc = subColsOf.get(r) ?? 1
        const w = ZONE_PAD_IN * 2 + sc * NODE_W + (sc - 1) * SUB_G
        const subs: number[] = []
        for (let j = 1; j < sc; j++) {
          subs.push(acc + ZONE_PAD_IN + j * NODE_W + (j - 0.5) * SUB_G)
        }
        zones.push({ left: acc, right: acc + w, label: `Lv${repLv.get(r)}+`, subs })
        acc += w
      }
    }

    const positions: Record<string, { x: number; y: number }> = {}
    const bandsOut: { id: string; name: string; y: number; h: number }[] = []

    const sortedGroups = Array.from(groups.values()).sort((a, b) =>
      a.name.localeCompare(b.name),
    )

    let yCursor = GRID_TOP
    for (const g of sortedGroups) {
      bandsOut.push({ id: g.id, name: g.name, y: yCursor, h: 0 })
      const innerY = yCursor + TOP_GAP

      // 该商人的任务按全局序列顺序填充网格：先纵向占满小列的 ROWS_CAP 行，再开新小列
      const bandTasks = g.ids
        .filter((id) => ROf.has(id))
        .sort((a, b) => seqIdxOf.get(a)! - seqIdxOf.get(b)!)

      const cntByR = new Map<number, number>()
      let maxRowUsed = 1
      for (const id of bandTasks) {
        const R = ROf.get(id)!
        const k = cntByR.get(R) ?? 0
        cntByR.set(R, k + 1)
        const sub = Math.floor(k / ROWS_CAP)
        const rowLocal = k % ROWS_CAP
        positions[id] = {
          x: zoneLeft.get(R)! + ZONE_PAD_IN + sub * (NODE_W + SUB_G),
          y: innerY + rowLocal * ROW_H,
        }
        maxRowUsed = Math.max(maxRowUsed, rowLocal + 1)
      }

      const bandH = TOP_GAP + maxRowUsed * ROW_H
      bandsOut[bandsOut.length - 1].h = bandH
      yCursor += bandH + BAND_GAP
    }

    // 实际内容包围盒（缩略图/钳制用；宽度至少覆盖完整等级网格）
    let boundW = 200
    let boundH = 100
    for (const p of Object.values(positions)) {
      boundW = Math.max(boundW, p.x + NODE_W + 26)
      boundH = Math.max(boundH, p.y + NODE_H + 14)
    }
    if (zones.length > 0) {
      boundW = Math.max(boundW, zones[zones.length - 1].right + 8)
      boundH = Math.max(boundH, yCursor)
    }

    return {
      positions,
      visible: vis,
      width: boundW,
      height: boundH,
      bands: bandsOut,
      zones,
    }
  }, [graph, disabledTraders, mapSel, search, hideLegacy, focusMode, repMet, lvlMet, profile, statusMap, completedSet])

  // 缩略图尺寸：按世界包围盒宽高比动态确定（最长边固定，含上下限）
  const MINI_LONG = 250
  const miniDim = useMemo(() => {
    if (width <= 0 || height <= 0) return { w: 220, h: 150 }
    const ratio = height / width
    let w: number
    let h: number
    if (ratio <= 1) {
      w = MINI_LONG
      h = Math.round(MINI_LONG * ratio)
    } else {
      h = MINI_LONG
      w = Math.round(MINI_LONG / ratio)
    }
    w = Math.max(96, Math.min(300, w))
    h = Math.max(80, Math.min(320, h))
    return { w, h }
  }, [width, height])

  const edges = useMemo(() => {
    if (!graph) return []
    const out: {
      id: string
      x1: number
      y1: number
      x2: number
      y2: number
      doneEdge: boolean
    }[] = []
    for (const e of graph.edges) {
      if (!visible.has(e.from) || !visible.has(e.to)) continue
      const a = positions[e.from]
      const b = positions[e.to]
      if (!a || !b) continue
      out.push({
        id: `${e.from}->${e.to}`,
        x1: a.x + NODE_W,
        y1: a.y + NODE_H / 2,
        x2: b.x,
        y2: b.y + NODE_H / 2,
        doneEdge: statusMap[e.from] === 'completed',
      })
    }
    return out
  }, [graph, visible, positions, statusMap])

  // 节点状态表（世界绘制与拾取共用）
  const nodeStates = useMemo(() => {
    const m: Record<string, NodeState> = {}
    if (!graph) return m
    for (const n of graph.nodes) {
      if (!visible.has(n.id) || !positions[n.id]) continue
      m[n.id] = classify(n)
    }
    return m
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [graph, visible, positions, statusMap, completedSet])

  // 地图筛选选项（图谱中出现的所有地图 + 未指定）
  const mapOptions = useMemo(() => {
    const m = new Map<string, string>()
    let hasNone = false
    for (const n of graph?.nodes ?? []) {
      if (!n.map) {
        hasNone = true
        continue
      }
      if (!m.has(n.map)) m.set(n.map, mapLabel(n))
    }
    const list = Array.from(m.entries())
      .map(([id, label]) => ({ id, label }))
      .sort((a, b) => a.label.localeCompare(b.label, 'zh'))
    if (hasNone) list.push({ id: '__none__', label: '未指定' })
    return list
  }, [graph])

  const select = useCallback(
    (id: string) => {
      setSelected(id, null)
      getQuestDetail(id)
        .then((d) => setSelected(id, d ?? null))
        .catch(() => setSelected(id, null))
    },
    [setSelected],
  )

  // —— 命中测试 ——
  const hitTest = (wx: number, wy: number): GraphNode | null => {
    if (!graph) return null
    const ns = graph.nodes
    for (let i = ns.length - 1; i >= 0; i--) {
      const n = ns[i]
      if (!visible.has(n.id)) continue
      const p = positions[n.id]
      if (!p) continue
      if (wx >= p.x && wx <= p.x + NODE_W && wy >= p.y && wy <= p.y + NODE_H) return n
    }
    return null
  }

  const screenToWorld = (clientX: number, clientY: number, el: HTMLElement) => {
    const rect = el.getBoundingClientRect()
    return { wx: (clientX - rect.left - view.x) / view.scale, wy: (clientY - rect.top - view.y) / view.scale }
  }

  const onMouseDown = (e: ReactMouseEvent<HTMLDivElement>) => {
    dragRef.current = { sx: e.clientX, sy: e.clientY, vx: view.x, vy: view.y, moved: false }
    setCursor('grabbing')
  }
  const onMouseMove = (e: ReactMouseEvent<HTMLDivElement>) => {
    const d = dragRef.current
    if (d) {
      const dx = e.clientX - d.sx
      const dy = e.clientY - d.sy
      if (Math.abs(dx) > 3 || Math.abs(dy) > 3) d.moved = true
      setView((v) => ({
        ...v,
        ...clampView({ scale: v.scale, x: d.vx + dx, y: d.vy + dy }, width, height, csize.w, csize.h),
      }))
      return
    }
    // 悬浮命中（仅状态变化时更新 React state）
    const el = canvasRef.current
    if (!el) return
    const { wx, wy } = screenToWorld(e.clientX, e.clientY, el)
    const n = hitTest(wx, wy)
    let next: { id: string; icon: number } | null = null
    if (n) {
      const p = positions[n.id]!
      const relY = wy - p.y
      if (relY >= NODE_H - 32 && relY <= NODE_H - 6) {
        const idx = Math.floor((wx - (p.x + 10)) / 26)
        const items = dedupeItems(n.turnIns ?? [])
        if (idx >= 0 && idx < items.length) next = { id: n.id, icon: idx }
      }
      if (!next) next = { id: n.id, icon: -1 }
    }
    setHover((prev) =>
      prev?.id === next?.id && prev?.icon === next?.icon ? prev : next,
    )
    const rect2 = e.currentTarget.getBoundingClientRect()
    setTipXY(next ? { x: e.clientX - rect2.left, y: e.clientY - rect2.top } : null)
    setCursor(next ? 'pointer' : 'grab')
  }
  const onMouseUp = (e: ReactMouseEvent<HTMLDivElement>) => {
    const d = dragRef.current
    dragRef.current = null
    setCursor(hover ? 'pointer' : 'grab')
    if (d && !d.moved) {
      const el = canvasRef.current
      if (!el) return
      const { wx, wy } = screenToWorld(e.clientX, e.clientY, el)
      const n = hitTest(wx, wy)
      if (n) select(n.id)
    }
  }
  const onMouseLeave = () => {
    dragRef.current = null
    setHover(null)
    setCursor('grab')
  }

  // 以鼠标位置为锚点缩放
  const onWheel = (e: ReactWheelEvent<HTMLDivElement>) => {
    e.preventDefault()
    const rect = e.currentTarget.getBoundingClientRect()
    const mx = e.clientX - rect.left
    const my = e.clientY - rect.top
    setView((v) => {
      const factor = e.deltaY < 0 ? 1.12 : 0.9
      const ns = Math.min(2, Math.max(0.12, v.scale * factor))
      if (ns === v.scale) return v
      const nx = mx - ((mx - v.x) / v.scale) * ns
      const ny = my - ((my - v.y) / v.scale) * ns
      const c = clampView({ scale: ns, x: nx, y: ny }, width, height, csize.w, csize.h)
      return { scale: ns, ...c }
    })
  }

  // —— 缩略图交互 ——
  const miniJump = (e: ReactMouseEvent<HTMLDivElement>) => {
    if (width <= 0 || height <= 0) return
    const rect = e.currentTarget.getBoundingClientRect()
    const pad = 8
    const k = Math.min((rect.width - pad * 2) / width, (rect.height - pad * 2) / height)
    const fx = (e.clientX - rect.left - pad) / k
    const fy = (e.clientY - rect.top - pad) / k
    setView((v) => {
      const c = clampView(
        { scale: v.scale, x: csize.w / 2 - fx * v.scale, y: csize.h / 2 - fy * v.scale },
        width,
        height,
        csize.w,
        csize.h,
      )
      return { ...v, ...c }
    })
  }

  if (!graph) {
    return <div className="p-6 text-muted text-[13px]">加载任务图谱…</div>
  }

  const selectedNode = selectedId ? (graph.nodes.find((n) => n.id === selectedId) ?? null) : null
  const selAvatar = traderImage(selectedNode?.traderId)

  const chip =
    'px-2.5 py-1 rounded-full text-[12px] border transition-colors whitespace-nowrap'
  const chipOff = 'bg-ink-800 border-line text-muted hover:text-[#e6edf3]'
  const checkLabel =
    'flex items-center gap-1.5 text-[12px] text-muted cursor-pointer select-none whitespace-nowrap [&>input]:accent-[#ef9f27]'

  // 悬浮 tooltip 数据
  const hoverTip = (() => {
    if (!hover || hover.icon < 0) return null
    const n = graph.nodes.find((x) => x.id === hover.id)
    if (!n) return null
    const it = dedupeItems(n.turnIns ?? [])[hover.icon]
    if (!it) return null
    return it
  })()

  // 每帧绘制函数（rAF 循环读取 ref，避免闭包过期）
  frameRef.current = () => {
    const cv = canvasRef.current
    if (!cv || csize.w <= 0) return
    const ctx = cv.getContext('2d')!
    const dpr = window.devicePixelRatio || 1
    const loyalty = profile?.loyalty ?? {}

    // ===== 主画布 =====
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, csize.w, csize.h)
    ctx.imageSmoothingEnabled = true
    ctx.imageSmoothingQuality = 'high'
    ctx.save()
    ctx.translate(view.x, view.y)
    ctx.scale(view.scale, view.scale)

    // 等级分区：大列交替底色 + 分界线 + 小列虚线（几何部分在世界层）
    zones.forEach((z, i) => {
      if (i % 2 === 1) {
        ctx.fillStyle = 'rgba(255,255,255,0.028)'
        ctx.fillRect(z.left, 0, z.right - z.left, height)
      }
    })
    for (const z of zones) {
      ctx.strokeStyle = '#39424d'
      ctx.lineWidth = 1.2
      ctx.beginPath()
      ctx.moveTo(z.right + 0.5, 0)
      ctx.lineTo(z.right + 0.5, height)
      ctx.stroke()
      // 小列辅助虚线（浅）
      ctx.setLineDash([3, 5])
      ctx.strokeStyle = 'rgba(255,255,255,0.06)'
      ctx.lineWidth = 1
      for (const sx of z.subs) {
        ctx.beginPath()
        ctx.moveTo(sx + 0.5, 0)
        ctx.lineTo(sx + 0.5, height)
        ctx.stroke()
      }
      ctx.setLineDash([])
    }

    // 商人泳道边框 + 背景（左沟槽 BAND_X 内不画内容，由屏幕层叠加头像）
    bands.forEach((b, i) => {
      const bandBg = i % 2 === 1 ? 'rgba(255,255,255,0.03)' : 'rgba(255,255,255,0.012)'
      ctx.fillStyle = bandBg
      rr(ctx, BAND_X, b.y, Math.max(width - BAND_X - 8, 0), b.h, 10)
      ctx.fill()
      ctx.strokeStyle = '#262c36'
      ctx.lineWidth = 1
      ctx.stroke()
    })

    // 连线
    for (const e of edges) {
      ctx.strokeStyle = e.doneEdge ? 'rgba(46,160,67,0.67)' : '#454f59'
      ctx.lineWidth = e.doneEdge ? 2.4 : 1.8
      ctx.beginPath()
      ctx.moveTo(e.x1, e.y1)
      ctx.lineTo(e.x2, e.y2)
      ctx.stroke()
    }

    // 节点
    ctx.textBaseline = 'alphabetic'
    for (const n of graph.nodes) {
      if (!visible.has(n.id)) continue
      const p = positions[n.id]
      if (!p) continue
      const st = nodeStates[n.id] ?? 'locked'
      const stl = STATE_STYLE[st]

      // 卡片底与边框
      rr(ctx, p.x, p.y, NODE_W, NODE_H, 8)
      ctx.fillStyle = stl.bg
      ctx.fill()
      if (n.special) {
        ctx.setLineDash([5, 3])
        ctx.strokeStyle = SPECIAL_BORDER
      } else {
        ctx.strokeStyle = stl.border
      }
      ctx.lineWidth = n.special ? 1.4 : 1.2
      ctx.stroke()
      ctx.setLineDash([])

      // 选中光环
      if (selectedId === n.id) {
        rr(ctx, p.x - 3, p.y - 3, NODE_W + 6, NODE_H + 6, 10)
        ctx.strokeStyle = '#ef9f27'
        ctx.lineWidth = 2
        ctx.stroke()
      }

      // 特殊角标 ✦
      if (n.special) {
        ctx.beginPath()
        ctx.arc(p.x + NODE_W - 2, p.y + 2, 7, 0, Math.PI * 2)
        ctx.fillStyle = SPECIAL_BORDER
        ctx.fill()
        ctx.fillStyle = '#000'
        ctx.font = 'bold 9px sans-serif'
        ctx.textAlign = 'center'
        ctx.fillText('✦', p.x + NODE_W - 2, p.y + 5.5)
        ctx.textAlign = 'left'
      }

      // 标题行
      ctx.font = '600 12.5px "Segoe UI", system-ui, sans-serif'
      ctx.fillStyle = stl.text
      const glyph =
        st === 'completed' ? '✓ ' : st === 'available' ? '● ' : st === 'in_progress' ? '▶ ' : ''
      const title = truncateText(ctx, glyph + n.name, NODE_W - 16)
      ctx.fillText(title, p.x + 12, p.y + 19)

      // 元信息行：Lv + 条件徽章 + 状态徽章
      let bx = p.x + 12
      const by = p.y + 34
      ctx.font = '10px "Segoe UI", system-ui, sans-serif'
      ctx.textBaseline = 'middle'
      ctx.fillStyle = 'rgba(139,148,158,0.95)'
      ctx.fillText(`Lv${n.minLevel && n.minLevel > 1 ? n.minLevel : 1}+`, bx, by)
      bx += ctx.measureText(`Lv${n.minLevel && n.minLevel > 1 ? n.minLevel : 1}+`).width + 6

      const drawChip = (label: string, fg: string, borderColor: string, bgColor: string) => {
        const tw = ctx.measureText(label).width + 8
        if (bx + tw > p.x + NODE_W - 8) return false
        rr(ctx, bx, by - 8, tw, 16, 3)
        ctx.fillStyle = bgColor
        ctx.fill()
        ctx.strokeStyle = borderColor
        ctx.lineWidth = 1
        ctx.stroke()
        ctx.fillStyle = fg
        ctx.fillText(label, bx + 4, by)
        bx += tw + 4
        return true
      }

      for (const r of n.traderReqs ?? []) {
        const met = (loyalty[r.traderId] ?? 1) >= r.value
        const label =
          r.reqType === 'level'
            ? `${traderDisplayName(r.traderId, r.traderName)} LL${r.value}`
            : `好感${r.value}`
        drawChip(
          label,
          met ? '#7ee0c8' : '#ff9d9d',
          met ? '#2a6b5e' : '#8b3a3a',
          met ? '#10231f' : '#2a1518',
        )
      }
      if (n.legacy) drawChip('旧', '#8b949e', '#30363d', '#ffffff1a')
      if (n.legacy) drawChip('仅PvP', '#ffb3b3', '#8b3a3a', '#2a1518')
      if ((loyalty[n.traderId] ?? 1) === 0) drawChip('商人未解锁', '#ffb3b3', '#8b3a3a', '#2a1518')

      // 上交物品图标行
      const items = dedupeItems(n.turnIns ?? [])
      if (items.length > 0) {
        const iy = p.y + NODE_H - 30
        let ix = p.x + 10
        for (let i = 0; i < items.length && ix + 24 <= p.x + NODE_W - 8; i++) {
          rr(ctx, ix, iy, 24, 24, 4)
          ctx.fillStyle = 'rgba(0,0,0,0.45)'
          ctx.fill()
          ctx.strokeStyle = 'rgba(255,255,255,0.1)'
          ctx.lineWidth = 1
          ctx.stroke()
          const im = getImage(`/item-icons/${items[i].id}.webp`)
          if (imgReady(im)) ctx.drawImage(im, ix + 2, iy + 2, 20, 20)
          ix += 26
        }
        const shown = Math.floor((NODE_W - 28) / 26)
        if (items.length > shown) {
          ctx.font = '10px sans-serif'
          ctx.fillStyle = '#8b949e'
          ctx.fillText(`+${items.length - shown}`, ix - 2, iy + 13)
        }
      }
      ctx.textBaseline = 'alphabetic'
    }
    ctx.restore()

    // ===== 屏幕空间 HUD：固定像素大小，不随缩放缩小，保证小倍率下依然清晰 =====
    const w2sx = (wx: number) => wx * view.scale + view.x
    const w2sy = (wy: number) => wy * view.scale + view.y

    // 商人泳道头像（48px）+ 中文名，位于左侧固定沟槽
    ctx.textBaseline = 'middle'
    for (const b of bands) {
      const cy = w2sy(b.y) + 26
      if (cy < GRID_TOP - 40 || cy > csize.h + 60) continue
      const cx = BAND_X / 2
      const src = traderImage(b.id)
      if (src) {
        const im = getImage(src)
        if (imgReady(im)) {
          const r = 24 // 固定 48px 圆形头像
          ctx.save()
          ctx.beginPath()
          ctx.arc(cx, cy, r - 1.5, 0, Math.PI * 2)
          ctx.closePath()
          ctx.clip()
          ctx.drawImage(im, cx - r, cy - r, r * 2, r * 2)
          ctx.restore()
          ctx.strokeStyle = '#3a424c'
          ctx.lineWidth = 1.4
          ctx.beginPath()
          ctx.arc(cx, cy, r, 0, Math.PI * 2)
          ctx.stroke()
        }
      }
      ctx.font = '600 13px "Segoe UI", system-ui, sans-serif'
      ctx.fillStyle = 'rgba(239,159,39,0.95)'
      ctx.textAlign = 'center'
      const nm = traderDisplayName(b.id, b.name)
      // 名字放在头像正下方，居中于沟槽；超宽名字截断
      const shortName = nm.length > 6 ? nm.slice(0, 5) + '…' : nm
      ctx.fillText(shortName, cx, cy + 42)
    }
    ctx.textAlign = 'left'

    // 顶部等级标尺条：屏幕空间固定高度
    zones.forEach((z, i) => {
      const x1 = w2sx(z.left)
      const x2 = w2sx(z.right)
      if (x2 < 0 || x1 > csize.w) return
      const a = Math.max(0, x1)
      const bnd = Math.min(csize.w, x2)
      if (i % 2 === 1 && bnd > a) {
        ctx.fillStyle = 'rgba(255,255,255,0.05)'
        ctx.fillRect(a, 0, bnd - a, GRID_TOP)
      }
    })
    for (const z of zones) {
      const x = w2sx(z.right)
      if (x < -4 || x > csize.w + 4) continue
      ctx.strokeStyle = '#39424d'
      ctx.lineWidth = 1.5
      ctx.beginPath()
      ctx.moveTo(x, 0)
      ctx.lineTo(x, GRID_TOP)
      ctx.stroke()
    }
    ctx.strokeStyle = '#39424d'
    ctx.lineWidth = 1.5
    ctx.beginPath()
    ctx.moveTo(0, GRID_TOP + 0.5)
    ctx.lineTo(csize.w, GRID_TOP + 0.5)
    ctx.stroke()
    ctx.font = '700 15px "Segoe UI", system-ui, sans-serif'
    ctx.fillStyle = '#6fb3ff'
    ctx.textAlign = 'center'
    for (const z of zones) {
      const cxz = (w2sx(z.left) + w2sx(z.right)) / 2
      if (cxz < 22 || cxz > csize.w - 22) continue
      if (w2sx(z.right) - w2sx(z.left) >= 46) ctx.fillText(z.label, cxz, GRID_TOP / 2 + 1)
    }
    ctx.textAlign = 'left'

    // ===== 缩略图画布（尺寸随世界包围盒宽高比动态变化） =====
    const mn = miniRef.current
    if (mn && width > 0 && height > 0) {
      const W = miniDim.w
      const H = miniDim.h
      const dprW = Math.round(W * dpr)
      const dprH = Math.round(H * dpr)
      if (mn.width !== dprW || mn.height !== dprH) {
        mn.width = dprW
        mn.height = dprH
      }
      const mctx = mn.getContext('2d')!
      mctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      mctx.clearRect(0, 0, W, H)
      const pad = 8
      const k = Math.min((W - pad * 2) / width, (H - pad * 2) / height)
      mctx.save()
      mctx.translate(pad, pad)

      // 等级分区网格 + 泳道底色（与主画布一致的视觉语言）
      zones.forEach((z, i) => {
        if (i % 2 === 1) {
          mctx.fillStyle = 'rgba(255,255,255,0.04)'
          mctx.fillRect(z.left * k, 0, (z.right - z.left) * k, height * k)
        }
      })
      for (const z of zones) {
        mctx.strokeStyle = '#2c333b'
        mctx.lineWidth = 1
        mctx.beginPath()
        mctx.moveTo(z.right * k, 0)
        mctx.lineTo(z.right * k, height * k)
        mctx.stroke()
      }
      bands.forEach((b, i) => {
        mctx.strokeStyle = '#262c36'
        mctx.lineWidth = 1
        mctx.strokeRect(4 * k, b.y * k, Math.max(width * k - 8, 0), b.h * k)
      })

      for (const n of graph.nodes) {
        if (!visible.has(n.id)) continue
        const p = positions[n.id]
        if (!p) continue
        const st = nodeStates[n.id] ?? 'locked'
        mctx.fillStyle =
          st === 'completed'
            ? '#2ea043'
            : st === 'in_progress'
              ? '#58a6ff'
              : st === 'available'
                ? '#ef9f27'
                : '#3d444d'
        mctx.fillRect(p.x * k, p.y * k, Math.max(2, NODE_W * k), Math.max(1.5, NODE_H * k * 0.55))
      }

      // 当前视口框
      const vw = (csize.w / view.scale) * k
      const vh = (csize.h / view.scale) * k
      const vx = (-view.x / view.scale) * k
      const vy = (-view.y / view.scale) * k
      mctx.fillStyle = 'rgba(239,159,39,0.1)'
      mctx.fillRect(vx, vy, vw, vh)
      mctx.strokeStyle = 'rgba(239,159,39,0.85)'
      mctx.lineWidth = 1.2
      mctx.strokeRect(vx, vy, vw, vh)
      mctx.restore()
    }
  }

  return (
    <div className="h-full flex flex-col relative">
      {/* 商人头像条（最上）：点击切换显示/隐藏该商人的任务 */}
      <div className="shrink-0 flex items-center gap-1.5 px-4 py-2 bg-ink-800 border-b border-line overflow-x-auto relative z-30">
        {traderBar.map((t) => {
          const off = !!disabledTraders[t.id]
          const av = traderImage(t.id)
          const zhName = traderDisplayName(t.id, t.name)
          return (
            <button
              key={t.id}
              onClick={() => toggleTrader(t.id)}
              title={`${zhName}${off ? '（已隐藏）' : ''}`}
              className={`flex items-center gap-1.5 shrink-0 pl-0.5 pr-2 py-0.5 rounded-full border transition-colors ${
                off
                  ? 'border-line opacity-40 grayscale hover:opacity-70'
                  : 'border-line hover:border-amber'
              }`}
            >
              {av && (
                <img src={av} alt={zhName} className="w-6 h-6 rounded-full object-cover" />
              )}
              <span
                className={`text-[11px] whitespace-nowrap ${
                  off ? 'text-muted line-through' : 'text-[#e6edf3]'
                }`}
              >
                {zhName}
              </span>
            </button>
          )
        })}
      </div>

      {/* 工具栏：筛选 + 图例 */}
      <div className="shrink-0 flex flex-wrap items-center gap-x-3 gap-y-1.5 px-4 py-2 bg-ink-800 border-b border-line relative z-30">
        <label
          className={checkLabel}
          title="仅显示商人忠诚等级达标的任务（在侧边栏「角色」页填写；搜索任务名时忽略此项）"
        >
          <input
            type="checkbox"
            checked={repMet}
            onChange={(e) => setRepMet(e.target.checked)}
          />
          好感达标
        </label>

        <label
          className={checkLabel}
          title="仅显示玩家等级足够的任务（搜索任务名时忽略此项）"
        >
          <input
            type="checkbox"
            checked={lvlMet}
            onChange={(e) => setLvlMet(e.target.checked)}
          />
          等级达标
        </label>

        <label className={checkLabel} title="隐藏已移除的旧任务（多为旧 PvP 专属任务）">
          <input
            type="checkbox"
            checked={hideLegacy}
            onChange={(e) => setHideLegacy(e.target.checked)}
          />
          隐藏旧任务
        </label>

        <label className={checkLabel} title="仅显示已完成、进行中、可接取，及其完成后的下一批任务">
          <input
            type="checkbox"
            checked={focusMode}
            onChange={(e) => setFocusMode(e.target.checked)}
          />
          只看可达
        </label>

        {/* 地图单选筛选 */}
        <select
          value={mapSel}
          onChange={(e) => setMapSel(e.target.value)}
          title="按地图/地区筛选任务"
          className="bg-ink-700 border border-line text-[12px] rounded px-2 py-1 text-[#e6edf3]"
        >
          <option value="">全部地区</option>
          {mapOptions.map((o) => (
            <option key={o.id || '__none__'} value={o.id}>
              {o.label}
            </option>
          ))}
        </select>

        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="搜索任务名…"
          className="bg-ink-700 border border-line text-[12px] rounded px-2 py-1 text-[#e6edf3] w-44 placeholder:text-muted"
        />

        {/* 图例 */}
        <div className="ml-auto flex items-center flex-wrap gap-x-3 gap-y-1 text-[11px] text-muted">
          <span className="flex items-center gap-1"><span className="w-3 h-3 rounded-sm bg-[#14261b] border border-[#2ea043]" />已完成</span>
          <span className="flex items-center gap-1"><span className="w-3 h-3 rounded-sm bg-[#0e2438] border border-[#58a6ff]" />进行中</span>
          <span className="flex items-center gap-1"><span className="w-3 h-3 rounded-sm bg-[#2b2310] border border-[#ef9f27]" />待接取</span>
          <span className="flex items-center gap-1"><span className="w-3 h-3 rounded-sm bg-ink-800 border border-line" />后续解锁</span>
          <span className="flex items-center gap-1"><span className="w-3 h-3 rounded-sm bg-ink-800 border border-dashed border-[#a371f7]" />特殊✦</span>
          <button
            onClick={() => setView({ x: 30, y: 30, scale: 0.65 })}
            className={`${chip} ${chipOff}`}
          >
            重置视图
          </button>
        </div>
      </div>

      {/* 画布 */}
      <div
        className="relative flex-1 min-h-0 overflow-hidden bg-ink-900"
        style={{ cursor }}
        onWheel={onWheel}
        onMouseDown={onMouseDown}
        onMouseMove={onMouseMove}
        onMouseUp={onMouseUp}
        onMouseLeave={onMouseLeave}
      >
        <canvas ref={canvasRef} className="absolute inset-0 w-full h-full block" />

        {/* 物品悬浮 tooltip（仅在物品图标上触发） */}
        {hoverTip && tipXY && (
          <div
            className="pointer-events-none absolute z-50 w-max max-w-[190px] px-2 py-1 rounded-md bg-ink-700 border border-line shadow-xl text-[11px] text-[#c9d1d9] leading-snug"
            style={{ left: Math.min(tipXY.x + 14, csize.w - 200), top: Math.max(tipXY.y - 14, 4) }}
          >
            <span className="font-medium">{hoverTip.name}</span>
            {hoverTip.count != null && hoverTip.count > 0 && (
              <span className="text-amber">需要 ×{hoverTip.count}</span>
            )}
            <div className="text-muted font-mono text-[9px]">{hoverTip.id}</div>
          </div>
        )}

        {/* 概览面板 */}
        {selectedId && (
          <div
            onMouseDown={(e) => e.stopPropagation()}
            onWheel={(e) => e.stopPropagation()}
            className="absolute right-3 top-3 w-[310px] max-h-[88%] overflow-y-auto bg-ink-800 border border-line rounded-xl p-4 shadow-xl z-40 cursor-default"
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
                <div className="text-[11px] text-muted mt-1.5 flex items-center gap-1.5 flex-wrap">
                  {selAvatar && (
                    <img
                      src={selAvatar}
                      alt={detail.traderName}
                      className="w-5 h-5 rounded-full object-cover border border-line"
                    />
                  )}
                  <span>
                    商人 {detail.traderName}
                    {detail.minLevel ? ` · Lv${detail.minLevel}+` : ''}
                    {statusMap[detail.id]
                      ? ` · ${statusMap[detail.id] === 'completed' ? '已完成' : '进行中'}`
                      : ''}
                  </span>
                  {detail.legacy && (
                    <span className="px-1.5 rounded border border-line text-[10px] text-muted">
                      旧任务
                    </span>
                  )}
                  {detail.legacy && (
                    <span className="px-1.5 rounded border border-red-500/40 bg-red-500/15 text-red-300 text-[10px]">
                      仅 PvP
                    </span>
                  )}
                  {detail.special && (
                    <span className="px-1.5 rounded border border-dashed border-[#a371f7] text-[#a371f7] text-[10px]">
                      特殊 ✦
                    </span>
                  )}
                </div>

                {detail.traderReqs?.length > 0 && (
                  <div className="mt-3">
                    <div className="text-[11px] text-muted mb-1">贸易条件</div>
                    <div className="space-y-1 text-[12px]">
                      {detail.traderReqs.map((r) => {
                        const cur = profile?.loyalty?.[r.traderId] ?? 1
                        const met = cur >= r.value
                        return (
                          <div
                            key={`${r.traderId}-${r.reqType}`}
                            className="flex items-center justify-between gap-2"
                          >
                            <span className="text-[#c9d1d9] truncate">
                              {traderDisplayName(r.traderId, r.traderName)}{' '}
                              {r.reqType === 'level' ? `忠诚等级 LL${r.value}` : `好感 ≥${r.value}`}
                              {r.reqType === 'level' && `（当前 LL${cur}）`}
                            </span>
                            {r.reqType === 'level' &&
                              (met ? (
                                <span className="text-ok shrink-0">✓ 已达标</span>
                              ) : (
                                <span className="text-red-400 shrink-0">✗ 未达标</span>
                              ))}
                          </div>
                        )
                      })}
                    </div>
                  </div>
                )}

                {detail.objectives?.length > 0 && (
                  <div className="mt-3">
                    <div className="text-[11px] text-muted mb-1">目标</div>
                    <ul className="space-y-2 text-[12px] text-[#c9d1d9]">
                      {detail.objectives.map((o, i) => (
                        <li key={i} className="leading-snug">
                          <div>- {o.description}</div>
                          {o.items?.length > 0 && (
                            <div className="mt-1 pl-3 flex flex-wrap gap-1.5">
                              {o.items.map((it) => (
                                <span
                                  key={it.id}
                                  className="inline-flex items-center gap-1 rounded bg-ink-700 border border-line pl-0.5 pr-1.5 py-0.5"
                                  title={`${it.name}${it.count ? ` ×${it.count}` : ''}`}
                                >
                                  <img
                                    src={`/item-icons/${it.id}.webp`}
                                    alt=""
                                    loading="lazy"
                                    className="w-4 h-4 object-contain"
                                  />
                                  <span className="truncate max-w-[120px]">{it.name}</span>
                                  {it.count != null && it.count > 0 && (
                                    <span className="text-amber">×{it.count}</span>
                                  )}
                                </span>
                              ))}
                            </div>
                          )}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                {detail.rewards?.length > 0 && (
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

                {detail.prereqs?.length > 0 && (
                  <div className="mt-3">
                    <div className="text-[11px] text-muted mb-1">前置任务</div>
                    <div className="text-[12px] text-[#c9d1d9] space-y-0.5">
                      {detail.prereqs.map((p) => (
                        <div key={p.id} className="truncate flex items-center gap-1">
                          <span className={completedSet.has(p.id) ? 'text-ok' : 'text-muted'}>
                            {completedSet.has(p.id) ? '✓' : '○'}
                          </span>
                          {p.name}
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                <button
                  onClick={(e) => {
                    e.stopPropagation()
                    openWiki(detail.wiki)
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

        {/* 缩略图（右下角）：尺寸随世界包围盒宽高比动态变化 */}
        <div
          className="absolute rounded-md border border-line bg-ink-800/90 shadow-xl z-40 select-none cursor-crosshair overflow-hidden"
          style={{ right: 12, bottom: 12, width: miniDim.w, height: miniDim.h }}
          onWheel={(e) => e.stopPropagation()}
          onMouseDown={(e) => {
            e.stopPropagation()
            miniDragRef.current = true
            miniJump(e)
          }}
          onMouseMove={(e) => {
            if (!miniDragRef.current) return
            e.stopPropagation()
            miniJump(e)
          }}
          onMouseUp={() => (miniDragRef.current = false)}
          onMouseLeave={() => (miniDragRef.current = false)}
        >
          <canvas ref={miniRef} style={{ width: miniDim.w, height: miniDim.h }} />
        </div>
      </div>
    </div>
  )
}
