import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import type { MouseEvent as ReactMouseEvent, WheelEvent as ReactWheelEvent } from 'react'
import { useStore, useTopPad } from '../store'
import { getQuestGraph, getQuestDetail, setQuestStatus, getMaps } from '../tauri'
import { traderImage } from '../traderImages'
import { TRADER_UNLOCK_QUEST, traderDisplayName, TRADERS } from '../traderMeta'
import type { GraphEdge, GraphNode, ItemRef, MapInfo } from '../types'


const ROW_H = 104
const NODE_W = 204
const NODE_H = 78
const BAND_GAP = 26

/** 默认视图缩放（初始打开与「重置视图」按钮共用）：偏大以便看清节点文字 */
const DEFAULT_SCALE = 0.8

// 网格布局常量（布局与绘制共用）
const SUB_G = 10 // 小列间距
const ZONE_PAD_IN = 20 // 大列内边距
const ROWS_CAP = 3 // 每个小列的最大行数（超出则开新小列，行数永久封顶）
const GRID_TOP = 38 // 顶部等级标尺高度（屏幕像素）
const BAND_X = 78 // 网格整体右移量：左侧为外置商人头像的固定屏幕沟槽
const TOP_GAP = 14 // 泳道顶边到第一行卡片的间距

type NodeState = 'completed' | 'in_progress' | 'available' | 'locked'


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
  available: { bg: '#231b0d', border: '#c08a2a', text: '#e6c089' },
  locked: { bg: '#1f2730', border: '#6b7682', text: '#c2cad3' },
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

// 下拉菜单里的勾选项（筛选条件 / 商人显隐 复用）
function FilterCheck({
  label,
  checked,
  disabled,
  onChange,
  title,
}: {
  label: string
  checked: boolean
  disabled?: boolean
  onChange: (v: boolean) => void
  title?: string
}) {
  return (
    <label
      className={
        'flex items-center gap-2 text-[14px] text-muted cursor-pointer select-none whitespace-nowrap px-2 py-1 rounded hover:bg-ink-700 ' +
        (disabled ? 'opacity-40 cursor-not-allowed' : '')
      }
      title={title}
    >
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        className="accent-[#ef9f27]"
      />
      {label}
    </label>
  )
}

// 下拉触发器：带边框的胶囊按钮，含图标 / 文案 / 数量徽标 / 下拉箭头
function DropdownTrigger({
  icon,
  label,
  count,
  active,
  open,
  onClick,
  title,
}: {
  icon: ReactNode
  label: string
  count: number
  active: boolean
  open: boolean
  onClick: () => void
  title: string
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className={`flex items-center gap-1.5 h-[26px] pl-2 pr-1.5 rounded-full border text-[14px] whitespace-nowrap transition-colors ${
        active
          ? 'border-amber/70 bg-amber/10 text-[#e6edf3]'
          : 'border-line bg-ink-700 text-muted hover:text-[#e6edf3] hover:border-[#4d5560]'
      } ${open ? 'border-amber/70' : ''}`}
    >
      <span className={`flex items-center ${active ? 'text-amber' : 'opacity-70'}`}>{icon}</span>
      <span>{label}</span>
      {count > 0 && (
        <span className="ml-0.5 min-w-[16px] h-[16px] px-1 grid place-items-center rounded-full bg-amber text-black text-[12px] font-medium leading-none">
          {count}
        </span>
      )}
      <svg
        width="9"
        height="9"
        viewBox="0 0 12 12"
        aria-hidden
        className={`opacity-70 transition-transform ${open ? 'rotate-180' : ''}`}
      >
        <path
          d="M2.5 4.5 6 8l3.5-3.5"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </button>
  )
}

export function QuestGraphPage() {
  const graph = useStore((s) => s.graph)
  const setGraph = useStore((s) => s.setGraph)
  const playerQuests = useStore((s) => s.playerQuests)
  const unlockedQuests = useStore((s) => s.unlockedQuests)
  const seedPlayerQuests = useStore((s) => s.seedPlayerQuests)
  const setUnlockedQuests = useStore((s) => s.setUnlockedQuests)
  const selectedId = useStore((s) => s.selectedId)
  const detail = useStore((s) => s.detail)
  const setSelected = useStore((s) => s.setSelected)
  const search = useStore((s) => s.searchGraph)
  const setSearch = useStore((s) => s.setSearchGraph)
  const page = useStore((s) => s.page)
  const disabledTraders = useStore((s) => s.disabledTradersGraph)
  const mapSel = useStore((s) => s.mapSelGraph)
  const setMapSel = useStore((s) => s.setMapSelGraph)
  const openWiki = useStore((s) => s.openWiki)
  const hideLegacy = useStore((s) => s.hideLegacyGraph)
  const setHideLegacy = useStore((s) => s.setHideLegacyGraph)
  const repMet = useStore((s) => s.repMetGraph)
  const setRepMet = useStore((s) => s.setRepMetGraph)
  const lvlMet = useStore((s) => s.lvlMetGraph)
  const setLvlMet = useStore((s) => s.setLvlMetGraph)
  const mapUnlocked = useStore((s) => s.mapUnlockedGraph)
  const setMapUnlocked = useStore((s) => s.setMapUnlockedGraph)
  const profile = useStore((s) => s.settings.profile)
  // 「已完成」显示开关：勾选显示已完成任务，不勾选排除（替代原专注模式）
  const showCompleted = useStore((s) => s.showCompletedGraph)
  const setShowCompleted = useStore((s) => s.setShowCompletedGraph)
  const setTraderGraph = useStore((s) => s.setTraderGraph)
  // 任务模式过滤（pvp/pve，localStorage 持久化；日志检测到会话模式时自动跟随）
  const questMode = useStore((s) => s.questMode)
  const setQuestMode = useStore((s) => s.setQuestMode)
  // 侧边栏折叠时，顶部工具栏为左上角浮动按钮预留空位
  // 注意：hook 必须位于所有 early return 之前，否则触发 "Rendered more hooks" 崩溃
  const topPad = useTopPad()

  const [view, setView] = useState({ x: 30, y: 30, scale: DEFAULT_SCALE })
  const dragRef = useRef<{ sx: number; sy: number; vx: number; vy: number; moved: boolean } | null>(
    null,
  )
  // 悬浮目标：仅在变化时写入 state，避免 mousemove 高频重渲染
  const [hover, setHover] = useState<{ id: string; icon: number } | null>(null)
  const [tipXY, setTipXY] = useState<{ x: number; y: number } | null>(null)
  const [cursor, setCursor] = useState<'grab' | 'grabbing' | 'pointer'>('grab')
  const [itemListOpen, setItemListOpen] = useState(false)
  const [, setImgTick] = useState(0) // 图片加载完成时触发一次重绘

  // 工具栏下拉（筛选条件 / 商人显隐）：点开状态与点击外部关闭
  const [filterOpen, setFilterOpen] = useState(false)
  const [traderOpen, setTraderOpen] = useState(false)
  const filterRef = useRef<HTMLDivElement>(null)
  const traderRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!filterOpen && !traderOpen) return
    const h = (e: MouseEvent) => {
      if (filterOpen && filterRef.current && !filterRef.current.contains(e.target as Node)) {
        setFilterOpen(false)
      }
      if (traderOpen && traderRef.current && !traderRef.current.contains(e.target as Node)) {
        setTraderOpen(false)
      }
    }
    document.addEventListener('mousedown', h)
    return () => document.removeEventListener('mousedown', h)
  }, [filterOpen, traderOpen])

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

  // keepAlive 下图谱页以 display:none 隐藏，切回 display:block 时 ResizeObserver 在部分
  // webview 中不一定重新触发；这里在「图谱页可见」的提交后同步测量画布尺寸，避免 csize
  // 卡在 0 导致整页绘制被 early-return 跳过（表现为：能点击出任务详情，但画布空白）。
  useLayoutEffect(() => {
    if (page !== 'graph') return
    const el = canvasRef.current
    if (!el) return
    const w = el.clientWidth
    const h = el.clientHeight
    if (w > 0 && h > 0) setCsize({ w, h })
  }, [page])

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

  // 加载任务图谱：keepAlive 下组件常驻挂载，须在「页面可见」且尚未加载时拉取，
  // 并带退避重试（屏蔽刷新后不再能靠手动刷新恢复，且启动时后端可能尚未就绪）。
  useEffect(() => {
    if (page !== 'graph') return
    if (graph) return
    let cancelled = false
    let tries = 0
    const attempt = () => {
      if (cancelled) return
      getQuestGraph()
        .then(setGraph)
        .catch((e) => {
          if (cancelled) return
          tries += 1
          if (tries < 6) {
            setTimeout(attempt, 800)
          } else {
            console.error('任务图谱加载失败', e)
          }
        })
    }
    attempt()
    return () => {
      cancelled = true
    }
  }, [page, graph, setGraph])

  // 玩家状态
  const { statusMap, completedSet, unlockedSet } = useMemo(() => {
    const sm: Record<string, 'in_progress' | 'completed'> = {}
    const cs = new Set<string>()
    const us = new Set<string>(unlockedQuests)
    for (const q of playerQuests) {
      sm[q.questId] = q.status
      if (q.status === 'completed') cs.add(q.questId)
    }
    return { statusMap: sm, completedSet: cs, unlockedSet: us }
  }, [playerQuests, unlockedQuests])

  // 任务在该模式下是否可用（无 modes 字段的旧数据视为全部可用）
  const modeOk = (n: GraphNode): boolean =>
    !n.modes || n.modes.length === 0 || n.modes.includes(questMode)
  // 模式感知前置：pve 模式下优先用 prereqsPve（后端仅在两种模式不同时填充）
  const prereqsOf = (n: GraphNode): string[] =>
    questMode === 'pve' && n.prereqsPve && n.prereqsPve.length > 0 ? n.prereqsPve : n.prereqs ?? []

  const classify = (n: GraphNode): NodeState => {
    const st = statusMap[n.id]
    if (st === 'completed') return 'completed'
    if (st === 'in_progress') return 'in_progress'
    if (unlockedSet.has(n.id) || prereqsOf(n).every((p) => completedSet.has(p)))
      return 'available'
    return 'locked'
  }

  // 当前选中任务的状态（用于详情弹窗的状态标识与操作按钮）
  const selStatus: NodeState = useMemo(() => {
    if (!detail) return 'locked'
    const node = graph?.nodes.find((n) => n.id === detail.id)
    return node ? classify(node) : 'locked'
  }, [detail, graph, statusMap, completedSet, unlockedSet])

  // 手动修改任务状态：接取/完成/解锁（含任务链前置处理，由后端执行）
  const onSetStatus = async (
    id: string,
    action: 'accept' | 'complete' | 'unlock',
  ) => {
    try {
      const res = await setQuestStatus(id, action)
      seedPlayerQuests(res.quests)
      setUnlockedQuests(res.unlocked)
    } catch (e) {
      console.error('setQuestStatus failed', e)
    }
  }

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
    // 地图可用过滤：开启时，任务涉及的任一地图被锁定即不显示；无地图任务恒可用。
    // lockedMaps 为空表示全部地图可用（用户在「角色」页未管理过）。
    const lockedMaps = profile?.lockedMaps
    const hasLockedMap = (maps: string[] | null | undefined): boolean => {
      if (!mapUnlocked) return false
      if (!maps || maps.length === 0) return false
      if (!lockedMaps || lockedMaps.length === 0) return false
      return maps.some((m) => lockedMaps.includes(m))
    }
    // 专注于「需求过滤」（好感 / 等级 / 地图 / 商人 / 旧任务 / 地区），不含搜索。
    const effRepMet = repMet
    const effLvlMet = lvlMet
    const reqFails = (n: GraphNode): boolean => {
      if (hideLegacy && n.legacy) return true
      if (disabledTraders[n.traderId]) return true
      if (mapSel && mapSel !== '__none__' && !(n.maps ?? []).includes(mapSel) && (n.map ?? '__none__') !== mapSel) return true
      if (mapSel === '__none__' && (n.map ?? '__none__') !== '__none__') return true
      if (hasLockedMap(n.maps)) return true
      // 模式过滤（pvp/pve）：不属于当前模式的任务视为隐藏，并参与任务链传播
      if (!modeOk(n)) return true
      const ll = profile?.loyalty?.[n.traderId] ?? 1
      if (effRepMet && ll === 0) return true
      if (effLvlMet && (n.minLevel ?? 1) > Math.max(1, profile?.level ?? 1)) return true
      if (effRepMet) {
        for (const r of n.traderReqs ?? []) {
          if (r.reqType === 'level' && (profile?.loyalty?.[r.traderId] ?? 1) < r.value) return true
        }
      }
      return false
    }
    const vis = new Set<string>()
    for (const n of graph.nodes) {
      if (!modeOk(n)) continue
      if (hideLegacy && n.legacy) continue
      if (disabledTraders[n.traderId]) continue
      // 地图单选筛选：非空时任务涉及的任一地图命中即显示（__none__=未指定地图）
      if (mapSel && mapSel !== '__none__' && !(n.maps ?? []).includes(mapSel) && (n.map ?? '__none__') !== mapSel) continue
      if (mapSel === '__none__' && (n.map ?? '__none__') !== '__none__') continue
      // 地图可用过滤：涉及未解锁地图的任务不显示
      if (hasLockedMap(n.maps)) continue
      // 「已完成」开关：不勾选时排除已完成任务（仅在显示层排除，不参与任务链传播——
      // 已完成的前置不应隐藏其下游）
      if (!showCompleted && statusMap[n.id] === 'completed') continue
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

    // 模式有效的边：pve 模式下，仅当 from ∈ to 的 pve 前置（或共有前置）时才视为该模式的边。
    // 后端边是 pvp/pve 两套前置的并集，模式专属边的一端会被隐藏，但传播/布局仍需按模式剔除。
    const edgeValid = (e: GraphEdge): boolean => {
      const v = nodeMap[e.to]
      if (!v) return false
      return prereqsOf(v).includes(e.from)
    }

    // —— 任务链过滤传播 ——
    // 被「需求过滤」（好感 / 等级 / 地图 / 商人 / 旧任务 / 地区）隐藏的前置任务，
    // 其下游整条任务链也应隐藏，哪怕下游任务自身满足要求。搜索(q)时不传播。
    if (!q) {
      const fwd = new Map<string, string[]>()
      for (const e of graph.edges) {
        if (!edgeValid(e)) continue
        ;(fwd.get(e.from) ?? fwd.set(e.from, []).get(e.from)!).push(e.to)
      }
      const seeds: string[] = []
      for (const n of graph.nodes) {
        if (reqFails(n)) seeds.push(n.id)
      }
      const chainHidden = new Set<string>()
      const stack = [...seeds]
      while (stack.length) {
        const u = stack.pop()!
        if (chainHidden.has(u)) continue
        chainHidden.add(u)
        for (const v of fwd.get(u) ?? []) {
          if (!chainHidden.has(v)) stack.push(v)
        }
      }
      for (const id of chainHidden) {
        vis.delete(id)
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
      for (const e of graph.edges) {
        if (!edgeValid(e)) continue
        relax(e.from, e.to)
      }
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
  }, [graph, disabledTraders, mapSel, search, hideLegacy, repMet, lvlMet, mapUnlocked, profile, statusMap, completedSet, unlockedSet, questMode, showCompleted])

  // 缩略图尺寸：按世界包围盒宽高比动态确定（最长边固定，含上下限）
  const MINI_LONG = 170
  const miniDim = useMemo(() => {
    if (width <= 0 || height <= 0) return { w: 150, h: 100 }
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
    w = Math.max(80, Math.min(200, w))
    h = Math.max(70, Math.min(210, h))
    return { w, h }
  }, [width, height])

  const edges = useMemo(() => {
    if (!graph) return []
    const nodeById = new Map<string, GraphNode>()
    for (const n of graph.nodes) nodeById.set(n.id, n)
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
      // 模式有效边：仅绘制当前模式前置关系（后端边为 pvp/pve 并集）
      const v = nodeById.get(e.to)
      const pr = questMode === 'pve' && v?.prereqsPve?.length ? v.prereqsPve : v?.prereqs
      if (!pr?.includes(e.from)) continue
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
  }, [graph, visible, positions, statusMap, questMode])

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
  }, [graph, visible, positions, statusMap, completedSet, unlockedSet, questMode])

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

  // 详情所需物品（跨目标去重聚合）：用于「最多显示 15 个 + 显示更多弹窗」
  const allDetailItems = useMemo(() => {
    if (!detail) return []
    const arr: ItemRef[] = []
    for (const o of detail.objectives ?? []) {
      for (const it of o.items ?? []) arr.push(it)
    }
    return dedupeItems(arr)
  }, [detail])

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
      if (n) {
        select(n.id)
      } else if (selectedId) {
        // 点击空白区域关闭详情弹窗（拖动已在 moved 判定中被排除）
        setSelected(null, null)
      }
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
    return <div className="p-6 text-muted text-[15px]">加载任务图谱…</div>
  }

  const selectedNode = selectedId ? (graph.nodes.find((n) => n.id === selectedId) ?? null) : null
  const selAvatar = traderImage(selectedNode?.traderId)

  const chip =
    'px-2.5 py-1 rounded-full text-[14px] border transition-colors whitespace-nowrap'
  const chipOff = 'bg-ink-800 border-line text-muted hover:text-[#e6edf3]'

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
    if (!cv) return
    const dpr = window.devicePixelRatio || 1
    // 始终以画布实时显示尺寸为准：避免 csize 滞后（如 keepAlive 切回时）导致
    // 绘制位图被浏览器拉伸，进而与命中测试的世界坐标产生偏移（点击位置错位）。
    const r = cv.getBoundingClientRect()
    const CW = r.width
    const CH = r.height
    if (CW <= 0 || CH <= 0) return
    if (CW !== csize.w || CH !== csize.h) setCsize({ w: CW, h: CH })
    // 保证画布 backing store 与显示尺寸一致（避免 csize 生效前内容被裁剪）
    const pw = Math.round(CW * dpr)
    const ph = Math.round(CH * dpr)
    if (cv.width !== pw || cv.height !== ph) {
      cv.width = pw
      cv.height = ph
    }
    const ctx = cv.getContext('2d')!
    const loyalty = profile?.loyalty ?? {}

    // ===== 主画布 =====
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, CW, CH)
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

      // 节点上的文字（标题 / Lv / 条件徽章 / ✦）统一在「屏幕空间」绘制，
      // 避免 ctx.scale 造成的亚像素缩放模糊，缩放后依然清晰。详见下方 pass。

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
          ctx.font = '12px sans-serif'
          ctx.fillStyle = '#8b949e'
          ctx.fillText(`+${items.length - shown}`, ix - 2, iy + 13)
        }
      }
    }
    ctx.restore()

    // ===== 屏幕空间 HUD：固定像素大小，不随缩放缩小，保证小倍率下依然清晰 =====
    const w2sx = (wx: number) => wx * view.scale + view.x
    const w2sy = (wy: number) => wy * view.scale + view.y

    // ===== 屏幕空间：节点文字 =====
    // 在屏幕空间（仅 dpr 变换）按「整数字号 + 整数坐标」绘制，规避 ctx.scale 的
    // 亚像素缩放模糊；字号随缩放比例取整，布局与世界层卡片完全一致。
    ctx.textBaseline = 'alphabetic'
    ctx.textAlign = 'left'
    const TS = view.scale
    for (const n of graph.nodes) {
      if (!visible.has(n.id)) continue
      const p = positions[n.id]
      if (!p) continue
      const st = nodeStates[n.id] ?? 'locked'
      const stl = STATE_STYLE[st]
      const sx = w2sx(p.x)
      const sy = w2sy(p.y)
      const sw = NODE_W * TS
      const sh = NODE_H * TS
      if (sx + sw < -24 || sx > CW + 24 || sy + sh < -24 || sy > CH + 24) continue

      // 特殊角标 ✦（右上角，与 Lv 同角但更靠边）
      if (n.special) {
        const cx = sx + sw - 8 * TS
        const cy = sy + 8 * TS
        const r = Math.max(4, 7 * TS)
        ctx.beginPath()
        ctx.arc(cx, cy, r, 0, Math.PI * 2)
        ctx.fillStyle = SPECIAL_BORDER
        ctx.fill()
        ctx.fillStyle = '#000'
        ctx.font = `bold ${Math.max(8, Math.round(11 * TS))}px sans-serif`
        ctx.textAlign = 'center'
        ctx.textBaseline = 'middle'
        ctx.fillText('✦', cx, cy + 0.5)
        ctx.textAlign = 'left'
        ctx.textBaseline = 'alphabetic'
      }

      // 等级（右上角，不挤占元信息行）
      const lv = n.minLevel && n.minLevel > 1 ? n.minLevel : 1
      ctx.font = `${Math.max(8, Math.round(12 * TS))}px "Segoe UI", system-ui, sans-serif`
      ctx.fillStyle = 'rgba(139,148,158,0.95)'
      ctx.textAlign = 'right'
      const lvText = `Lv${lv}+`
      const lvW = ctx.measureText(lvText).width
      const lvRight = n.special ? sx + sw - 19 * TS : sx + sw - 6 * TS
      ctx.fillText(lvText, Math.round(lvRight), Math.round(sy + 15 * TS))
      ctx.textAlign = 'left'

      // 标题（为右上角 Lv/✦ 预留宽度）
      ctx.font = `600 ${Math.max(9, Math.round(14.5 * TS))}px "Segoe UI", system-ui, sans-serif`
      ctx.fillStyle = stl.text
      const glyph = st === 'completed' ? '✓ ' : st === 'available' ? '● ' : st === 'in_progress' ? '▶ ' : ''
      const rightReserve = (n.special ? 19 * TS : 6 * TS) + lvW + 6 * TS
      const titleMax = Math.max(24, sw - 12 * TS - rightReserve)
      const title = truncateText(ctx, glyph + n.name, titleMax)
      ctx.fillText(title, Math.round(sx + 12 * TS), Math.round(sy + 19 * TS))

      // 元信息 chips（贸易条件 / 旧 / 仅PvP / 未解锁）
      let bx = sx + 12 * TS
      const by = sy + 34 * TS
      ctx.font = `${Math.max(8, Math.round(12 * TS))}px "Segoe UI", system-ui, sans-serif`
      ctx.textBaseline = 'middle'
      const drawChip = (label: string, fg: string, borderColor: string, bgColor: string) => {
        const tw = ctx.measureText(label).width + 8 * TS
        if (bx + tw > sx + sw - 8 * TS) return false
        rr(ctx, bx, by - 8 * TS, tw, 16 * TS, 3 * TS)
        ctx.fillStyle = bgColor
        ctx.fill()
        ctx.strokeStyle = borderColor
        ctx.lineWidth = 1
        ctx.stroke()
        ctx.fillStyle = fg
        ctx.fillText(label, bx + 4 * TS, by)
        bx += tw + 4 * TS
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
      ctx.textBaseline = 'alphabetic'
    }

    // 商人泳道头像（48px）+ 中文名，位于左侧固定沟槽
    ctx.textBaseline = 'middle'
    for (const b of bands) {
      const cy = w2sy(b.y) + 26
      if (cy < GRID_TOP - 40 || cy > CH + 60) continue
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
      ctx.font = '600 15px "Segoe UI", system-ui, sans-serif'
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
      if (x2 < 0 || x1 > CW) return
      const a = Math.max(0, x1)
      const bnd = Math.min(CW, x2)
      if (i % 2 === 1 && bnd > a) {
        ctx.fillStyle = 'rgba(255,255,255,0.05)'
        ctx.fillRect(a, 0, bnd - a, GRID_TOP)
      }
    })
    for (const z of zones) {
      const x = w2sx(z.right)
      if (x < -4 || x > CW + 4) continue
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
    ctx.lineTo(CW, GRID_TOP + 0.5)
    ctx.stroke()
    ctx.font = '700 17px "Segoe UI", system-ui, sans-serif'
    ctx.fillStyle = '#6fb3ff'
    ctx.textAlign = 'center'
    for (const z of zones) {
      const cxz = (w2sx(z.left) + w2sx(z.right)) / 2
      if (cxz < 22 || cxz > CW - 22) continue
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
      const vw = (CW / view.scale) * k
      const vh = (CH / view.scale) * k
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

  // 筛选下拉已选条件数量
  const filterCount =
    (repMet ? 1 : 0) +
    (lvlMet ? 1 : 0) +
    (mapUnlocked ? 1 : 0) +
    (showCompleted ? 1 : 0) +
    (!hideLegacy ? 1 : 0)
  // 商人下拉：当前勾选显示的商人数量（隐藏数 = 总数 - 已选数）
  const hiddenTraders = Object.values(disabledTraders).filter(Boolean).length
  const shownTraders = TRADERS.length - hiddenTraders

  return (
    <div className="h-full flex flex-col relative">
      {/* 工具栏：筛选 + 图例 */}
      <div
        className="shrink-0 flex flex-wrap items-center gap-x-3 gap-y-1.5 px-4 py-2 bg-ink-800 border-b border-line relative z-30 overflow-visible"
        style={{ paddingLeft: 16 + topPad }}
      >
        {/* 模式切换：PVP / PVE（日志检测到游戏会话模式时自动跟随切换） */}
        <div
          className="shrink-0 flex items-center rounded-full border border-line bg-ink-700 p-0.5"
          title="任务模式：PVP（正规服务器）/ PVE（PvE 服务器）。游戏启动时从日志检测会话模式并自动切换，也可手动点选（会记住选择）。"
        >
          {(['pvp', 'pve'] as const).map((m) => (
            <button
              key={m}
              onClick={() => setQuestMode(m)}
              className={`px-2.5 h-[22px] rounded-full text-[13px] leading-none transition-colors ${
                questMode === m
                  ? 'bg-amber text-black font-medium'
                  : 'text-muted hover:text-[#e6edf3]'
              }`}
            >
              {m === 'pvp' ? 'PVP' : 'PVE'}
            </button>
          ))}
        </div>

        {/* 筛选条件：好感达标 / 等级达标 / 地图解锁 / 专注模式 / 旧任务，合并为下拉多选 */}
        <div className="relative shrink-0" ref={filterRef}>
          <DropdownTrigger
            icon={
              <svg width="11" height="11" viewBox="0 0 24 24" aria-hidden>
                <path
                  d="M3 5h18l-7 8v6l-4 2v-8L3 5Z"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            }
            label="筛选"
            count={filterCount}
            active={filterCount > 0}
            open={filterOpen}
            onClick={() => setFilterOpen((o) => !o)}
            title="筛选条件：好感达标 / 等级达标 / 地图解锁 / 已完成 / 旧任务（点击展开勾选）"
          />
          {filterOpen && (
            <div className="absolute left-0 top-full mt-1.5 z-50 bg-ink-800 border border-line rounded-lg shadow-xl p-1.5 space-y-0.5 min-w-[180px] max-w-[260px] max-h-[70vh] overflow-y-auto">
              <FilterCheck
                label="好感达标"
                checked={repMet}
                onChange={setRepMet}
                title="仅显示商人忠诚等级达标的任务（在侧边栏「角色」页填写；搜索任务名时忽略此项）"
              />
              <FilterCheck
                label="等级达标"
                checked={lvlMet}
                onChange={setLvlMet}
                title="仅显示玩家等级足够的任务（搜索任务名时忽略此项）"
              />
              <FilterCheck
                label="地图解锁"
                checked={mapUnlocked}
                onChange={setMapUnlocked}
                title="仅显示已解锁（未锁定）地图的任务"
              />
              <FilterCheck
                label="已完成"
                checked={showCompleted}
                onChange={setShowCompleted}
                title="勾选时显示已完成的任务；不勾选则排除已完成任务"
              />
              <FilterCheck
                label="旧任务"
                checked={!hideLegacy}
                onChange={(v) => setHideLegacy(!v)}
                title="勾选才显示已移除的旧任务（多为旧 PvP 专属任务）"
              />
            </div>
          )}
        </div>

        {/* 商人显隐：下拉多选（默认不勾选竞技场裁判 / BTR 司机 / 灯塔守护者） */}
        <div className="relative shrink-0" ref={traderRef}>
          <DropdownTrigger
            icon={
              <svg width="11" height="11" viewBox="0 0 24 24" aria-hidden>
                <circle
                  cx="12"
                  cy="8"
                  r="3.4"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                />
                <path
                  d="M4.8 20a7.2 7.2 0 0 1 14.4 0"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                />
              </svg>
            }
            label="商人"
            count={shownTraders}
            active={hiddenTraders > 0}
            open={traderOpen}
            onClick={() => setTraderOpen((o) => !o)}
            title="选择要显示的商人（点击展开勾选）"
          />
          {traderOpen && (
            <div className="absolute left-0 top-full mt-1.5 z-50 bg-ink-800 border border-line rounded-lg shadow-xl p-1.5 space-y-0.5 min-w-[170px] max-w-[220px] max-h-[70vh] overflow-y-auto">
              {TRADERS.map((t) => (
                <FilterCheck
                  key={t.id}
                  label={traderDisplayName(t.id, t.zh)}
                  checked={!disabledTraders[t.id]}
                  onChange={(v) => setTraderGraph(t.id, !v)}
                />
              ))}
            </div>
          )}
        </div>

        {/* 地图单选筛选 */}
        <select
          value={mapSel}
          onChange={(e) => setMapSel(e.target.value)}
          title="按地图/地区筛选任务"
          className="shrink-0 bg-ink-700 border border-line text-[14px] rounded px-2 py-1 text-[#e6edf3]"
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
          className="shrink-0 bg-ink-700 border border-line text-[14px] rounded px-2 py-1 text-[#e6edf3] w-44 placeholder:text-muted"
        />

        {/* 重置视图：右对齐 */}
        <button
          onClick={() => setView({ x: 30, y: 30, scale: DEFAULT_SCALE })}
          className={`${chip} ${chipOff} ml-auto shrink-0`}
        >
          重置视图
        </button>
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

        {/* 图例：左下角浮动显示 */}
        <div className="absolute bottom-3 left-3 z-40 flex flex-col gap-1 px-2.5 py-2 rounded-md bg-ink-800/85 border border-line shadow-lg backdrop-blur-sm text-[13px] text-muted pointer-events-none">
          <span className="flex items-center gap-1.5 whitespace-nowrap"><span className="w-3 h-3 rounded-sm bg-[#14261b] border border-[#2ea043]" />已完成</span>
          <span className="flex items-center gap-1.5 whitespace-nowrap"><span className="w-3 h-3 rounded-sm bg-[#0e2438] border border-[#58a6ff]" />进行中</span>
          <span className="flex items-center gap-1.5 whitespace-nowrap"><span className="w-3 h-3 rounded-sm bg-[#231b0d] border border-[#c08a2a]" />待接取</span>
          <span className="flex items-center gap-1.5 whitespace-nowrap"><span className="w-3 h-3 rounded-sm bg-[#1f2730] border border-[#6b7682]" />后续解锁</span>
          <span className="flex items-center gap-1.5 whitespace-nowrap"><span className="w-3 h-3 rounded-sm bg-ink-800 border border-dashed border-[#a371f7]" />特殊✦</span>
        </div>

        {/* 物品悬浮 tooltip（仅在物品图标上触发） */}
        {hoverTip && tipXY && (
          <div
            className="pointer-events-none absolute z-50 w-max max-w-[190px] px-2 py-1 rounded-md bg-ink-700 border border-line shadow-xl text-[13px] text-[#c9d1d9] leading-snug"
            style={{ left: Math.min(tipXY.x + 14, csize.w - 200), top: Math.max(tipXY.y - 14, 4) }}
          >
            <span className="font-medium">{hoverTip.name}</span>
            {hoverTip.count != null && hoverTip.count > 0 && (
              <span className="text-amber">需要 ×{hoverTip.count}</span>
            )}
            <div className="text-muted font-mono text-[11px]">{hoverTip.id}</div>
          </div>
        )}

        {/* 概览面板 */}
        {selectedId && (
          <div
            onMouseDown={(e) => e.stopPropagation()}
            onWheel={(e) => e.stopPropagation()}
            style={{ maxHeight: `min(88%, calc(100% - ${miniDim.h + 36}px))` }}
            className="absolute right-3 top-3 w-[560px] min-w-[380px] max-w-[calc(100%-24px)] overflow-y-auto bg-ink-800 border border-line rounded-xl p-4 shadow-xl z-50 cursor-default"
          >
            <button
              onClick={(e) => {
                e.stopPropagation()
                if (detail) openWiki(detail.wiki)
              }}
              className="absolute right-9 top-2.5 text-amber hover:underline text-[13px]"
              title="在浏览器打开 Wiki 资料"
            >
              Wiki ↗
            </button>
            <button
              onClick={(e) => {
                e.stopPropagation()
                setSelected(null, null)
              }}
              className="absolute right-3 top-3 text-muted hover:text-[#e6edf3] text-[14px]"
            >
              ✕
            </button>
            {detail ? (
              <>
                <div className="flex items-start gap-2 pr-6 flex-wrap">
                  <span className="text-[19px] font-medium leading-snug">{detail.name}</span>
                  {selStatus === 'available' && (
                    <button
                      onClick={(e) => {
                        e.stopPropagation()
                        onSetStatus(detail.id, 'accept')
                      }}
                      className="text-[12px] text-[#58a6ff] hover:underline mt-1.5 shrink-0"
                      title="手动标记该任务为已接取"
                    >
                      手动接取
                    </button>
                  )}
                  {selStatus === 'in_progress' && (
                    <button
                      onClick={(e) => {
                        e.stopPropagation()
                        onSetStatus(detail.id, 'complete')
                      }}
                      className="text-[12px] text-[#2ea043] hover:underline mt-1.5 shrink-0"
                      title="手动标记该任务为已完成"
                    >
                      手动完成
                    </button>
                  )}
                  {selStatus === 'locked' && (
                    <button
                      onClick={(e) => {
                        e.stopPropagation()
                        onSetStatus(detail.id, 'unlock')
                      }}
                      className="text-[12px] text-muted hover:text-[#e6edf3] hover:underline mt-1.5 shrink-0"
                      title="手动解锁该任务（连同其前置）"
                    >
                      手动解锁
                    </button>
                  )}
                </div>
                <div className="text-[13px] text-muted mt-1.5 flex items-center gap-1.5 flex-wrap">
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
                    {` · ${
                      selStatus === 'completed'
                        ? '已完成'
                        : selStatus === 'in_progress'
                        ? '进行中'
                        : selStatus === 'available'
                        ? '可接取'
                        : '未解锁'
                    }`}
                  </span>
                  {detail.legacy && (
                    <span className="px-1.5 rounded border border-line text-[12px] text-muted">
                      旧任务
                    </span>
                  )}
                  {detail.legacy && (
                    <span className="px-1.5 rounded border border-red-500/40 bg-red-500/15 text-red-300 text-[12px]">
                      仅 PvP
                    </span>
                  )}
                  {detail.special && (
                    <span className="px-1.5 rounded border border-dashed border-[#a371f7] text-[#a371f7] text-[12px]">
                      特殊 ✦
                    </span>
                  )}
                </div>

                {detail.traderReqs?.length > 0 && (
                  <div className="mt-3">
                    <div className="text-[13px] text-muted mb-1">贸易条件</div>
                    <div className="space-y-1 text-[14px]">
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
                    <div className="text-[13px] text-muted mb-1">目标</div>
                    <ul className="space-y-1.5 text-[14px] text-[#c9d1d9]">
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
                )}

                {allDetailItems.length > 0 && (
                  <div className="mt-3">
                    <div className="text-[13px] text-muted mb-1">
                      所需物品{allDetailItems.length > 15 ? `（${allDetailItems.length}）` : ''}
                    </div>
                    <div className="flex flex-col gap-0.5">
                      {allDetailItems.slice(0, 15).map((it) => (
                        <span
                          key={it.id}
                          className="flex items-center gap-1 w-full rounded bg-ink-700 border border-line px-1 py-0.5"
                          title={`${it.name}${it.count ? ` ×${it.count}` : ''}`}
                        >
                          <img
                            src={`/item-icons/${it.id}.webp`}
                            alt=""
                            loading="lazy"
                            className="w-3 h-3 object-contain shrink-0"
                          />
                          <span className="flex-1 truncate text-[13px] text-[#c9d1d9]">
                            {it.name}
                          </span>
                          {it.count != null && it.count > 0 && (
                            <span className="text-amber text-[13px] shrink-0">×{it.count}</span>
                          )}
                        </span>
                      ))}
                    </div>
                    {allDetailItems.length > 15 && (
                      <button
                        onClick={(e) => {
                          e.stopPropagation()
                          setItemListOpen(true)
                        }}
                        className="mt-2 text-[14px] text-amber hover:underline"
                      >
                        显示更多 {allDetailItems.length - 15} 项物品 →
                      </button>
                    )}
                  </div>
                )}

                {detail.rewards?.length > 0 && (
                  <div className="mt-3">
                    <div className="text-[13px] text-muted mb-1">奖励</div>
                    <div className="text-[14px] text-[#c9d1d9]">
                      {detail.rewards.map((r, i) => (
                        <span key={i}>
                          {r.name} ×{r.count}
                          {i < detail.rewards.length - 1 ? '、' : ''}
                        </span>
                      ))}
                    </div>
                  </div>
                )}

                {(() => {
                  // 前置任务：pve 模式下优先展示 prereqsPve（后端仅在两种模式不同时填充）
                  const pr =
                    questMode === 'pve' && detail.prereqsPve?.length
                      ? detail.prereqs.map((p) => ({
                          ...p,
                          hidden: !detail.prereqsPve!.includes(p.id),
                        }))
                      : detail.prereqs.map((p) => ({ ...p, hidden: false }))
                  const shown = pr.filter((p) => !p.hidden)
                  if (shown.length === 0) return null
                  return (
                    <div className="mt-3">
                      <div className="text-[13px] text-muted mb-1">前置任务</div>
                      <div className="text-[14px] text-[#c9d1d9] space-y-0.5">
                        {shown.map((p) => (
                          <div key={p.id} className="truncate flex items-center gap-1">
                            <span className={completedSet.has(p.id) ? 'text-ok' : 'text-muted'}>
                              {completedSet.has(p.id) ? '✓' : '○'}
                            </span>
                            {p.name}
                          </div>
                        ))}
                      </div>
                    </div>
                  )
                })()}
              </>
            ) : (
              <div className="text-[14px] text-muted">加载中…</div>
            )}
          </div>
        )}

        {/* 物品清单弹窗：点击「显示更多」后单独展示全部所需物品 */}
        {itemListOpen && allDetailItems.length > 0 && (
          <div
            className="absolute inset-0 z-[60] flex items-center justify-center bg-black/50"
            onMouseDown={(e) => {
              e.stopPropagation()
              setItemListOpen(false)
            }}
          >
            <div
              className="w-[440px] max-w-[92%] max-h-[82%] overflow-y-auto bg-ink-800 border border-line rounded-xl p-4 shadow-2xl"
              onMouseDown={(e) => e.stopPropagation()}
            >
              <div className="flex items-center justify-between mb-3">
                <div className="text-[16px] font-medium">所需物品（{allDetailItems.length}）</div>
                <button
                  onClick={(e) => {
                    e.stopPropagation()
                    setItemListOpen(false)
                  }}
                  className="text-muted hover:text-[#e6edf3] text-[16px]"
                >
                  ✕
                </button>
              </div>
              <div className="flex flex-wrap gap-2">
                {allDetailItems.map((it) => (
                  <span
                    key={it.id}
                    className="inline-flex items-center gap-1.5 rounded bg-ink-700 border border-line pl-1 pr-2 py-1"
                    title={`${it.name}${it.count ? ` ×${it.count}` : ''}`}
                  >
                    <img
                      src={`/item-icons/${it.id}.webp`}
                      alt=""
                      loading="lazy"
                      className="w-6 h-6 object-contain"
                    />
                    <span className="text-[14px] text-[#c9d1d9] truncate max-w-[150px]">
                      {it.name}
                    </span>
                    {it.count != null && it.count > 0 && (
                      <span className="text-amber text-[14px]">×{it.count}</span>
                    )}
                  </span>
                ))}
              </div>
            </div>
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
