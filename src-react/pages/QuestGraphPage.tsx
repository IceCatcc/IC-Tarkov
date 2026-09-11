import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import type { MouseEvent as ReactMouseEvent, TouchEvent as ReactTouchEvent, WheelEvent as ReactWheelEvent } from 'react'
import { useStore, useTopPad } from '../store'
import { getQuestGraph, getQuestDetail, setQuestStatus, getMaps } from '../tauri'
import { traderImage } from '../traderImages'
import { QuestBoardView } from '../components/QuestBoardView'
import { traderDisplayName } from '../traderMeta'
import type { GraphEdge, GraphNode, ItemRef, MapInfo } from '../types'
import {
  compareMet,
  compareLabel,
  questLoyaltyLevel,
  llLabel,
} from '../types'


const ROW_H = 104
const NODE_W = 204
const NODE_H = 78
const BAND_GAP = 26

/** 默认视图缩放（初始打开时使用）：偏大以便看清节点文字 */
const DEFAULT_SCALE = 0.8

// 网格布局常量（布局与绘制共用）
// 水平间距与竖直间距一致（竖直 = ROW_H - NODE_H = 26），视觉网格均匀
const SUB_G = 26 // 小列间距（水平卡片间隔）
const ZONE_PAD_IN = 20 // 大列内边距（列与列之间，内含分区分隔线）
const EDGE_STUB = 12 // 连线出入卡片的水平引出段
const EDGE_CORNER = 8 // 正交连线的拐角圆角半径（线加粗后同步放大，拐角更顺滑）
const ROWS_CAP = 5 // 每个小列的最大行数（超出则开新小列，行数永久封顶）
// 顶部留白：原「等级标尺」已移除（等级改为标注在卡片上），仅保留区域标识的绘制空间
const GRID_TOP = 22
const BAND_X = 78 // 网格整体右移量：左侧为外置商人头像的固定屏幕沟槽
const TOP_GAP = 14 // 泳道顶边到第一行卡片的间距
const CHAIN_MARGIN = 168 // 左区（独立任务）与右侧任务链区之间的间距：留给链行标签

type NodeState = 'completed' | 'in_progress' | 'available' | 'locked'


// 视口边界留白（屏幕像素）
const VIEW_PAD = 48

// 搜索时未命中节点的淡化透明度（命中项保持原样，其余压暗但仍可见轮廓）
const DIM_ALPHA = 0.22

// 右侧任务详情面板宽度（须与下方面板的 w-[..] 一致）+ 右边距。
// 搜索命中唯一节点时用它算出「面板左侧的可用区域」，避免目标被面板挡住。
const DETAIL_PANEL_W = 480
const DETAIL_PANEL_OCCUPY = DETAIL_PANEL_W + 24

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
  // 已完成：贴近画布底色、低饱和低对比的淡绿，边框与文字都压暗，弱化存在感
  completed: { bg: '#12161a', border: '#2a3a31', text: '#6f7f77' },
  in_progress: { bg: '#0e2438', border: '#58a6ff', text: '#a8d1ff' },
  // 待接取：底色与文字保持黄色系，描边改用中性浅灰——
  // 黄色描边会与「任务链高亮」的琥珀色撞色，难以区分
  available: { bg: '#231b0d', border: '#9aa5b1', text: '#e6c089' },
  locked: { bg: '#1f2730', border: '#6b7682', text: '#c2cad3' },
}
const SPECIAL_BORDER = '#c4a7ff'

/// 系统是否要求「减少动态效果」：开启时画布上的进行中脉冲动画不播放
const REDUCED_MOTION =
  typeof window !== 'undefined' &&
  !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches

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

/** 连线与卡片之间保持的最小间隙，避免视觉上贴着卡片边 */
const CLEAR_PAD = 5

/** 卡片矩形（世界坐标），用于判断某段连线是否压到卡片 */
interface Rect {
  x: number
  y: number
  w: number
  h: number
}

/**
 * 水平段 (y, xa→xb) 是否压到卡片。
 * 端点自身所在的卡片不计入：起点是卡片右边缘、终点是卡片左边缘，
 * 用「严格内部重叠」判定天然排除了它们。
 */
function hBlocked(rects: Rect[], y: number, xa: number, xb: number): boolean {
  const lo = Math.min(xa, xb) + 0.5
  const hi = Math.max(xa, xb) - 0.5
  for (const r of rects) {
    if (r.x + r.w <= lo || r.x >= hi) continue
    if (y > r.y - CLEAR_PAD && y < r.y + r.h + CLEAR_PAD) return true
  }
  return false
}

/** 竖直段 (x, ya→yb) 是否压到卡片（判定同上，端点卡片自动排除） */
function vBlocked(rects: Rect[], x: number, ya: number, yb: number): boolean {
  const lo = Math.min(ya, yb) + 0.5
  const hi = Math.max(ya, yb) - 0.5
  for (const r of rects) {
    if (r.y + r.h <= lo || r.y >= hi) continue
    if (x > r.x - CLEAR_PAD && x < r.x + r.w + CLEAR_PAD) return true
  }
  return false
}

/**
 * 正交（曼哈顿）走线：能用短路径就用短路径，只有确实会被卡片挡住时才绕行。
 *
 * 1. 同行且中间没有卡片（相邻列）→ 直接一条直线，不再绕到行间通道；
 * 2. 不同行且两卡片水平中点是空的（相邻列）→ 4 点 Z 形（右出 → 竖直 → 左入）；
 * 3. 否则（跨多列）→ 6 点绕行：竖直段走在列间空隙，水平段走在 hChans 行间空隙。
 *    由于所有 band 的起始 y 已对齐 ROW_H 网格，行间空隙横向全宽贯通，
 *    所以绕行段也绝不会压到卡片。
 */
function orthoPath(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  hChans: number[],
  rects: Rect[],
): number[][] {
  const s = EDGE_STUB

  // 1) 同行：中间没有卡片时直接连直线（相邻列的常见情况）
  if (Math.abs(y1 - y2) < 0.5) {
    if (!hBlocked(rects, y1, x1, x2)) return [[x1, y1], [x2, y2]]
    const my = hChans.find((v) => v > y1) ?? y1 + ROW_H / 2
    return [
      [x1, y1],
      [x1 + s, y1],
      [x1 + s, my],
      [x2 - s, my],
      [x2 - s, y2],
      [x2, y2],
    ]
  }

  // 2) 不同行：竖直段放在两卡片水平中点（相邻列时该点落在列间空隙里）
  const midX = (x1 + x2) / 2
  if (
    !hBlocked(rects, y1, x1, midX) &&
    !hBlocked(rects, y2, midX, x2) &&
    !vBlocked(rects, midX, y1, y2)
  ) {
    return [
      [x1, y1],
      [midX, y1],
      [midX, y2],
      [x2, y2],
    ]
  }

  // 3) 跨多列：走行间通道绕行
  const lo = Math.min(y1, y2)
  const hi = Math.max(y1, y2)
  const mid = (lo + hi) / 2
  const cand = hChans.filter((v) => v > lo + 1 && v < hi - 1)
  const my =
    cand.length > 0
      ? cand.reduce((b, v) => (Math.abs(v - mid) < Math.abs(b - mid) ? v : b))
      : (hChans.find((v) => v > lo) ?? mid)
  return [
    [x1, y1],
    [x1 + s, y1],
    [x1 + s, my],
    [x2 - s, my],
    [x2 - s, y2],
    [x2, y2],
  ]
}

/** 绘制带圆角拐角的折线 */
function strokePolyline(ctx: CanvasRenderingContext2D, pts: number[][], r: number) {
  if (pts.length < 2) return
  ctx.beginPath()
  ctx.moveTo(pts[0][0], pts[0][1])
  for (let i = 1; i < pts.length - 1; i++) {
    ctx.arcTo(pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1], r)
  }
  ctx.lineTo(pts[pts.length - 1][0], pts[pts.length - 1][1])
  ctx.stroke()
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
  const mapNames = useStore((s) => s.mapNames)
  const boardMapFilter = useStore((s) => s.boardMapFilter)
  const setBoardMapFilter = useStore((s) => s.setBoardMapFilter)
  const page = useStore((s) => s.page)
  const openWiki = useStore((s) => s.openWiki)
  const wikiUrlFor = useStore((s) => s.wikiUrlFor)
  const hideLegacy = useStore((s) => s.hideLegacyGraph)
  const setHideLegacy = useStore((s) => s.setHideLegacyGraph)
  const repMet = useStore((s) => s.repMetGraph)
  const setRepMet = useStore((s) => s.setRepMetGraph)
  const lvlMet = useStore((s) => s.lvlMetGraph)
  const setLvlMet = useStore((s) => s.setLvlMetGraph)
  const mapUnlocked = useStore((s) => s.mapUnlockedGraph)
  const setMapUnlocked = useStore((s) => s.setMapUnlockedGraph)
  const profile = useStore((s) => s.settings.profile)
  // 「转生任务」显示开关：转生（Prestige）门槛任务，默认显示
  const showPrestige = useStore((s) => s.showPrestigeGraph)
  const setShowPrestige = useStore((s) => s.setShowPrestigeGraph)
  // 一级视图 tab：'list' 任务列表 / 'chain' 任务链图谱
  const graphTab = useStore((s) => s.graphTab)
  const setGraphTab = useStore((s) => s.setGraphTab)
  // 任务模式过滤（pvp/pve，localStorage 持久化；日志检测到会话模式时自动跟随）
  const questMode = useStore((s) => s.questMode)
  // 侧边栏折叠时，顶部工具栏为左上角浮动按钮预留空位
  // 注意：hook 必须位于所有 early return 之前，否则触发 "Rendered more hooks" 崩溃
  const topPad = useTopPad()

  // 任务板（列表视图）地图筛选选项：取自当前模式的任务，按官方中文名排序
  const boardMapOptions = useMemo(() => {
    const s = new Set<string>()
    for (const n of graph?.nodes ?? []) {
      if (n.modes && n.modes.length > 0 && !n.modes.includes(questMode)) continue
      for (const m of n.maps ?? []) if (m) s.add(m)
    }
    return Array.from(s).sort((a, b) =>
      (mapNames[a] ?? a).localeCompare(mapNames[b] ?? b, 'zh'),
    )
  }, [graph, questMode, mapNames])

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

  const canvasRef = useRef<HTMLCanvasElement>(null)
  const miniRef = useRef<HTMLCanvasElement>(null)
  const miniDragRef = useRef(false)
  // rAF 每帧绘制函数句柄（必须在早退 return 之前声明，保证 Hooks 顺序稳定）
  const frameRef = useRef<() => void>(() => {})
  const [csize, setCsize] = useState({ w: 0, h: 0 })
  // 绘制异常（rAF 内抛错会中断循环、画布停在纯黑）；捕获后显示在画布上便于无 console 排查
  const [drawErr, setDrawErr] = useState<string | null>(null)
  // 缩略图（右下角小地图）显隐开关（localStorage 持久化）。
  // 注意：必须在「if (!graph) return」早退之前声明，否则违反 Rules of Hooks 导致黑屏崩溃
  const [showMiniMap, setShowMiniMap] = useState(() => {
    try {
      return localStorage.getItem('ic-tarkov.graphMiniMap.v1') !== '0'
    } catch {
      return true
    }
  })
  const setMiniMap = (on: boolean) => {
    setShowMiniMap(on)
    try {
      localStorage.setItem('ic-tarkov.graphMiniMap.v1', on ? '1' : '0')
    } catch {
      /* ignore */
    }
  }

  // 持续 rAF 绘制循环（硬件加速合成，单画布 ~2000 图元 ≈1ms/帧）。
  // 必须与其它 Hooks 一样位于条件 return 之前，否则触发 Hooks 顺序错误。
  useEffect(() => {
    let raf = 0
    const loop = () => {
      try {
        frameRef.current()
        setDrawErr((prev) => (prev === null ? prev : null))
      } catch (e) {
        const msg = String((e as Error)?.stack ?? e)
        setDrawErr((prev) => (prev === msg ? prev : msg))
      }
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
  const { positions, visible, width, height, bands, zones, llBands, chainRows, matches } = useMemo(() => {
    const empty = {
      positions: {} as Record<string, { x: number; y: number }>,
      visible: new Set<string>(),
      width: 0,
      height: 0,
      bands: [] as { id: string; name: string; y: number; h: number }[],
      zones: [] as {
        left: number
        right: number
        label: string
        subs: number[]
      }[],
      llBands: [] as {
        left: number
        right: number
        ll: number
        bg: string
        line: string
        text: string
      }[],
      chainRows: [] as {
        idx: number
        name: string
        traderId: string
        left: number
        y: number
        h: number
      }[],
      matches: null as Set<string> | null,
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
    // 专注于「需求过滤」（好感 / 等级 / 地图 / 商人 / 赛季任务 / 地区），不含搜索。
    const effRepMet = repMet
    const effLvlMet = lvlMet
    const reqFails = (n: GraphNode): boolean => {
      if (hideLegacy && n.legacy) return true
      if (!showPrestige && n.prestigeLevel != null) return true
      // 商人筛选与地区筛选均已移除，不再参与链条隐藏传播
      if (hasLockedMap(n.maps)) return true
      // 模式过滤（pvp/pve）：不属于当前模式的任务视为隐藏，并参与任务链传播
      if (!modeOk(n)) return true
      const ll = profile?.loyalty?.[n.traderId] ?? 1
      if (effRepMet && ll === 0) return true
      if (effLvlMet && (n.minLevel ?? 1) > Math.max(1, profile?.level ?? 1)) return true
      if (effRepMet) {
        for (const r of n.traderReqs ?? []) {
          if (r.reqType === 'reputation') continue
          if (
            !compareMet(profile?.loyalty?.[r.traderId] ?? 1, r.value, r.compare)
          ) {
            return true
          }
        }
      }
      return false
    }
    const vis = new Set<string>()
    for (const n of graph.nodes) {
      if (!modeOk(n)) continue
      if (hideLegacy && n.legacy) continue
      if (!showPrestige && n.prestigeLevel != null) continue
      // 地图可用过滤：涉及未解锁地图的任务不显示
      if (hasLockedMap(n.maps)) continue
      // 搜索不再剔除节点：只记录命中集合，未命中项在绘制时淡化，保留上下文与布局稳定
      vis.add(n.id)
    }

    // 搜索命中集合：非空查询时，未命中的节点与连线在绘制阶段压暗
    let matches: Set<string> | null = null
    if (q) {
      matches = new Set<string>()
      for (const n of graph.nodes) {
        if (n.name.toLowerCase().includes(q)) matches.add(n.id)
      }
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
            if (r.reqType === 'reputation') continue
            if (
              !compareMet(profile?.loyalty?.[r.traderId] ?? 1, r.value, r.compare)
            ) {
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
    // 被「需求过滤」（好感 / 等级 / 地图 / 商人 / 赛季任务 / 地区）隐藏的前置任务，
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

    // —— 任务分区：独立任务（无前置也无后继）与任务链（依赖图的连通分量） ——
    // 独立任务放左侧、按 LL 档位分列；任务链放最右侧，每条链一行、链内从左到右推进。
    // 判定基于完整任务图（不看筛选），切换筛选时任务不会在两个区之间跳变。
    const soloSet = new Set<string>()
    {
      const allPre = new Set<string>()
      const allSucc = new Set<string>()
      for (const n of graph.nodes) {
        const ps = prereqsOf(n)
        if (ps.length > 0) allPre.add(n.id)
        for (const p of ps) allSucc.add(p)
      }
      for (const n of graph.nodes) {
        if (!allPre.has(n.id) && !allSucc.has(n.id)) soloSet.add(n.id)
      }
    }
    // 链分组：把「有依赖的任务」按无向连通分量切成若干条链。
    // 连通分量内才有边，因此链之间没有任何连线，可以各自独立排一行。
    const compOf = new Map<string, number>()
    {
      const adj = new Map<string, string[]>()
      for (const n of graph.nodes) {
        const ps = prereqsOf(n).filter((p) => nodeMap[p])
        if (ps.length === 0) continue
        const a = adj.get(n.id) ?? []
        for (const p of ps) {
          a.push(p)
          const b = adj.get(p) ?? []
          b.push(n.id)
          adj.set(p, b)
        }
        adj.set(n.id, a)
      }
      let ci = 0
      const seen = new Set<string>()
      for (const n of graph.nodes) {
        if (seen.has(n.id) || !adj.has(n.id)) continue
        const stack = [n.id]
        seen.add(n.id)
        while (stack.length) {
          const u = stack.pop()!
          compOf.set(u, ci)
          for (const v of adj.get(u) ?? []) {
            if (!seen.has(v)) {
              seen.add(v)
              stack.push(v)
            }
          }
        }
        ci++
      }
    }
    // 「任务链」视图不显示独立任务（无依赖的任务），只保留任务链上的任务
    if (graphTab === 'chain') {
      for (const id of soloSet) vis.delete(id)
    }

    // 独立任务的列 = 自身 LL 档位（0 = 无要求 / 1 = LL1 / … / 4 = LL4）
    const colOf = new Map<string, number>()
    for (const id of vis) {
      if (!soloSet.has(id)) continue
      const n = nodeMap[id]
      colOf.set(id, n ? questLoyaltyLevel(n) : 0)
    }

    // 拓扑深度（链上第几环，只看当前模式的前置）：用于「列内排序」。
    // 同一等级列内必须保持链的顺序（前置在上），否则会出现「3 排在 2 前面」这种错乱。
    const depthCache = new Map<string, number>()
    const depthOf = (id: string): number => {
      const cached = depthCache.get(id)
      if (cached !== undefined) return cached
      depthCache.set(id, 0) // 兜底：数据成环也不会无限递归
      const n = nodeMap[id]
      let d = 0
      if (n) {
        for (const p of prereqsOf(n)) {
          if (!nodeMap[p]) continue
          d = Math.max(d, depthOf(p) + 1)
        }
      }
      depthCache.set(id, d)
      return d
    }

    // 分区桶（只含独立任务）：列即 LL 档位；列内按「链顺序（拓扑深度）」-> 名称排序
    const buckets = new Map<number, { id: string; sortKey: number; lvReal: number }[]>()
    for (const n of graph.nodes) {
      if (!vis.has(n.id) || !soloSet.has(n.id)) continue
      const key = colOf.get(n.id)!
      const lvReal = n.minLevel ?? 1
      let b = buckets.get(key)
      if (!b) {
        b = []
        buckets.set(key, b)
      }
      b.push({ id: n.id, sortKey: depthOf(n.id), lvReal })
    }
    const zoneKeys = Array.from(buckets.keys()).sort((a, b) => a - b)
    const repLv = new Map<number, number>() // 稠密分区号 -> 代表性解锁等级
    zoneKeys.forEach((k, i) => {
      const items = buckets.get(k)!
      repLv.set(i, Math.min(...items.map((x) => x.lvReal)))
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
          a.sortKey - b.sortKey ||
          (nodeMap[a.id]?.name ?? '').localeCompare(nodeMap[b.id]?.name ?? ''),
      )
      for (const it of items) {
        seqIdxOf.set(it.id, seq.length)
        seq.push({ id: it.id, R: r })
      }
    }
    const ROf = new Map<string, number>()
    for (const s of seq) ROf.set(s.id, s.R)

    // —— 左侧「独立任务区」网格几何：每个等级一个大列；列内「无限小列」；
    //     小列内最多堆叠 ROWS_CAP 张卡，超出则换下一小列 —— 行数被永久封顶，
    //     数量再多的同等级任务也只会向右扩展，而不是把第一列挤成一根长柱。
    interface Group {
      id: string
      name: string
      ids: string[]
    }
    const groups = new Map<string, Group>()
    for (const n of graph.nodes) {
      if (!vis.has(n.id) || !soloSet.has(n.id)) continue
      const key = n.traderId || n.traderName || 'unknown'
      let g = groups.get(key)
      if (!g) {
        g = { id: key, name: n.traderName || '未知', ids: [] }
        groups.set(key, g)
      }
      g.ids.push(n.id)
    }

    // (商人, 等级列) 单元的布局：独立任务没有依赖，按深度分组即所有卡同组，
    // 于是退化为「每 ROWS_CAP 张卡换一小列」；小列数与行数可在重心排序前先算。
    const unitShapes = new Map<string, { cols: number; rows: number }>()
    {
      const byPair = new Map<string, Map<number, number>>() // `${bandId}|${列}` -> (深度 -> 张数)
      for (const n of graph.nodes) {
        if (!vis.has(n.id) || !soloSet.has(n.id)) continue
        const R = ROf.get(n.id)
        if (R === undefined) continue
        const key = `${n.traderId || n.traderName || 'unknown'}|${R}`
        let m = byPair.get(key)
        if (!m) {
          m = new Map()
          byPair.set(key, m)
        }
        const d = depthOf(n.id)
        m.set(d, (m.get(d) ?? 0) + 1)
      }
      for (const [key, m] of byPair) {
        let cols = 0
        let rows = 1
        for (const c of m.values()) {
          cols += Math.ceil(c / ROWS_CAP)
          rows = Math.max(rows, Math.min(c, ROWS_CAP))
        }
        unitShapes.set(key, { cols: Math.max(cols, 1), rows })
      }
    }
    // 每个等级列的小列数取该列下所有商人的最大值
    const subColsOf = new Map<number, number>()
    for (const [key, shape] of unitShapes) {
      const r = Number(key.slice(key.lastIndexOf('|') + 1))
      subColsOf.set(r, Math.max(subColsOf.get(r) ?? 1, shape.cols))
    }

    const zoneLeft = new Map<number, number>()
    const zones: {
      left: number
      right: number
      label: string
      subs: number[]
    }[] = []
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

    // —— 忠诚等级（LL）带 ——
    // 列本身就是 LL 档位，所以每个大列即一个带：纵向底色 + 顶部标签 + 分界竖线。
    // 带取该列任务的 LL（同列必然同档），用于给底色 / 标签配色。
    const LL_STYLE: Record<number, { bg: string; line: string; text: string }> = {
      1: {
        bg: 'rgba(255,255,255,0.020)',
        line: 'rgba(139,148,158,0.35)',
        text: 'rgba(170,180,190,0.95)',
      },
      2: {
        bg: 'rgba(111,179,255,0.030)',
        line: 'rgba(111,179,255,0.38)',
        text: 'rgba(111,179,255,0.95)',
      },
      3: {
        bg: 'rgba(239,159,39,0.034)',
        line: 'rgba(239,159,39,0.42)',
        text: 'rgba(239,159,39,0.95)',
      },
      4: {
        bg: 'rgba(248,81,73,0.032)',
        line: 'rgba(248,81,73,0.40)',
        text: 'rgba(248,81,73,0.95)',
      },
    }
    const llBands: {
      left: number
      right: number
      ll: number
      bg: string
      line: string
      text: string
    }[] = zones.map((z, r) => {
      const ll = zoneKeys[r]
      const s = LL_STYLE[ll]
      return {
        left: z.left,
        right: z.right,
        ll,
        bg: s?.bg ?? '',
        line: s?.line ?? '',
        text: s?.text ?? '',
      }
    })

    const positions: Record<string, { x: number; y: number }> = {}
    const bandsOut: { id: string; name: string; y: number; h: number }[] = []

    // —— 商人泳道顺序：按「任务流向」的重心排序 ——
    // 原本按商人名称字母序排列，与任务链走向无关，导致连线在纵向来回大幅跳跃。
    // 这里用商人级别的邻接做重心迭代，让往来频繁的商人在纵向相邻，连线更短。
    // 注意：基于**完整任务图**计算（不看筛选），切换筛选/模式时泳道顺序保持稳定。
    const bandNeighbors = new Map<string, Set<string>>()
    for (const e of graph.edges) {
      const a = nodeMap[e.from]
      const b = nodeMap[e.to]
      if (!a || !b) continue
      const ta = a.traderId || a.traderName || 'unknown'
      const tb = b.traderId || b.traderName || 'unknown'
      if (ta === tb) continue
      {
        const s = bandNeighbors.get(ta) ?? new Set<string>()
        s.add(tb)
        bandNeighbors.set(ta, s)
      }
      {
        const s = bandNeighbors.get(tb) ?? new Set<string>()
        s.add(ta)
        bandNeighbors.set(tb, s)
      }
    }
    const groupList = Array.from(groups.values())
    let bandOrder: Group[] = groupList
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name))
    {
      let rank = new Map(bandOrder.map((g, i) => [g.id, i] as [string, number]))
      for (let it = 0; it < 40; it++) {
        const scored = bandOrder.map((g) => {
          const nb = bandNeighbors.get(g.id)
          let sum = 0
          let n = 0
          if (nb) {
            for (const x of nb) {
              const r = rank.get(x)
              if (r !== undefined) {
                sum += r
                n++
              }
            }
          }
          return {
            g,
            d: n > 0 ? sum / n : (rank.get(g.id) ?? 0),
            self: rank.get(g.id) ?? 0,
          }
        })
        scored.sort((a, b) => a.d - b.d || a.self - b.self)
        const next = scored.map((x) => x.g)
        if (next.every((g, i) => g.id === bandOrder[i].id)) break
        bandOrder = next
        rank = new Map(bandOrder.map((g, i) => [g.id, i] as [string, number]))
      }
    }

    // 每个泳道的行数：取该泳道各等级列单元的行数最大值（见上面的 unitShapes）
    const bandRowsOf = new Map<string, number>()
    for (const g of groups.values()) {
      let mr = 1
      for (const [key, shape] of unitShapes) {
        if (!key.startsWith(`${g.id}|`)) continue
        mr = Math.max(mr, shape.rows)
      }
      bandRowsOf.set(g.id, mr)
    }

    const bandTopY = new Map<string, number>()
    {
      let yCursor = GRID_TOP
      for (const g of bandOrder) {
        bandTopY.set(g.id, yCursor)
        const bandH = TOP_GAP + (bandRowsOf.get(g.id) ?? 1) * ROW_H
        // 下一个 band 的起始 y 向上取整到 ROW_H 的整数倍：
        // 这样所有 band 的「行 y」都落在同一条全局网格上，行与行之间的空隙
        // 成为横向全宽贯通的通道，连线可以贴着它走而永不压到卡片。
        yCursor += Math.ceil((bandH + BAND_GAP) / ROW_H) * ROW_H
      }
    }

    // —— 单元（泳道 × 分区）内的纵向顺序：重心排序 ——
    // 让每张卡片尽量对齐到它的前置/后继所在的行，从而连线更短更直、交叉更少。
    const cells = new Map<string, string[]>() // `${bandId}|${R}` -> 卡片 id（有序）
    for (const g of groups.values()) {
      for (const id of g.ids) {
        const R = ROf.get(id)
        if (R === undefined) continue
        const key = `${g.id}|${R}`
        const arr = cells.get(key)
        if (arr) arr.push(id)
        else cells.set(key, [id])
      }
    }
    // 初始顺序：忠诚等级 -> 名称（与全局序列一致），保证无依赖任务也有稳定次序
    for (const arr of cells.values()) {
      arr.sort((a, b) => seqIdxOf.get(a)! - seqIdxOf.get(b)!)
    }

    // 邻接表（仅可见节点 + 当前模式的有效边）
    const predsOf = new Map<string, string[]>()
    const succsOf = new Map<string, string[]>()
    for (const e of graph.edges) {
      if (!vis.has(e.from) || !vis.has(e.to)) continue
      if (!edgeValid(e)) continue
      {
        const arr = predsOf.get(e.to)
        if (arr) arr.push(e.from)
        else predsOf.set(e.to, [e.from])
      }
      {
        const arr = succsOf.get(e.from)
        if (arr) arr.push(e.to)
        else succsOf.set(e.from, [e.to])
      }
    }

    // 卡片当前 y：由它所在单元的次序决定（前 ROWS_CAP 个占满第一小列的行）
    const yOf = new Map<string, number>()
    // 单元内布局：按「拓扑深度」把小列从左到右排开（深度小的在左），
    // 同一深度内每 ROWS_CAP 张卡换下一小列。要求 arr 已按深度排序（cells 满足）。
    const unitLayout = (arr: string[]): { cols: string[][]; rows: number } => {
      const cols: string[][] = []
      let i = 0
      while (i < arr.length) {
        const dep = depthOf(arr[i])
        let j = i
        while (j < arr.length && depthOf(arr[j]) === dep) j++
        for (let k = i; k < j; k += ROWS_CAP) {
          cols.push(arr.slice(k, Math.min(k + ROWS_CAP, j)))
        }
        i = j
      }
      let rows = 1
      for (const c of cols) rows = Math.max(rows, c.length)
      return { cols, rows }
    }
    const refreshCell = (key: string) => {
      const arr = cells.get(key)
      if (!arr) return
      const bandId = key.slice(0, key.lastIndexOf('|'))
      const top = bandTopY.get(bandId) ?? GRID_TOP
      // 行号 = 卡片在其「深度分组小列」内的位置（与 positions 的算法保持一致）
      for (const col of unitLayout(arr).cols) {
        col.forEach((id, row) => {
          yOf.set(id, top + TOP_GAP + row * ROW_H)
        })
      }
    }
    for (const key of cells.keys()) refreshCell(key)

    /** 邻居的平均 y（重心）；无邻居时保持原位 */
    const baryOf = (id: string, adj: Map<string, string[]>): number => {
      const nb = adj.get(id)
      if (!nb || nb.length === 0) return yOf.get(id) ?? 0
      let sum = 0
      let n = 0
      for (const x of nb) {
        const y = yOf.get(x)
        if (y !== undefined) {
          sum += y
          n++
        }
      }
      return n > 0 ? sum / n : (yOf.get(id) ?? 0)
    }
    const reorderCell = (key: string, adj: Map<string, string[]>): boolean => {
      const arr = cells.get(key)
      if (!arr || arr.length < 2) return false
      // 主键是「链顺序（拓扑深度）」：同一等级列内前置必须排在后继之前，
      // 否则会出现「3 排在 2 前面」；重心只用于同一深度的多个任务之间减少连线交叉。
      const scored = arr.map((id) => ({
        id,
        dep: depthOf(id),
        d: baryOf(id, adj),
        s: seqIdxOf.get(id)!,
      }))
      scored.sort((a, b) => a.dep - b.dep || a.d - b.d || a.s - b.s)
      const next = scored.map((x) => x.id)
      if (next.every((id, i) => id === arr[i])) return false
      cells.set(key, next)
      refreshCell(key)
      return true
    }

    // 反向 -> 正向 交替迭代（Gauss-Seidel 式：用刚更新的邻居位置继续算，收敛更快）。
    // 顺序很重要：每轮以「正向（对齐前置）」收尾，因为前置才是玩家实际推进的方向。
    // 实测交叉数：不排序 285 -> 正向收尾 234（-18%）；若以反向收尾则为 250。
    for (let it = 0; it < 8; it++) {
      let changed = false
      for (let r = zoneKeys.length - 1; r >= 0; r--) {
        for (const g of groups.values()) {
          if (reorderCell(`${g.id}|${r}`, succsOf)) changed = true
        }
      }
      for (let r = 0; r < zoneKeys.length; r++) {
        for (const g of groups.values()) {
          if (reorderCell(`${g.id}|${r}`, predsOf)) changed = true
        }
      }
      if (!changed) break
    }

    for (const g of bandOrder) {
      bandsOut.push({
        id: g.id,
        name: g.name,
        y: bandTopY.get(g.id) ?? GRID_TOP,
        h: TOP_GAP + (bandRowsOf.get(g.id) ?? 1) * ROW_H,
      })
    }
    for (const g of groups.values()) {
      for (let r = 0; r < zoneKeys.length; r++) {
        const arr = cells.get(`${g.id}|${r}`)
        if (!arr) continue
        // 小列按「拓扑深度」从左到右排：链越靠后越靠右（与 unitShapes 的统计一致）
        unitLayout(arr).cols.forEach((col, sub) => {
          col.forEach((id, row) => {
            positions[id] = {
              x: zoneLeft.get(r)! + ZONE_PAD_IN + sub * (NODE_W + SUB_G),
              y: (bandTopY.get(g.id) ?? GRID_TOP) + TOP_GAP + row * ROW_H,
            }
          })
        })
      }
    }

    // —— 右侧「任务链区」：每条链一行，链内按「链内深度」从左到右 ——
    // 链之间没有连线（只有连通分量内部才有边），所以每行独立、互不干扰；
    // 一条链里的任务即使跨了好几个商人，也仍然排在同一行。
    const chainRows: {
      idx: number
      name: string
      traderId: string
      left: number
      y: number
      h: number
    }[] = []
    {
      const leftRight = zones.length > 0 ? zones[zones.length - 1].right : BAND_X
      const chainX0 = leftRight + CHAIN_MARGIN
      // 只给「当前可见任务数 > 0」的链分配行，保证紧凑
      const byChain = new Map<number, string[]>()
      for (const id of vis) {
        const c = compOf.get(id)
        if (c === undefined) continue
        const arr = byChain.get(c) ?? []
        arr.push(id)
        byChain.set(c, arr)
      }
      const nameOf = (id: string) => nodeMap[id]?.name ?? ''
      const chainList = Array.from(byChain.entries()).sort(
        (a, b) => b[1].length - a[1].length || nameOf(a[1][0]).localeCompare(nameOf(b[1][0])),
      )
      let yCursor = GRID_TOP
      for (const [ci, ids] of chainList) {
        // 链内相对深度：减掉该链的最小深度，链头即第 0 列
        const deps = ids.map((id) => depthOf(id))
        const minDep = Math.min(...deps)
        const cols = new Map<number, string[]>()
        for (const id of ids) {
          const d = depthOf(id) - minDep
          const arr = cols.get(d) ?? []
          arr.push(id)
          cols.set(d, arr)
        }
        let rows = 1
        for (const arr of cols.values()) {
          arr.sort((a, b) => nameOf(a).localeCompare(nameOf(b)))
          rows = Math.max(rows, Math.min(arr.length, ROWS_CAP))
        }
        const h = TOP_GAP + rows * ROW_H
        // 链头（第 0 列的第一个任务）作为该行的标签
        const head = (cols.get(0) ?? ids)[0]
        chainRows.push({
          idx: ci,
          name: head ? nameOf(head) : '',
          traderId: head ? nodeMap[head]?.traderId ?? '' : '',
          left: chainX0,
          y: yCursor,
          h,
        })
        // 列宽按该深度的卡片数动态扩展（每 ROWS_CAP 张占一个小列宽）
        let x = chainX0
        const maxD = Math.max(...cols.keys())
        for (let d = 0; d <= maxD; d++) {
          const arr = cols.get(d) ?? []
          arr.forEach((id, k) => {
            positions[id] = {
              x: x + Math.floor(k / ROWS_CAP) * (NODE_W + SUB_G),
              y: yCursor + TOP_GAP + (k % ROWS_CAP) * ROW_H,
            }
          })
          x += Math.max(1, Math.ceil(arr.length / ROWS_CAP)) * (NODE_W + SUB_G)
        }
        yCursor += Math.ceil((h + BAND_GAP) / ROW_H) * ROW_H
      }
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
    }
    // 高度取最后一个泳道的底部（泳道顺序按任务流向排列，不再是字母序）
    if (bandsOut.length > 0) {
      const last = bandsOut[bandsOut.length - 1]
      boundH = Math.max(boundH, last.y + last.h)
    }
    // 任务链区可能比左区更长，高度同样要覆盖到最后一条链
    if (chainRows.length > 0) {
      const last = chainRows[chainRows.length - 1]
      boundH = Math.max(boundH, last.y + last.h)
    }

    return {
      positions,
      visible: vis,
      width: boundW,
      height: boundH,
      bands: bandsOut,
      zones,
      llBands,
      chainRows,
      matches,
    }
  }, [graph, search, hideLegacy, repMet, lvlMet, mapUnlocked, profile, statusMap, completedSet, unlockedSet, questMode, showPrestige, graphTab])

  // 搜索唯一命中项：命中数恰好为 1 时自动把视图居中过去（不改变缩放）
  const soleMatchId = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q || !graph) return null
    const hit = graph.nodes.filter(
      (n) => visible.has(n.id) && n.name.toLowerCase().includes(q),
    )
    return hit.length === 1 ? hit[0].id : null
  }, [search, graph, visible])

  useEffect(() => {
    if (!soleMatchId) return
    const p = positions[soleMatchId]
    if (!p || csize.w <= 0 || csize.h <= 0) return
    setView((v) => {
      // 详情面板打开时，只在面板左侧的可用区域里居中，避免目标被面板挡住
      const availW = Math.max(120, csize.w - (selectedId ? DETAIL_PANEL_OCCUPY : 0))
      const x = availW / 2 - (p.x + NODE_W / 2) * v.scale
      const y = csize.h / 2 - (p.y + NODE_H / 2) * v.scale
      const c = clampView({ scale: v.scale, x, y }, width, height, csize.w, csize.h)
      return { ...v, ...c }
    })
    // selectedId 只用于计算可用宽度，变化时不重复居中
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [soleMatchId, positions, width, height, csize.w, csize.h])

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

  // 行间水平通道（全宽贯通）：每张卡片下方的空隙中线。
  // band 起始 y 已对齐 ROW_H 网格，因此这些 y 值在整个画布宽度上都是空的。
  const hChans = useMemo(() => {
    const out: number[] = []
    const first = GRID_TOP + TOP_GAP + NODE_H + (ROW_H - NODE_H) / 2
    for (let y = first; y < height + ROW_H; y += ROW_H) out.push(y)
    return out
  }, [height])

  // 可见卡片的矩形（世界坐标），供走线判断是否被遮挡
  const nodeRects = useMemo(() => {
    const out: Rect[] = []
    if (!graph) return out
    for (const n of graph.nodes) {
      const p = positions[n.id]
      if (!p || !visible.has(n.id)) continue
      out.push({ x: p.x, y: p.y, w: NODE_W, h: NODE_H })
    }
    return out
  }, [graph, positions, visible])

  const edges = useMemo(() => {
    if (!graph) return []
    const nodeById = new Map<string, GraphNode>()
    for (const n of graph.nodes) nodeById.set(n.id, n)
    const out: {
      id: string
      /** 正交折线路径点（起点 → … → 终点） */
      pts: number[][]
      doneEdge: boolean
      /** 起点任务是「进行中」：这条线用于流动动画，提示下一步走向 */
      flowing: boolean
      from: string
      to: string
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
        pts: orthoPath(
          a.x + NODE_W,
          a.y + NODE_H / 2,
          b.x,
          b.y + NODE_H / 2,
          hChans,
          nodeRects,
        ),
        doneEdge: statusMap[e.from] === 'completed',
        flowing: statusMap[e.from] === 'in_progress',
        from: e.from,
        to: e.to,
      })
    }
    return out
  }, [graph, visible, positions, statusMap, questMode, hChans, nodeRects])

  // 点击节点所属的整条任务链（全部祖先 + 全部后代），用于高亮；信息面板仍只显示点击的那个
  const chainIds = useMemo(() => {
    const set = new Set<string>()
    if (!graph || !selectedId || !visible.has(selectedId)) return set
    const nodeById = new Map<string, GraphNode>()
    for (const n of graph.nodes) nodeById.set(n.id, n)
    const fwd = new Map<string, string[]>()
    const back = new Map<string, string[]>()
    for (const e of graph.edges) {
      if (!visible.has(e.from) || !visible.has(e.to)) continue
      const v = nodeById.get(e.to)
      const pr = questMode === 'pve' && v?.prereqsPve?.length ? v.prereqsPve : v?.prereqs
      if (!pr?.includes(e.from)) continue
      if (!fwd.has(e.from)) fwd.set(e.from, [])
      if (!back.has(e.to)) back.set(e.to, [])
      fwd.get(e.from)!.push(e.to)
      back.get(e.to)!.push(e.from)
    }
    const walk = (adj: Map<string, string[]>) => {
      const stack = [selectedId]
      while (stack.length) {
        const u = stack.pop()!
        for (const v of adj.get(u) ?? []) {
          if (!set.has(v)) {
            set.add(v)
            stack.push(v)
          }
        }
      }
    }
    set.add(selectedId)
    walk(fwd) // 后代
    walk(back) // 祖先
    return set
  }, [graph, visible, selectedId, questMode])

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
      selectAt(e.clientX, e.clientY)
    }
  }
  const onMouseLeave = () => {
    dragRef.current = null
    setHover(null)
    setCursor('grab')
  }

  // 点选：命中节点则选中，否则关闭详情弹窗（鼠标与触摸共用）
  const selectAt = (clientX: number, clientY: number) => {
    const el = canvasRef.current
    if (!el) return
    const { wx, wy } = screenToWorld(clientX, clientY, el)
    const n = hitTest(wx, wy)
    if (n) {
      select(n.id)
    } else if (selectedId) {
      setSelected(null, null)
    }
  }

  // —— 触摸（移动端）：单指拖动/点选，双指捏合以中点为锚缩放 ——
  const touchRef = useRef<{
    mode: 'drag' | 'pinch'
    sx: number
    sy: number
    vx: number
    vy: number
    moved: boolean
    // pinch：起始距离 / 起始缩放 / 起始锚点与视图位置
    dist0: number
    scale0: number
    ax0: number
    ay0: number
    x0: number
    y0: number
  } | null>(null)

  const touchDist = (t: React.TouchList) =>
    Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY)

  const onTouchStart = (e: ReactTouchEvent<HTMLDivElement>) => {
    if (e.touches.length === 1) {
      const t = e.touches[0]
      touchRef.current = {
        mode: 'drag',
        sx: t.clientX,
        sy: t.clientY,
        vx: view.x,
        vy: view.y,
        moved: false,
        dist0: 0,
        scale0: view.scale,
        ax0: 0,
        ay0: 0,
        x0: view.x,
        y0: view.y,
      }
    } else if (e.touches.length >= 2) {
      const rect = canvasRef.current?.getBoundingClientRect()
      if (!rect) return
      const ax = (e.touches[0].clientX + e.touches[1].clientX) / 2 - rect.left
      const ay = (e.touches[0].clientY + e.touches[1].clientY) / 2 - rect.top
      touchRef.current = {
        mode: 'pinch',
        sx: 0,
        sy: 0,
        vx: 0,
        vy: 0,
        moved: false,
        dist0: touchDist(e.touches),
        scale0: view.scale,
        ax0: ax,
        ay0: ay,
        x0: view.x,
        y0: view.y,
      }
    }
  }

  const onTouchMove = (e: ReactTouchEvent<HTMLDivElement>) => {
    const s = touchRef.current
    if (!s) return
    if (s.mode === 'drag' && e.touches.length === 1) {
      const t = e.touches[0]
      const dx = t.clientX - s.sx
      const dy = t.clientY - s.sy
      if (Math.abs(dx) > 3 || Math.abs(dy) > 3) s.moved = true
      setView((v) => ({
        ...v,
        ...clampView({ scale: v.scale, x: s.vx + dx, y: s.vy + dy }, width, height, csize.w, csize.h),
      }))
    } else if (s.mode === 'pinch' && e.touches.length >= 2) {
      const rect = canvasRef.current?.getBoundingClientRect()
      if (!rect || s.dist0 <= 0) return
      const ax = (e.touches[0].clientX + e.touches[1].clientX) / 2 - rect.left
      const ay = (e.touches[0].clientY + e.touches[1].clientY) / 2 - rect.top
      const ns = Math.min(2, Math.max(0.12, s.scale0 * (touchDist(e.touches) / s.dist0)))
      // 保持捏合起始锚点下的世界坐标不动
      const wx = (s.ax0 - s.x0) / s.scale0
      const wy = (s.ay0 - s.y0) / s.scale0
      setView(() => {
        const c = clampView({ scale: ns, x: ax - wx * ns, y: ay - wy * ns }, width, height, csize.w, csize.h)
        return { scale: ns, ...c }
      })
    }
  }

  const onTouchEnd = (e: ReactTouchEvent<HTMLDivElement>) => {
    const s = touchRef.current
    touchRef.current = null
    if (!s) return
    if (s.mode === 'drag' && !s.moved) {
      const t = e.changedTouches[0]
      if (t) selectAt(t.clientX, t.clientY)
    }
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
    return <div className="p-6 text-muted text-[15px]">加载任务数据…</div>
  }

  const selectedNode = selectedId ? (graph.nodes.find((n) => n.id === selectedId) ?? null) : null
  const selAvatar = traderImage(selectedNode?.traderId)

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
    // 忠诚等级带底色：叠在列的交替底色之上，只对 LL≥2 的带着色
    for (const b of llBands) {
      if (!b.bg) continue
      ctx.fillStyle = b.bg
      ctx.fillRect(b.left, 0, b.right - b.left, height)
    }
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

    // 忠诚等级带：分界竖线（标签改为屏幕空间固定字号绘制，见下方 HUD）
    for (const b of llBands) {
      if (!b.line) continue
      ctx.strokeStyle = b.line
      ctx.lineWidth = 2
      ctx.beginPath()
      ctx.moveTo(b.left + 1, 0)
      ctx.lineTo(b.left + 1, height)
      ctx.stroke()
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

    // 任务链区：每条链一行的底色条（链之间没有连线，各占一行）
    for (const cr of chainRows) {
      ctx.fillStyle = 'rgba(255,255,255,0.016)'
      rr(ctx, cr.left, cr.y, Math.max(width - cr.left - 8, 0), cr.h, 10)
      ctx.fill()
      ctx.strokeStyle = '#262c36'
      ctx.lineWidth = 1
      ctx.stroke()
    }
    // 链行标签：右对齐于链区左侧（该行链头任务名），提示这行是哪条链
    ctx.textAlign = 'right'
    ctx.textBaseline = 'middle'
    ctx.font = '600 13px "Segoe UI", system-ui, sans-serif'
    for (const cr of chainRows) {
      const label = cr.name.length > 10 ? cr.name.slice(0, 9) + '…' : cr.name
      ctx.fillStyle = 'rgba(186,196,206,0.9)'
      ctx.fillText(label, cr.left - 10, cr.y + 26)
    }
    ctx.textAlign = 'left'
    ctx.textBaseline = 'alphabetic'

    // 搜索淡化：节点未命中时压暗；连线两端都未命中才压暗（保留命中项的上下游连线）
    const alphaOf = (id: string): number =>
      matches && !matches.has(id) ? DIM_ALPHA : 1
    const alphaOfEdge = (from: string, to: string): number =>
      matches && !matches.has(from) && !matches.has(to) ? DIM_ALPHA : 1

    // 连线：正交折线（先画普通，再画链内高亮，避免被覆盖）
    ctx.lineJoin = 'round'
    ctx.lineCap = 'round'
    for (const e of edges) {
      ctx.globalAlpha = alphaOfEdge(e.from, e.to)
      if (e.flowing) {
        // 进行中出发的连线：整体走蓝色系，与流动层同色，避免两种颜色叠在一起发花
        ctx.strokeStyle = 'rgba(88,166,255,0.45)'
        ctx.lineWidth = 3.4
      } else {
        // 未完成依赖：加粗且提亮（浅灰白），在深色画布上清晰可辨；
        // 已完成依赖：保持细而暗的绿色，与「弱化已完成」的整体取向一致
        ctx.strokeStyle = e.doneEdge ? 'rgba(86,140,104,0.6)' : '#aab6c2'
        ctx.lineWidth = e.doneEdge ? 3 : 3.8
      }
      strokePolyline(ctx, e.pts, EDGE_CORNER)
    }
    if (chainIds.size > 0) {
      for (const e of edges) {
        if (!chainIds.has(e.from) || !chainIds.has(e.to)) continue
        ctx.globalAlpha = alphaOfEdge(e.from, e.to)
        ctx.strokeStyle = e.doneEdge ? 'rgba(63,185,80,0.95)' : '#ef9f27'
        // 高亮链要比加粗后的普通连线更粗，才能继续凸显
        ctx.lineWidth = 5.2
        strokePolyline(ctx, e.pts, EDGE_CORNER)
      }
    }
    // 进行中任务出发的连线：同色系的浅蓝虚线沿路径流动，提示「接下来往哪走」。
    // 放在所有连线（含链高亮）之后绘制，保证流动层压在最上面，不会被别的线盖住
    if (!REDUCED_MOTION) {
      const phase = (performance.now() % 1700) / 1700
      ctx.setLineDash([12, 16])
      ctx.lineDashOffset = -phase * 28
      ctx.strokeStyle = 'rgba(173,216,255,0.9)'
      ctx.lineWidth = 3.4
      for (const e of edges) {
        if (!e.flowing) continue
        ctx.globalAlpha = alphaOfEdge(e.from, e.to)
        strokePolyline(ctx, e.pts, EDGE_CORNER)
      }
      ctx.setLineDash([])
      ctx.lineDashOffset = 0
    }
    ctx.globalAlpha = 1
    // 端点圆点：只画在真正接入卡片的端点上，
    // 与「连线只是从卡片旁边/上方经过」区分开
    const endDot = (x: number, y: number, r: number, fill: string, edge?: string) => {
      ctx.beginPath()
      ctx.arc(x, y, r, 0, Math.PI * 2)
      ctx.fillStyle = fill
      ctx.fill()
      if (edge) {
        ctx.strokeStyle = edge
        ctx.lineWidth = 1.4
        ctx.stroke()
      }
    }
    for (const e of edges) {
      const a = e.pts[0]
      const b = e.pts[e.pts.length - 1]
      ctx.globalAlpha = alphaOfEdge(e.from, e.to)
      // 端点圆点：未完成的提亮为近白色，已完成的保持暗绿
      const fill = e.doneEdge ? 'rgba(90,150,108,0.98)' : '#e3e9f0'
      const edge = e.doneEdge ? 'rgba(6,32,12,0.85)' : 'rgba(10,14,20,0.9)'
      const r = e.doneEdge ? 5.8 : 6.2
      endDot(a[0], a[1], r, fill, edge)
      endDot(b[0], b[1], r, fill, edge)
    }
    if (chainIds.size > 0) {
      for (const e of edges) {
        if (!chainIds.has(e.from) || !chainIds.has(e.to)) continue
        const a = e.pts[0]
        const b = e.pts[e.pts.length - 1]
        ctx.globalAlpha = alphaOfEdge(e.from, e.to)
        const fill = e.doneEdge ? '#5ce06d' : '#f5c518'
        const edge = e.doneEdge ? 'rgba(6,32,12,0.9)' : 'rgba(40,26,0,0.9)'
        endDot(a[0], a[1], 7.6, fill, edge)
        endDot(b[0], b[1], 7.6, fill, edge)
      }
    }
    ctx.globalAlpha = 1

    // 节点
    ctx.textBaseline = 'alphabetic'
    for (const n of graph.nodes) {
      if (!visible.has(n.id)) continue
      const p = positions[n.id]
      if (!p) continue
      const st = nodeStates[n.id] ?? 'locked'
      const stl = STATE_STYLE[st]
      // 搜索未命中：整张卡片（含高亮环与物品图标）压暗
      ctx.globalAlpha = alphaOf(n.id)

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

      // 进行中：边框呼吸 + 向外扩散的脉冲环。
      // 周期与下方「进行中连线」的流动保持一致（1.7s），两个动效节奏同步更协调
      if (st === 'in_progress' && !REDUCED_MOTION) {
        const k = (performance.now() % 1700) / 1700
        const breathe = Math.sin(k * Math.PI * 2) * 0.5 + 0.5
        rr(ctx, p.x, p.y, NODE_W, NODE_H, 8)
        ctx.strokeStyle = `rgba(88,166,255,${(0.4 + breathe * 0.6).toFixed(3)})`
        ctx.lineWidth = 1.2 + breathe
        ctx.stroke()
        // 外扩环：贴着卡片边缘向外扩散并淡出
        rr(ctx, p.x - k * 7, p.y - k * 7, NODE_W + k * 14, NODE_H + k * 14, 8 + k * 5)
        ctx.strokeStyle = `rgba(88,166,255,${(0.3 * (1 - k)).toFixed(3)})`
        ctx.lineWidth = 1.4
        ctx.stroke()
      }

      // 任务链高亮（点击节点所属的整条链，含自身）
      if (chainIds.has(n.id)) {
        rr(ctx, p.x - 2, p.y - 2, NODE_W + 4, NODE_H + 4, 9)
        ctx.strokeStyle = '#ef9f27'
        ctx.lineWidth = 1.8
        ctx.stroke()
      }

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
      ctx.globalAlpha = 1
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
      // 搜索未命中：文字同样淡化，与卡片保持一致
      ctx.globalAlpha = alphaOf(n.id)

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

      // 等级（右上角 chip）：顶部标尺移除后，卡片上的 Lv 是唯一等级来源，故做成 chip 突出显示。
      // Lv1+ 是默认值、无信息量（绝大多数任务都是），直接不画；等级越高门槛越明显：
      // Lv2-14 灰、Lv15-29 蓝、Lv30+ 琥珀。
      const lv = n.minLevel && n.minLevel > 1 ? n.minLevel : 1
      let lvReserve = 0
      if (lv > 1) {
        ctx.font = `600 ${Math.max(8, Math.round(11 * TS))}px "Segoe UI", system-ui, sans-serif`
        const lvText = `Lv${lv}+`
        const lvW = ctx.measureText(lvText).width
        const lvPadX = 4 * TS
        const lvH = 15 * TS
        const lvRight = n.special ? sx + sw - 19 * TS : sx + sw - 5 * TS
        const lvX = lvRight - (lvW + lvPadX * 2)
        const lvY = sy + 3 * TS
        rr(ctx, lvX, lvY, lvW + lvPadX * 2, lvH, 3 * TS)
        ctx.fillStyle =
          lv >= 30
            ? 'rgba(239,159,39,0.16)'
            : lv >= 15
              ? 'rgba(111,179,255,0.14)'
              : 'rgba(255,255,255,0.06)'
        ctx.fill()
        ctx.strokeStyle =
          lv >= 30
            ? 'rgba(239,159,39,0.45)'
            : lv >= 15
              ? 'rgba(111,179,255,0.4)'
              : 'rgba(255,255,255,0.12)'
        ctx.lineWidth = 1
        ctx.stroke()
        ctx.fillStyle =
          lv >= 30 ? '#ef9f27' : lv >= 15 ? '#6fb3ff' : 'rgba(139,148,158,0.95)'
        ctx.textBaseline = 'middle'
        ctx.fillText(lvText, Math.round(lvX + lvPadX), Math.round(lvY + lvH / 2))
        ctx.textBaseline = 'alphabetic'
        lvReserve = lvW + lvPadX * 2 + 4 * TS
      }

      // 标题行：商人头像 + 状态符号 + 任务名（为右上角 Lv/✦ 预留宽度）
      const avatarR = 9 * TS
      const avatarCx = sx + 10 * TS + avatarR
      const avatarCy = sy + 15 * TS
      const avatarSrc = traderImage(n.traderId)
      if (avatarSrc) {
        const im = getImage(avatarSrc)
        if (imgReady(im)) {
          ctx.save()
          ctx.beginPath()
          ctx.arc(avatarCx, avatarCy, avatarR, 0, Math.PI * 2)
          ctx.closePath()
          ctx.clip()
          ctx.drawImage(im, avatarCx - avatarR, avatarCy - avatarR, avatarR * 2, avatarR * 2)
          ctx.restore()
        }
        ctx.strokeStyle = 'rgba(255,255,255,0.18)'
        ctx.lineWidth = 1
        ctx.beginPath()
        ctx.arc(avatarCx, avatarCy, avatarR, 0, Math.PI * 2)
        ctx.stroke()
      }
      // 头像尚未加载完成时也保留同样的起始位置，避免标题在首帧后整体跳动
      const titleX = sx + 12 * TS + avatarR * 2 + 6 * TS
      ctx.font = `600 ${Math.max(9, Math.round(14.5 * TS))}px "Segoe UI", system-ui, sans-serif`
      ctx.fillStyle = stl.text
      const glyph = st === 'completed' ? '✓ ' : st === 'available' ? '● ' : st === 'in_progress' ? '▶ ' : ''
      const rightReserve = (n.special ? 19 * TS : 5 * TS) + lvReserve
      const titleMax = Math.max(24, sw - (18 * TS + avatarR * 2) - rightReserve)
      const title = truncateText(ctx, glyph + n.name, titleMax)
      ctx.fillText(title, Math.round(titleX), Math.round(sy + 19 * TS))

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
        // 发布者自身的忠诚等级需求不画：泳道已表明商人身份，且 LL 已由「忠诚等级带」体现。
        // 只保留非发布者商人的 LL 需求（跨商人的额外门槛），以及好感等其他条件。
        if (
          (r.reqType === 'level' || r.reqType === 'variable') &&
          r.traderId === n.traderId
        )
          continue
        // 用数据自带的 compareMethod 判定：Fence「亡羊补牢」要求好感小于阈值
        const met = compareMet(loyalty[r.traderId] ?? 1, r.value, r.compare)
        const label =
          r.reqType === 'level' || r.reqType === 'variable'
            ? `${traderDisplayName(r.traderId, r.traderName)} LL${r.value}`
            : `好感${compareLabel(r.compare)}${r.value}`
        // 条件 chip 一律中性灰（未满足的再淡一档）：图谱的重点是「进行到哪一步」，
        // 而不是后续任务里哪个条件还没满足，不该用彩色抢注意力
        drawChip(
          label,
          met ? '#8b949e' : '#6e7681',
          met ? '#30363d' : '#262c33',
          'rgba(255,255,255,0.03)',
        )
      }
      // 转生（Prestige）门槛任务：同名任务靠这个标记区分是第几转（低饱和琥珀）
      if (n.prestigeLevel != null) drawChip(`转生${n.prestigeLevel}`, '#d4a174', '#5a4a2f', 'rgba(239,159,39,0.10)')
      if (n.legacy) drawChip('赛季', '#8b949e', '#30363d', 'rgba(255,255,255,0.03)')
      // 模式专属标记：与隐藏逻辑一致，基于 modes 判定（而非 legacy）；中性色，不抢注意力
      if (n.modes && n.modes.length > 0 && !n.modes.includes('pve'))
        drawChip('仅PvP', '#8b949e', '#30363d', 'rgba(255,255,255,0.03)')
      if (n.modes && n.modes.length > 0 && !n.modes.includes('pvp'))
        drawChip('仅PvE', '#8b949e', '#30363d', 'rgba(255,255,255,0.03)')
      if ((loyalty[n.traderId] ?? 1) === 0)
        drawChip('商人未解锁', '#8b949e', '#30363d', 'rgba(255,255,255,0.03)')
      ctx.textBaseline = 'alphabetic'
      ctx.globalAlpha = 1
    }

    // 商人泳道头像（48px）+ 中文名，位于左侧固定沟槽
    ctx.textBaseline = 'middle'
    for (const b of bands) {
      const cy = w2sy(b.y) + 26
      // 顶部标尺已移除：头像完全滚出视野上方才跳过（原判断依赖标尺高度）
      if (cy < -30 || cy > CH + 60) continue
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

    // ===== 屏幕空间：忠诚等级列标签 =====
    // 图谱只有「等级列」：无 LL 要求 / LL1+ / LL2+ / LL3+ / LL4+；独立任务同样按其 LL 归列。
    // 与左侧商人头像同类绘制：固定像素大小（不随缩放变小），横向随内容滚动、
    // 纵向钉在画布顶部；列左边界滚出视口时吸附到左边缘，滚动中始终能看到当前档位。
    ctx.textBaseline = 'middle'
    ctx.font = '600 15px "Segoe UI", system-ui, sans-serif'
    for (const b of llBands) {
      const x1 = w2sx(b.left)
      const x2 = w2sx(b.right)
      if (x1 > CW || x2 < 0) continue // 整段都在视口外
      const label = b.ll >= 1 ? `LL${b.ll}+` : '无 LL 要求'
      const sx = Math.max(8, x1 + 10)
      const tw = ctx.measureText(label).width
      ctx.fillStyle = 'rgba(13,17,23,0.82)'
      rr(ctx, sx - 7, 7, tw + 14, 24, 6)
      ctx.fill()
      ctx.strokeStyle = b.line || 'rgba(139,148,158,0.4)'
      ctx.lineWidth = 1.2
      ctx.stroke()
      ctx.fillStyle = b.text || 'rgba(139,148,158,0.9)'
      ctx.fillText(label, sx, 19.5)
    }
    ctx.textBaseline = 'alphabetic'

    // 链区区域标签：与 LL 标签同款，钉在画布顶部（提示右侧是任务链区）
    if (chainRows.length > 0) {
      const cx0 = w2sx(chainRows[0].left) + 10
      if (cx0 > -60 && cx0 < CW + 60) {
        const cl = '任务链'
        ctx.textBaseline = 'middle'
        ctx.font = '600 15px "Segoe UI", system-ui, sans-serif'
        const ctw = ctx.measureText(cl).width
        ctx.fillStyle = 'rgba(13,17,23,0.82)'
        rr(ctx, cx0 - 7, 7, ctw + 14, 24, 6)
        ctx.fill()
        ctx.strokeStyle = 'rgba(139,148,158,0.45)'
        ctx.lineWidth = 1.2
        ctx.stroke()
        ctx.fillStyle = 'rgba(200,208,216,0.95)'
        ctx.fillText(cl, cx0, 19.5)
        ctx.textBaseline = 'alphabetic'
      }
    }

    // 顶部等级标尺已移除：等级改标在卡片上（下方 drawChip 风格）。

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
      for (const b of llBands) {
        if (!b.bg) continue
        mctx.fillStyle = b.bg
        mctx.fillRect(b.left * k, 0, (b.right - b.left) * k, height * k)
      }
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
      for (const cr of chainRows) {
        mctx.strokeStyle = '#262c36'
        mctx.lineWidth = 1
        mctx.strokeRect(cr.left * k, cr.y * k, Math.max((width - cr.left) * k, 0), cr.h * k)
      }

      for (const n of graph.nodes) {
        if (!visible.has(n.id)) continue
        const p = positions[n.id]
        if (!p) continue
        const st = nodeStates[n.id] ?? 'locked'
        // 已完成用弱化后的浅淡绿，与主画面对齐；搜索未命中同样淡化
        mctx.globalAlpha = matches && !matches.has(n.id) ? DIM_ALPHA : 1
        mctx.fillStyle =
          st === 'completed'
            ? '#2f4438'
            : st === 'in_progress'
              ? '#58a6ff'
              : st === 'available'
                ? '#ef9f27'
                : '#3d444d'
        mctx.fillRect(p.x * k, p.y * k, Math.max(2, NODE_W * k), Math.max(1.5, NODE_H * k * 0.55))
      }
      mctx.globalAlpha = 1

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

  return (
    <div className="h-full flex flex-col relative">
      {/* 工具栏：筛选 + 图例 */}
      <div
        className="shrink-0 flex flex-wrap items-center gap-x-3 gap-y-1.5 px-4 py-2 bg-ink-800 border-b border-line relative z-30 overflow-visible"
        style={{ paddingLeft: 16 + topPad }}
      >
        {/* 一级视图 tab：任务列表 / 任务链 */}
        <div className="shrink-0 flex items-center rounded-full border border-line bg-ink-700 p-0.5">
          {(['list', 'chain'] as const).map((v) => (
            <button
              key={v}
              onClick={() => setGraphTab(v)}
              className={`px-3 h-[22px] rounded-full text-[13px] leading-none transition-colors ${
                graphTab === v
                  ? 'bg-amber text-black font-medium'
                  : 'text-muted hover:text-[#e6edf3]'
              }`}
            >
              {v === 'list' ? '任务列表' : '任务链'}
            </button>
          ))}
        </div>

        {/* 搜索 + 地图筛选 + 缩略图：整体靠右 */}
        <div className="ml-auto shrink-0 flex items-center gap-2">
          {graphTab === 'list' && (
            <select
              value={boardMapFilter}
              onChange={(e) => setBoardMapFilter(e.target.value)}
              title="按地图筛选任务（无地图信息的任务始终保留）"
              className="shrink-0 bg-ink-700 border border-line text-[15px] rounded px-2 py-1.5 text-[#e6edf3] max-w-[190px]"
            >
              <option value="">全部地图</option>
              {boardMapOptions.map((m) => (
                <option key={m} value={m}>
                  {mapNames[m] ?? m}
                </option>
              ))}
            </select>
          )}
          {/* 缩略图显隐：搜索框左侧，仅任务链视图有意义 */}
          {graphTab === 'chain' && (
            <label
              title="显示 / 隐藏右下角缩略图"
              className="flex items-center gap-1.5 shrink-0 text-[14px] text-muted cursor-pointer select-none hover:text-[#e6edf3]"
            >
              <input
                type="checkbox"
                checked={showMiniMap}
                onChange={(e) => setMiniMap(e.target.checked)}
                className="accent-[#ef9f27]"
              />
              缩略图
            </label>
          )}
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="搜索任务名…"
            className="shrink-0 bg-ink-700 border border-line text-[15px] rounded px-3 py-1.5 text-[#e6edf3] w-72 placeholder:text-muted"
          />
        </div>
      </div>

      {graphTab === 'list' && (
        <div className="flex-1 min-h-0 bg-ink-900">
          <QuestBoardView />
        </div>
      )}

      {/* 画布：touch-action none 屏蔽浏览器默认手势，触摸交互由上方 handler 接管 */}
      {graphTab === 'chain' && (
      <div
        className="relative flex-1 min-h-0 overflow-hidden bg-ink-900"
        style={{ cursor, touchAction: 'none' }}
        onWheel={onWheel}
        onMouseDown={onMouseDown}
        onMouseMove={onMouseMove}
        onMouseUp={onMouseUp}
        onMouseLeave={onMouseLeave}
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
        onTouchCancel={onTouchEnd}
      >
        <canvas ref={canvasRef} className="absolute inset-0 w-full h-full block" />

        {drawErr && (
          <div className="absolute inset-x-3 top-3 z-50 max-h-[60%] overflow-y-auto rounded border border-red-400/40 bg-red-500/10 px-3 py-2 text-[12px] leading-relaxed text-red-300 break-all">
            图谱绘制出错：{drawErr}
          </div>
        )}

        {/* 图例：左下角浮动显示 */}
        <div className="absolute bottom-3 left-3 z-40 flex flex-col gap-1 px-2.5 py-2 rounded-md bg-ink-800/85 border border-line shadow-lg backdrop-blur-sm text-[13px] text-muted pointer-events-none">
          <span className="flex items-center gap-1.5 whitespace-nowrap"><span className="w-3 h-3 rounded-sm bg-[#12161a] border border-[#2a3a31]" />已完成</span>
          <span className="flex items-center gap-1.5 whitespace-nowrap"><span className="w-3 h-3 rounded-sm bg-[#0e2438] border border-[#58a6ff]" />进行中</span>
          <span className="flex items-center gap-1.5 whitespace-nowrap"><span className="w-3 h-3 rounded-sm bg-[#231b0d] border border-[#9aa5b1]" />待接取</span>
          <span className="flex items-center gap-1.5 whitespace-nowrap"><span className="w-3 h-3 rounded-sm bg-[#1f2730] border border-[#6b7682]" />后续解锁</span>
          <span className="flex items-center gap-1.5 whitespace-nowrap"><span className="w-3 h-3 rounded-sm bg-ink-800 border border-dashed border-[#c4a7ff]" />特殊✦</span>
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
            style={{
              width: DETAIL_PANEL_W,
              maxHeight: `min(88%, calc(100% - ${miniDim.h + 36}px))`,
            }}
            className="absolute right-3 top-3 min-w-[360px] max-w-[calc(100%-24px)] overflow-y-auto bg-ink-800/90 backdrop-blur-sm border border-line rounded-xl p-4 shadow-xl z-50 cursor-default"
          >
            <button
              onClick={(e) => {
                e.stopPropagation()
                if (detail) {
                  const u = wikiUrlFor(detail.id)
                  if (u) openWiki(u)
                }
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
                  {detail.prestigeLevel != null && (
                    <span className="px-1.5 rounded border border-amber/25 bg-amber/10 text-[#d4a174] text-[12px]">
                      转生 {detail.prestigeLevel}
                    </span>
                  )}
                  {detail.legacy && (
                    <span className="px-1.5 rounded border border-line/40 text-[12px] text-muted/70">
                      赛季任务
                    </span>
                  )}
                  {detail.modes && detail.modes.length > 0 && !detail.modes.includes('pve') && (
                    <span className="px-1.5 rounded border border-line/45 bg-ink-700/40 text-muted/80 text-[12px]">
                      仅 PvP
                    </span>
                  )}
                  {detail.modes && detail.modes.length > 0 && !detail.modes.includes('pvp') && (
                    <span className="px-1.5 rounded border border-line/45 bg-ink-700/40 text-muted/80 text-[12px]">
                      仅 PvE
                    </span>
                  )}
                  {detail.special && (
                    <span className="px-1.5 rounded border border-dashed border-[#c4a7ff] text-[#c4a7ff] text-[12px]">
                      特殊 ✦
                    </span>
                  )}
                </div>

                {detail.traderReqs?.length > 0 && (
                  <div className="mt-3">
                    <div className="text-[13px] text-muted mb-1">贸易条件</div>
                    <div className="space-y-1 text-[14px]">
                      {detail.traderReqs.map((r, i) => {
                        const cur = profile?.loyalty?.[r.traderId] ?? 1
                        // 按数据自带的 compareMethod 判定（如好感需 < -1）
                        const met = compareMet(cur, r.value, r.compare)
                        // 需求文案：level = 忠诚等级（权威的 traderRequirements）；
                        // reputation = 好感；variable = 仅知存在额外商人条件，
                        // 源数据只给全局变量阈值，不等于等级/好感数字，故不展示具体数值
                        const isLv = r.reqType === 'level' || r.reqType === 'variable'
                        const text = isLv
                          ? `忠诚等级 LL${r.value}（当前 LL${cur}）`
                          : r.reqType === 'reputation'
                            ? `好感 ${compareLabel(r.compare)} ${r.value}（当前 ${cur}）`
                            : '额外条件（需达成商人要求）'
                        return (
                          <div
                            key={`${r.traderId}-${r.reqType}-${r.value}-${i}`}
                            className="flex items-center justify-between gap-2"
                          >
                            <span className="text-[#c9d1d9] truncate">
                              {traderDisplayName(r.traderId, r.traderName)} {text}
                            </span>
                            {(isLv || r.reqType === 'reputation') &&
                              (met ? (
                                <span className="text-muted/80 shrink-0">✓ 已达标</span>
                              ) : (
                                <span className="text-muted/55 shrink-0">✗ 未达标</span>
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

        {/* 缩略图（右下角）：尺寸随世界包围盒宽高比动态变化；可开关 */}
        {showMiniMap && (
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
        )}
      </div>
      )}
    </div>
  )
}
