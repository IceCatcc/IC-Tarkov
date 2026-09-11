import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { listen } from '@tauri-apps/api/event'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import './map.css'
import {
  getPlayerPosition,
  getMapMarkers,
  getQuestZones,
  getMapBosses,
  getMapsSkeleton,
} from '../tauri'
import type {
  PlayerPositionPayload,
  MarkerPosition as Position,
  MarkerEntry,
  MapMarkersDoc,
  SkeletonLayer,
  SkeletonMap,
  SkeletonGroup,
  SkeletonDoc,
  QuestZone,
  QuestZoneObjective,
  QuestZonesDoc,
  MapBossesDoc,
} from '../types'
import { useStore } from '../store'
import { QuestCard } from '../components/QuestCard'
import { MapIconPanel } from '../components/MapIconPanel'
import {
  buildIconGroups,
  resolveChipOn,
  catKey,
  subKey,
  type IconGroup,
} from '../mapIconGroups'
import { bossImage } from '../bossImages'

/* ================= 常量 ================= */

const ICON_BASE = 'maps/interactive/'

// 常见英文楼层名的中文显示
const FLOOR_NAME_ZH: Record<string, string> = {
  'Ground Floor': '主层',
  'Ground Level': '主层',
  '1st Floor': '一楼',
  'First Floor': '一楼',
  '2nd Floor': '二楼',
  'Second Floor': '二楼',
  'Second Level': '二楼',
  '3rd Floor': '三楼',
  'Third Floor': '三楼',
  '4th Floor': '四楼',
  'Fourth Floor': '四楼',
  '5th Floor': '五楼',
  'Fifth Floor': '五楼',
  '6th Floor': '六楼',
  Basement: '地下',
  Tunnels: '隧道',
  Underground: '地下',
  'Underground Level': '地下',
  'Underground Parking': '地下停车场',
  Infirmary: '医务室',
  Helipad: '停机坪',
  Technical: '技术层',
  Entresol: '夹层',
  Roof: '屋顶',
}
const floorNameZh = (name: string | undefined): string =>
  name ? FLOOR_NAME_ZH[name] ?? name : '主层'

/** 楼层名里的层号：2nd Floor / 2 楼 -> 2、First Floor -> 1、Ground Level -> 0；解析不出时为 null */
const FLOOR_ORDER_WORD: Record<string, number> = {
  ground: 0,
  first: 1,
  second: 2,
  third: 3,
  fourth: 4,
  fifth: 5,
  sixth: 6,
}
const floorOrder = (lyr: SkeletonLayer | null): number | null => {
  if (!lyr) return 0 // 主层
  const name = (lyr.name ?? '').toLowerCase()
  if (!name) return null
  const digits = name.match(/\d+/)
  if (digits) return Number(digits[0])
  for (const [word, n] of Object.entries(FLOOR_ORDER_WORD)) {
    if (name.includes(word)) return n
  }
  return null
}
/** 数据里用 1000 / 10000 表示「一直到顶 / 无上限」，排序时要排除这些哨兵值 */
const FLOOR_TOP_SENTINEL = 1000

/** 非当前楼层的标记透明度：稍微透明一点，仍能看清位置 */
const DIMMED_MARKER_OPACITY = 0.45

/**
 * 楼层的代表高度，用于楼层列表排序（越高越靠上）；主层（null）按 0 处理。
 *
 * extents 的 height 是 [下限, 上限]，但不能简单地取上限：数据里有两类会误导的区间——
 *  - 贯穿整栋楼的（海关 2 楼/3 楼的 [5.7,1000]、街区 5 楼的 [25,10000]）；
 *  - 只跨越地面的（海关 Underground 的 [-1000,0.5]，上限比主层的 0 还高）。
 * 规则：整层都在地面以下（所有下限都 < 0）时取「下限的最大值」；否则取上限，
 * 并排除「到顶」的哨兵区间；若整层都是到顶的，则退回上限值（它本来就该排最上）。
 */
const floorHeight = (lyr: SkeletonLayer | null): number => {
  if (!lyr) return 0
  const hs = (lyr.extents ?? [])
    .map((e) => e.height)
    .filter((h): h is [number, number] => Array.isArray(h) && h.length === 2)
  if (!hs.length) return Number.NEGATIVE_INFINITY
  const maxBottom = Math.max(...hs.map((h) => h[0]))
  if (maxBottom < 0) return maxBottom
  const caps = hs.map((h) => h[1]).filter((t) => t < FLOOR_TOP_SENTINEL)
  return caps.length ? Math.max(...caps) : Math.max(...hs.map((h) => h[1]))
}

/**
 * 楼层从高到低的顺序（下标即「楼层排名」，0 最高），与楼层列表的展示顺序一致：
 * 先按名字里的层号，名字没有层号的再按高度。i = -1 表示主层。
 */
function sortFloors(layers: SkeletonLayer[]): { lyr: SkeletonLayer | null; i: number }[] {
  return [{ lyr: null, i: -1 }, ...layers.map((lyr, i) => ({ lyr, i }))].sort((a, b) => {
    const oa = floorOrder(a.lyr)
    const ob = floorOrder(b.lyr)
    if (oa != null && ob != null && oa !== ob) return ob - oa
    return floorHeight(b.lyr) - floorHeight(a.lyr)
  })
}

/**
 * 标记所属楼层的排名（对应 sortFloors 的下标）。
 *
 * 数据里标记只带一个高度 position.y（没有楼层字段），所以按各层 extents 的高度区间匹配；
 * 一个点可能落在多个区间里（区间会重叠、还有贯穿整栋的哨兵区间），取**最窄**的那个。
 * 匹配不到时算作主层——绝大多数标记（撤离点、容器…）的 y 就在地表。
 */
function markerFloorRank(
  en: MarkerEntry,
  ranks: { lyr: SkeletonLayer | null; i: number }[],
  mainRank: number,
): number {
  const y = en.position?.y
  if (typeof y !== 'number') return mainRank
  let best = mainRank
  let bestSpan = Infinity
  ranks.forEach((r, rank) => {
    for (const e of r.lyr?.extents ?? []) {
      const h = e.height
      if (!Array.isArray(h) || h.length !== 2) continue
      if (y < h[0] || y > h[1]) continue
      const span = h[1] - h[0]
      if (span < bestSpan) {
        bestSpan = span
        best = rank
      }
    }
  })
  return best
}
// 图标文件名映射与「是否为狙击点」判定已移到 mapIconGroups.ts（图层与筛选面板共用）

/** 撤离要求类型 -> 中文标签（value 为补充细节，如信号弹颜色 / 付费金额） */
const REQ_LABEL: Record<string, (v: string | null) => string> = {
  cooperation: () => '合作撤离',
  flare: (v) => '信号弹' + (v ? `·${flareColor(v)}` : ''),
  payment: (v) => '付费' + (v ? ` ${v}` : ''),
  beacon: () => '信标',
  transit: () => '过境',
  secsRequired: (v) => `停留 ${v}s`,
  levelRequired: (v) => `等级≥${v}`,
  zoneRequired: (v) => `区域 ${v}`,
  itemRequired: (v) => '物品' + (v ? ` ${v}` : ''),
  questRequired: (v) => '任务' + (v ? ` ${v}` : ''),
  traderRequired: (v) => '商人' + (v ? ` ${v}` : ''),
  switch: () => '需开开关',
  btr: () => '需乘BTR',
  spawn: () => '出生点',
}
/** 撤离要求类型 -> 配色 class（见 map.css .req-*） */
const REQ_CLASS: Record<string, string> = {
  cooperation: 'req-coop',
  flare: 'req-flare',
  payment: 'req-pay',
  beacon: 'req-beacon',
  transit: 'req-transit',
  switch: 'req-switch',
  btr: 'req-btr',
}
function flareColor(v: string) {
  return ({ red: '红', green: '绿', white: '白', blue: '蓝', yellow: '黄' } as Record<string, string>)[v] ?? v
}
type Requirement = NonNullable<MarkerEntry['requirements']>[number]

function reqText(r: Requirement) {
  const fn = REQ_LABEL[r.type]
  return fn ? fn(r.value ?? null) : r.type
}
function reqClass(r: Requirement) {
  return REQ_CLASS[r.type] ?? 'req-info'
}
/** popup 内撤离要求渲染：物品类带图标 + 中文名，其余回退纯文本 */
function reqHtml(r: Requirement): string {
  if (r.itemId) {
    const cnt = r.count != null && r.count > 0 ? ` ×${r.count}` : ''
    const nm = r.name ?? r.value ?? ''
    return `<span class="req-item"><img class="req-item-img" src="/item-icons/${r.itemId}.webp" alt=""/>` +
      `<span class="req-item-name">${nm}</span>${cnt ? `<span class="req-item-count">${cnt}</span>` : ''}</span>`
  }
  return reqText(r)
}

/**
 * 撤离点名称后的内联小图标（HTML）：
 * - switch：开关图标（SVG）
 * - 带 itemId 的要求（卢布付费 / 纸条等）：物品图标
 * 返回 null 表示该要求无图标，落到名称下方的文字标签。
 */
function extractReqIconHtml(r: Requirement): string | null {
  if (r.type === 'switch') {
    return (
      '<svg class="extract-req-icon" viewBox="0 0 24 24" fill="none" aria-hidden>' +
      '<rect x="2.5" y="7" width="19" height="10" rx="5" stroke="currentColor" stroke-width="2.6"/>' +
      '<circle cx="15.5" cy="12" r="3.6" fill="currentColor"/>' +
      '</svg>'
    )
  }
  if (r.itemId) {
    const nm = r.name ?? r.value ?? ''
    return `<img class="extract-req-icon extract-req-item" src="/item-icons/${r.itemId}.webp" alt="" title="${nm}"/>`
  }
  return null
}

// 图标的分类 / 子分类由 mapIconGroups.ts 从当前地图数据派生（不再写死清单）

/* ================= CRS 工具（源自 the-hideout/tarkov-dev，MIT） ================= */

function applyRotation(latLng: L.LatLng, rotation: number | undefined): L.LatLng {
  if (!rotation || (!latLng.lng && !latLng.lat)) return latLng
  const rad = (rotation * Math.PI) / 180
  const cos = Math.cos(rad)
  const sin = Math.sin(rad)
  const { lng: x, lat: y } = latLng
  return L.latLng(x * sin + y * cos, x * cos - y * sin)
}

/** 自定义 CRS：Simple + transform 缩放偏移 + 投影阶段旋转 */
function getCRS(mapData: SkeletonMap): L.CRS {
  let scaleX = 1
  let scaleY = 1
  let marginX = 0
  let marginY = 0
  if (mapData.transform) {
    scaleX = mapData.transform[0]
    scaleY = mapData.transform[2] * -1
    marginX = mapData.transform[1]
    marginY = mapData.transform[3]
  }
  return L.extend({}, L.CRS.Simple, {
    transformation: new L.Transformation(scaleX, marginX, scaleY, marginY),
    projection: L.extend({}, L.Projection.LonLat, {
      project: (latLng: L.LatLng) =>
        L.Projection.LonLat.project(applyRotation(latLng, mapData.coordinateRotation)),
      unproject: (point: L.Point) =>
        applyRotation(L.Projection.LonLat.unproject(point), (mapData.coordinateRotation ?? 0) * -1),
    }),
  }) as unknown as L.CRS
}

/** 游戏坐标 {x,z} -> Leaflet latLng（旋转/缩放在投影阶段处理） */
function pos(p: Position): L.LatLngExpression {
  return [p.z, p.x]
}

/** 骨架 bounds -> 未旋转投影空间的 LatLngBounds */
function getBounds(b: [[number, number], [number, number]]): L.LatLngBounds {
  return L.latLngBounds(
    [b[0][1], b[0][0]] as L.LatLngTuple,
    [b[1][1], b[1][0]] as L.LatLngTuple,
  )
}

function getScaledBounds(bounds: L.LatLngBounds, factor: number): L.LatLngBounds {
  const c = bounds.getCenter()
  const w = (bounds.getEast() - bounds.getWest()) * factor
  const h = (bounds.getNorth() - bounds.getSouth()) * factor
  return L.latLngBounds([c.lat - h / 2, c.lng - w / 2], [c.lat + h / 2, c.lng + w / 2])
}

/** 图标旋转修正：底图被 CRS 旋转渲染，marker 图标需补偿 */
function iconRotationDeg(baseRot: number, coordinateRotation: number | undefined): number {
  let add = coordinateRotation ?? 0
  if (add === 90 || add === 270) add += 180
  return baseRot + add
}

function fmtNum(v: number | null | undefined) {
  return typeof v === 'number' ? v.toFixed(1) : '-'
}

/** HTML 转义（任务名等文本注入到 divIcon/popup 前使用） */
function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string,
  )
}

/**
 * 标记弹窗内容。
 * - 标题点击：有 questId 时展开右下角任务浮窗并定位到该任务；否则有 wikiUrl 时打开 Wiki
 * - Wiki 文字按钮固定在标题行最右
 * - coordMeta 精简为一行的坐标信息，右对齐显示在弹窗右下角
 */
function popupHtml(
  title: string,
  meta: string[],
  wikiUrl?: string | null,
  coordMeta?: string[],
  questId?: string,
) {
  const titleAttr = questId
    ? ` data-quest="${encodeURIComponent(questId)}" title="点击展开任务列表并定位该任务"`
    : wikiUrl
      ? ` data-wiki="${encodeURIComponent(wikiUrl)}" title="点击查看 Wiki"`
      : ''
  const titleLink = questId || wikiUrl ? ' map-popup-title-link' : ''
  const wikiBtn = wikiUrl
    ? `<button type="button" class="map-popup-wiki" data-wiki="${encodeURIComponent(
        wikiUrl,
      )}">Wiki ↗</button>`
    : ''
  return `<div><div class="map-popup-head"><div class="map-popup-title${titleLink}"${titleAttr}>${title}</div>${wikiBtn}</div>${meta
    .map((m) => `<div class="map-popup-meta">${m}</div>`)
    .join('')}${(coordMeta ?? [])
    .map((m) => `<div class="map-popup-coord">${m}</div>`)
    .join('')}</div>`
}

/* ================= 组件 ================= */

export function MapPage() {
  const [skeleton, setSkeleton] = useState<SkeletonDoc | null>(null)
  const [markers, setMarkers] = useState<MapMarkersDoc | null>(null)
  const [qzDoc, setQzDoc] = useState<QuestZonesDoc | null>(null)
  const [bossDoc, setBossDoc] = useState<MapBossesDoc | null>(null)
  const [loadErr, setLoadErr] = useState('')
  const [selected, setSelected] = useState<string>(() => useStore.getState().currentMap ?? 'factory')
  const autoZoomMap = useStore((s) => s.autoZoomMap)
  const setAutoZoomMap = useStore((s) => s.setAutoZoomMap)
  const autoCenter = useStore((s) => s.autoCenter)
  const setAutoCenter = useStore((s) => s.setAutoCenter)
  const focusZoom = useStore((s) => s.focusZoom)
  const setFocusZoom = useStore((s) => s.setFocusZoom)
  const untrackedQuests = useStore((s) => s.untrackedQuests)
  const toggleQuestTracked = useStore((s) => s.toggleQuestTracked)
  // 图标显隐存于 store（随 mapPrefs 持久化到 settings.json），跨启动保留
  const chips = useStore((s) => s.mapChips)
  const [floorSel, setFloorSel] = useState(-1) // -1 = 默认主层
  const [floorOpen, setFloorOpen] = useState(false) // 层级切换浮层
  const [mapMenuOpen, setMapMenuOpen] = useState(false) // 左下角地图选单浮层
  const [tasksOpen, setTasksOpen] = useState(false) // 工具栏「任务」按钮下方展开的浮窗
  // 从地图弹窗标题跳转过来的任务：展开浮窗后滚动定位到该卡片（定位完即清空）
  const [focusQuestId, setFocusQuestId] = useState<string | null>(null)
  const [infoOpen, setInfoOpen] = useState(true) // 右下角地图信息浮窗（默认展开）
  const [focusOpen, setFocusOpen] = useState(false) // 左下角「聚焦」浮动按钮展开面板
  const [chipsOpen, setChipsOpen] = useState(false) // 左下角「标记」浮动选单

  const [cursorCoord, setCursorCoord] = useState<{ x: number; z: number } | null>(null)
  // 三个浮窗（地图选单/任务/层级）的容器 ref：点击外部自动关闭
  const mapMenuRef = useRef<HTMLDivElement | null>(null)
  const tasksRef = useRef<HTMLDivElement | null>(null)
  const infoRef = useRef<HTMLDivElement | null>(null)
  const chipsPanelRef = useRef<HTMLDivElement | null>(null)
  const floorRef = useRef<HTMLDivElement | null>(null)
  const focusRef = useRef<HTMLDivElement | null>(null)
  // 截图解析出的玩家位置 + 全局当前地图（location id），由 tauri 全局监听写入，任何页面生效
  const [shotPos, setShotPos] = useState<PlayerPositionPayload | null>(null)
  const currentMapId = useStore((s) => s.currentMapId)
  const page = useStore((s) => s.page)

  // 地图数据由后端从 tarkov.dev 原始 API JSON 派生后下发（不再依赖 public/data/*.json）
  const loadMapData = useCallback(() => {
    Promise.all([
      getMapsSkeleton(),
      getMapMarkers(),
      getQuestZones(),
      // Boss 刷新率：加载失败不影响地图，仅面板显示为空
      getMapBosses().catch(() => null),
    ])
      .then(([sk, mk, qz, bs]) => {
        setSkeleton(sk)
        setMarkers(mk)
        setQzDoc(qz)
        setBossDoc(bs ?? null)
        setLoadErr('')
      })
      .catch((e) => setLoadErr(String(e)))
  }, [])

  useEffect(() => {
    loadMapData()
    // 后端更新完数据后会重建索引并广播，这里重新取一次即可
    let un: (() => void) | undefined
    listen('data-reloaded', () => loadMapData()).then((u) => (un = u))
    return () => un?.()
  }, [loadMapData])

  const selectable = useMemo(
    () => (skeleton?.groups ?? []).filter((g) => g.maps.some((m) => m.projection === 'interactive')),
    [skeleton],
  )

  const group = useMemo(() => selectable.find((g) => g.normalizedName === selected), [
    selectable,
    selected,
  ])

  const imap = useMemo(() => group?.maps.find((m) => m.projection === 'interactive'), [group])

  // 图标面板的分类树：与 Leaflet 图层构建共用同一份派生逻辑（buildIconGroups）
  const iconGroups: IconGroup[] = useMemo(
    () => (imap && markers ? buildIconGroups(markers.maps[imap.key] ?? {}) : []),
    [imap, markers],
  )

  /* ---------- 玩家位置事件流（截图监听 + 日志地图检测） ---------- */

  useEffect(() => {
    let offPos: (() => void) | undefined
    getPlayerPosition()
      .then((p) => p && setShotPos(p))
      .catch(() => {})
    listen<PlayerPositionPayload>('player-position', (e) => setShotPos(e.payload)).then(
      (u) => (offPos = u),
    )
    return () => {
      offPos?.()
    }
  }, [])

  // 全局检测到新地图 -> 自动切换（nameId 经 JSON 映射，变体经 fallback 归并）
  // 即便当前在别的页面，currentMapId 已被全局监听更新，切回地图页即显示对应地图
  useEffect(() => {
    if (!currentMapId || !markers || !selectable.length) return
    const nn =
      markers.nameIdFallback?.[currentMapId] ?? markers.nameIds?.[currentMapId] ?? currentMapId
    if (selectable.some((g) => g.normalizedName === nn)) {
      setSelected((prev) => {
        if (prev !== nn) setFloorSel(-1)
        return nn
      })
      useStore.getState().setCurrentMap(nn)
    }
  }, [currentMapId, markers, selectable])

  /* 地图时间已移除：接口长期无数据，面板里只会显示「暂不可用」还占位置。
     相关的时钟状态、1s 定时器与 10 分钟一次的网络同步一并去掉。 */

  /* ---------- Leaflet 构建（每张地图重建实例，保证状态干净） ---------- */

  const mapDivId = 'ic-tarkov-map'
  const mapRef = useRef<L.Map | null>(null)
  const imapRef = useRef<SkeletonMap | undefined>(imap)
  imapRef.current = imap
  const shotRef = useRef<PlayerPositionPayload | null>(shotPos)
  shotRef.current = shotPos
  const playerMarkerRef = useRef<L.Marker | null>(null)
  const questLayerRef = useRef<L.LayerGroup | null>(null)
  // 自动缩放 / 自动居中 / 任务跟踪 ref：地图构建 effect 与跟随 effect 通过 ref 读最新值
  const autoZoomRef = useRef(false)
  autoZoomRef.current = autoZoomMap
  const autoCenterRef = useRef(true)
  autoCenterRef.current = autoCenter
  const focusZoomRef = useRef(4)
  focusZoomRef.current = focusZoom
  const untrackedRef = useRef<Set<string>>(new Set())
  untrackedRef.current = new Set(untrackedQuests)
  // keepAlive 适配：页面隐藏（display:none）时容器尺寸为 0，需记录可见状态并在切回时重算
  const pageRef = useRef(page)
  pageRef.current = page
  const rawBoundsRef = useRef<L.LatLngBounds | null>(null)

  // 点击浮窗外部自动关闭（容器内 onMouseDown 已 stopPropagation，不会误触发）
  // 注意：「地图信息」面板不在此列——它只由按钮点击切换显隐，点外部不关闭
  useEffect(() => {
    if (!mapMenuOpen && !tasksOpen && !floorOpen && !focusOpen && !chipsOpen) return
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node
      if (mapMenuOpen && mapMenuRef.current && !mapMenuRef.current.contains(t))
        setMapMenuOpen(false)
      if (tasksOpen && tasksRef.current && !tasksRef.current.contains(t)) setTasksOpen(false)
      if (floorOpen && floorRef.current && !floorRef.current.contains(t)) setFloorOpen(false)
      if (focusOpen && focusRef.current && !focusRef.current.contains(t)) setFocusOpen(false)
      if (chipsOpen && chipsPanelRef.current && !chipsPanelRef.current.contains(t))
        setChipsOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [mapMenuOpen, tasksOpen, floorOpen, focusOpen, chipsOpen])

  // 进行中任务（仅用于地图上标注目标位置）
  const playerQuests = useStore((s) => s.playerQuests)
  const inProgressIds = useMemo(
    () =>
      new Set(
        playerQuests.filter((q) => q.status === 'in_progress').map((q) => q.questId),
      ),
    [playerQuests],
  )

  // 状态同步桥：构建闭包内逻辑 <-> React state
  const chipsRef = useRef(chips)
  chipsRef.current = chips
  const syncFnsRef = useRef<(() => void)[]>([])
  const floorApplyRef = useRef<((idx: number) => void) | null>(null)

  useEffect(() => {
    if (!imap || !markers) return
    const mm = markers.maps[imap.key] ?? {}

    const container = L.map(mapDivId, {
      zoomSnap: 0.1,
      wheelPxPerZoomLevel: 120,
      attributionControl: false,
      zoomControl: false,
      crs: getCRS(imap),
      minZoom: imap.minZoom ?? 1,
      maxZoom: imap.maxZoom ?? 6,
    })
    mapRef.current = container

    const rawBounds = getBounds(imap.bounds)
    rawBoundsRef.current = rawBounds
    container.setMaxBounds(getScaledBounds(rawBounds, 1.5))
    // 仅当当前可见时 fit（隐藏时容器尺寸为 0，fit 会告警；切回时由可见 effect 复位）
    if (pageRef.current === 'map') container.fitBounds(rawBounds)

    container.on('mousemove', (e: L.LeafletMouseEvent) => {
      setCursorCoord({ x: e.latlng.lng, z: e.latlng.lat })
    })
    container.on('mouseout', () => setCursorCoord(null))

    // 弹窗内任务名称：点击打开 Wiki 抽屉（事件委托到地图容器）
    const openWiki = useStore.getState().openWiki
    const onMapClick = (ev: MouseEvent) => {
      const target = ev.target as HTMLElement
      // Wiki 文字按钮：打开 Wiki 抽屉
      const btn = target.closest('[data-wiki]') as HTMLElement | null
      if (btn) {
        ev.preventDefault()
        const url = decodeURIComponent(btn.getAttribute('data-wiki') ?? '')
        if (url) {
          container.closePopup()
          openWiki(url)
        }
        return
      }
      // 弹窗标题：展开右下角任务浮窗并滚动定位到该任务
      const titleEl = target.closest('[data-quest]') as HTMLElement | null
      if (titleEl) {
        ev.preventDefault()
        const qid = decodeURIComponent(titleEl.getAttribute('data-quest') ?? '')
        if (qid) {
          container.closePopup()
          setTasksOpen(true)
          setFocusQuestId(qid)
        }
      }
    }
    container.getContainer().addEventListener('click', onMapClick)

    /* ---- 底图与楼层 ---- */
    let cancelled = false

    interface FloorHandle {
      show(): void
      hide(): void
    }
    const floorHandles = new Map<number, FloorHandle>()
    let defaultHandle: FloorHandle | null = null

    // SVG 楼层组状态（异步加载 SVG 后填充）
    interface SvgGroup {
      id: string
      isBase: boolean
      keepWith: string[]
      el: SVGGElement
    }
    let svgRoot: SVGSVGElement | null = null
    let svgGroups: SvgGroup[] = []

    /**
     * 统一切换 SVG 组显隐。
     * @param layerName 目标楼层组 id；null = 主层
     * @param dim 切到其它楼层时压暗 base（off-level）
     * @param hideBase base 也隐藏（tile 楼层：瓦片为底图，SVG 主层不能盖住它）
     */
    const applySvgLayer = (
      layerName: string | null,
      dim: boolean,
      hideBase: boolean,
    ) => {
      if (!svgRoot) return
      svgRoot.style.display = ''
      svgRoot.classList.toggle('off-level', dim)
      for (const gr of svgGroups) {
        if (gr.isBase) {
          gr.el.classList.toggle('hidden-layer', hideBase)
          continue
        }
        const match =
          layerName != null &&
          (gr.id === layerName || gr.keepWith.includes(layerName))
        gr.el.classList.toggle('hidden-layer', !match)
      }
    }
    const showSvgMain = () => applySvgLayer(imap.svgLayer ?? null, false, false)

    /* ---- 标记按楼层分级 ---- */
    // 楼层从高到低的排名（下标 0 = 最高），与楼层列表展示顺序一致
    const ranks = sortFloors(imap.layers ?? [])
    const mainRank = Math.max(0, ranks.findIndex((r) => r.i === -1))
    const rankOfFloorIdx = (idx: number) => {
      const r = ranks.findIndex((it) => it.i === idx)
      return r < 0 ? mainRank : r
    }
    interface Leveled {
      mk: L.Marker
      /** 标记所属楼层的排名 */
      rank: number
      /** 右下角的方向角标（marker 加入地图后才有） */
      arrow: HTMLElement | null
    }
    const markerLevels: Leveled[] = []
    let curRank = mainRank

    /** 单个标记：当前楼层正常显示，其它楼层压暗图标并标出相对方向（角标不跟着变透明） */
    const applyOneMarker = (rec: Leveled, rank: number) => {
      const diff = rec.rank - rank
      const el = rec.mk.getElement()
      // 只给图标本身设透明度：marker.setOpacity 会把右下角的方向角标一起压暗
      const img = el?.querySelector<HTMLElement>('img')
      if (img) img.style.opacity = diff === 0 ? '' : String(DIMMED_MARKER_OPACITY)
      // 角标只有加入地图后才查得到，这里兼作兜底查询
      if (!rec.arrow) {
        rec.arrow = el?.querySelector<HTMLElement>('.lvl-arrow') ?? null
        if (!rec.arrow) return
      }
      const arrow = rec.arrow
      if (diff === 0) {
        arrow.className = 'lvl-arrow'
        arrow.replaceChildren()
        return
      }
      // 排名更小 = 楼层更高 → 箭头朝上；相差超过一层就叠两个
      arrow.className = `lvl-arrow ${diff < 0 ? 'up' : 'down'}`
      arrow.replaceChildren(
        ...Array.from({ length: Math.min(2, Math.abs(diff)) }, () => document.createElement('i')),
      )
    }

    const applyMarkerLevels = (rank: number) => {
      curRank = rank
      for (const rec of markerLevels) applyOneMarker(rec, rank)
    }

    const applyFloor = (idx: number) => {
      defaultHandle?.[idx === -1 ? 'show' : 'hide']()
      for (const [i, h] of floorHandles) h[i === idx ? 'show' : 'hide']()
      applyMarkerLevels(rankOfFloorIdx(idx))
    }
    floorApplyRef.current = applyFloor

    const tileOpts: L.TileLayerOptions = {
      tileSize: imap.tileSize ?? 256,
      bounds: rawBounds.pad(0.2),
      minZoom: imap.minZoom ?? 1,
      maxZoom: imap.maxZoom ?? 6,
      noWrap: true,
    }

    // 主层：优先 SVG 抽象图；无 SVG 的地图（实验室/灯塔号/迷宫）才用卫星瓦片
    let mainTileLayer: L.TileLayer | null = null
    if (imap.tilePath && !imap.svgPath) {
      mainTileLayer = L.tileLayer(imap.tilePath, tileOpts).addTo(container)
      defaultHandle = {
        show: () => {
          if (mainTileLayer && !container.hasLayer(mainTileLayer)) mainTileLayer.addTo(container)
        },
        hide: () => {
          if (mainTileLayer && container.hasLayer(mainTileLayer))
            container.removeLayer(mainTileLayer)
        },
      }
    }

    if (imap.svgPath) {
      fetch(imap.svgPath)
        .then((r) => r.text())
        .then((svgText) => {
          if (cancelled) return
          const outer = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
          outer.setAttribute('xmlns', 'http://www.w3.org/2000/svg')
          outer.innerHTML = svgText
          const inner = outer.children[0] as SVGSVGElement
          if (inner?.getAttribute('viewBox')) {
            outer.setAttribute('viewBox', inner.getAttribute('viewBox') as string)
          }
          // 收集带 id 的顶层 g 作为可切换楼层组（官方机制）
          const groups: SvgGroup[] = []
          for (const child of Array.from(inner.children)) {
            if (child.nodeName !== 'g') continue
            const gEl = child as SVGGElement
            if (!gEl.id) continue
            const keepWith = ((gEl.dataset['keepWithGroup'] as string) ?? '')
              .split(',')
              .filter(Boolean)
            // base 仅为主层组本身；「跟随主层的附属组」（keepWith 含主层名）不算 base——
            // 否则它们永不隐藏，切楼层时旧层图形叠在新层上，切换看起来无效
            const isBase = gEl.id === imap.svgLayer
            groups.push({ id: gEl.id, isBase, keepWith, el: gEl })
            gEl.classList.add(isBase ? 'base-layer' : 'hidden-layer', ...(isBase ? [] : ['overlay-layer']))
          }
          svgRoot = outer
          svgGroups = groups
          defaultHandle = {
            show: () => showSvgMain(),
            hide: () => {},
          }
          showSvgMain()
          // 必须 addTo：Layer 构造后元素才会真正插入 overlay-pane
          L.svgOverlay(outer, rawBounds, { interactive: false }).addTo(container)
        })
        .catch((err) => console.error('svg load failed', err))
    }

    // tile 楼层（可能同时带 svgLayer：瓦片作底图 + SVG 该层结构线稿叠加）
    ;(imap.layers ?? []).forEach((lyr, i) => {
      if (!lyr.tilePath) return
      const tl = L.tileLayer(lyr.tilePath, tileOpts)
      floorHandles.set(i, {
        show: () => {
          if (!container.hasLayer(tl)) tl.addTo(container)
          if (lyr.svgLayer) {
            // 显示该层 SVG 结构组并隐藏 SVG 主层（否则主层图形盖住 tile 楼层）
            applySvgLayer(lyr.svgLayer, true, true)
          } else if (svgRoot) {
            svgRoot.style.display = 'none' // 无对应 SVG 组：隐藏整个线稿
          }
        },
        hide: () => {
          if (container.hasLayer(tl)) container.removeLayer(tl)
        },
      })
    })

    applyFloor(-1)

    /* ---- 标记 ---- */
    // 坐标与高度合并为一行，减少弹窗高度
    const coordMeta = (en: MarkerEntry) => {
      const parts: string[] = []
      if (en.position)
        parts.push(`坐标 X ${en.position.x.toFixed(1)} · Z ${en.position.z.toFixed(1)}`)
      if (typeof en.top === 'number' || typeof en.bottom === 'number')
        parts.push(`高度 ${fmtNum(en.top)} ~ ${fmtNum(en.bottom)}`)
      return parts.length ? [parts.join(' · ')] : []
    }

    // 狙击 AI：图标外面套一圈醒目的红色光晕，和普通 AI 明显区分。
    // 用 divIcon 而非 icon（后者渲染出的是 <img>，不能有子节点）：
    // 图标里要嵌一个可更新的楼层方向角标。
    const makeIcon = (file: string, opts?: { highlight?: 'red' }) =>
      L.divIcon({
        // 尺寸必须写在 style 里：HTML 的 width/height 属性优先级低于样式表，
        // 会让源图尺寸（撤离点图标比 20px 大）直接生效
        html:
          `<img src="${ICON_BASE}${file}.png" alt="" ` +
          'style="width:20px;height:20px;display:block"/><span class="lvl-arrow"></span>',
        iconSize: [20, 20],
        iconAnchor: [10, 10],
        // 不传时会落到 leaflet-div-icon 的默认样式（白底 + 边框）
        className: opts?.highlight === 'red' ? 'marker-sniper' : '',
      })

    const groupOf = (
      list: MarkerEntry[],
      iconFile: (en: MarkerEntry) => string,
      fallback?: (en: MarkerEntry) => string,
      /** 图标高亮样式（red = 狙击 AI 的红色光晕） */
      highlight?: 'red',
      /** 弹窗补充信息行（撤离点塞撤离要求） */
      meta?: (en: MarkerEntry) => string[],
      /** 永久标签：直接绘制在地图上（撤离点用） */
      tooltip?: (en: MarkerEntry) => HTMLElement | null,
      /** 图层层级（撤离点按阵营分层） */
      zIndex?: (en: MarkerEntry) => number,
    ): L.LayerGroup => {
      const lg = L.layerGroup()
      for (const en of list) {
        if (!en.position) continue
        const title = en.nameZh || en.name || (fallback && fallback(en)) || '未命名'
        const mk = L.marker(pos(en.position), {
          icon: makeIcon(iconFile(en), { highlight }),
          // 狙击 AI 压在普通标记之上，避免被遮挡
          zIndexOffset: highlight === 'red' ? 900 : zIndex ? zIndex(en) : undefined,
        }).bindPopup(
          popupHtml(
            title,
            meta ? meta(en) : [...(en.faction ? [`阵营 ${en.faction}`] : [])],
            undefined,
            coordMeta(en),
          ),
        )
        if (tooltip) {
          const el = tooltip(en)
          if (el)
            mk.bindTooltip(el, {
              permanent: true,
              direction: 'top',
              className: 'extract-label',
              offset: [0, -10],
            })
        }
        // 楼层归属：角标已在图标 html 里，加入地图后取到引用并应用分级样式
        const rec: Leveled = { mk, rank: markerFloorRank(en, ranks, mainRank), arrow: null }
        markerLevels.push(rec)
        mk.on('add', () => {
          rec.arrow = mk.getElement()?.querySelector<HTMLElement>('.lvl-arrow') ?? null
          applyOneMarker(rec, curRank)
        })
        lg.addLayer(mk)
      }
      return lg
    }

    // 撤离点：名称永久绘制（不点击），按阵营配色；层级 PMC 在上、Scav 在下
    const EXTRACT_COLOR: Record<string, string> = {
      pmc: '#f5c518', // PMC（USEC/BEAR）
      scav: '#58a6ff', // Scav
      shared: '#3fb950', // 共享
      transit: '#8b949e',
    }
    const EXTRACT_ZINDEX: Record<string, number> = {
      pmc: 1000,
      shared: 500,
      transit: 500,
      scav: 100,
    }
    /** 撤离点永久标签：名称（按阵营配色）+ 名称后的小图标（开关/物品），其余要求以小标签显示在下方 */
    const extractLabel = (en: MarkerEntry): HTMLElement => {
      const fac = (en.faction ?? 'shared').toLowerCase()
      const color = EXTRACT_COLOR[fac] ?? EXTRACT_COLOR.shared
      const reqs = en.requirements ?? []
      const wrap = document.createElement('div')
      wrap.className = 'extract-label'
      const nameEl = document.createElement('div')
      nameEl.className = 'extract-name'
      nameEl.textContent = en.nameZh ?? en.name ?? ''
      nameEl.style.color = color
      // 图标描边与字体同色（按阵营）：CSS 里用 var(--req-outline) 合成描边
      nameEl.style.setProperty('--req-outline', color)
      for (const r of reqs) {
        const iconHtml = extractReqIconHtml(r)
        if (iconHtml) {
          const holder = document.createElement('span')
          holder.className = 'extract-req-icon-wrap'
          holder.innerHTML = iconHtml
          nameEl.appendChild(holder)
        }
      }
      wrap.appendChild(nameEl)
      for (const r of reqs) {
        if (r.type === 'switch' || r.itemId) continue
        const chip = document.createElement('span')
        chip.className = `extract-req ${reqClass(r)}`
        chip.textContent = reqText(r)
        wrap.appendChild(chip)
      }
      return wrap
    }

    // 分类 / 子分类由数据派生（与「图标」筛选面板共用，见 mapIconGroups.ts）
    const groups = buildIconGroups(mm)
    for (const g of groups) {
      if (g.key !== 'extracts') continue
      for (const s of g.subs) {
        s.meta = (en) => [
          ...(en.faction ? [`阵营 ${en.faction}`] : []),
          ...(en.requirements ?? []).map((r) => `撤离要求：${reqHtml(r)}`),
        ]
        s.tooltip = extractLabel
        s.zIndex = (en) => EXTRACT_ZINDEX[(en.faction ?? 'shared').toLowerCase()] ?? 500
      }
    }
    // 转移点：与撤离点同款——名称永久绘制在地图上（琥珀色，与撤离点的阵营配色区分），
    // 弹窗里再补一行目标地图
    const TRANSIT_COLOR = '#d4a174'
    const transitLabel = (en: MarkerEntry): HTMLElement => {
      const wrap = document.createElement('div')
      wrap.className = 'extract-label'
      const nameEl = document.createElement('div')
      // 比撤离点小一号且不加粗，避免抢走撤离点的视觉重点
      nameEl.className = 'extract-name transit-name'
      nameEl.textContent = en.destZh ? `转移至 ${en.destZh}` : '转移点'
      nameEl.style.color = TRANSIT_COLOR
      // 与撤离点一致：用 --req-outline 合成与字体同色的描边
      nameEl.style.setProperty('--req-outline', TRANSIT_COLOR)
      wrap.appendChild(nameEl)
      return wrap
    }
    for (const g of groups) {
      if (g.key !== 'transits') continue
      for (const s of g.subs) {
        s.meta = (en) => (en.toMapZh ? [`目标地图：${en.toMapZh}`] : [])
        s.tooltip = transitLabel
        // 压在撤离点之下、普通标记之上
        s.zIndex = () => 400
      }
    }
    // Boss 出生点：标题已是 Boss 名，弹窗补刷新率与所在区域
    for (const g of groups) {
      if (g.key !== 'spawns') continue
      for (const s of g.subs) {
        if (s.key !== 'spawns:boss') continue
        s.meta = (en) => {
          const lines: string[] = []
          if (typeof en.spawnChance === 'number' && en.spawnChance > 0)
            lines.push(`刷新率 ${Math.round(en.spawnChance * 100)}%`)
          if (en.locationName) lines.push(`区域 ${en.locationName}`)
          return lines
        }
      }
    }
    // 每个子分类一个独立图层：面板里可单独开关（分类只作批量开关，不参与渲染判断）。
    // hidden 子项（共用 / 过境撤离点）不在面板列出，改为跟随指定子项：任一开启即显示。
    const subLayers = new Map<string, { lg: L.LayerGroup; follow: string[] }>()
    for (const g of groups) {
      for (const s of g.subs) {
        if (!s.list.length) continue
        subLayers.set(subKey(s.key), {
          lg: groupOf(s.list, s.icon, s.name, s.highlight, s.meta, s.tooltip, s.zIndex),
          follow: (s.follow ?? []).map((f) => subKey(`${g.key}:${f}`)),
        })
      }
    }

    // 标记此时还没加入地图（等 syncAll），先把分级状态算好；
    // 每个 marker 加入时会自行补一次（见 groupOf 里的 on('add')）
    applyMarkerLevels(curRank)

    const syncAll = () => {
      const cur = chipsRef.current
      for (const [key, { lg, follow }] of subLayers) {
        const on = follow.length
          ? follow.some((k) => resolveChipOn(cur, k))
          : resolveChipOn(cur, key)
        if (on && !container.hasLayer(lg)) lg.addTo(container)
        else if (!on && container.hasLayer(lg)) container.removeLayer(lg)
      }
    }

    syncAll()
    syncFnsRef.current = [syncAll]

    return () => {
      cancelled = true
      container.getContainer().removeEventListener('click', onMapClick)
      container.remove()
      mapRef.current = null
      playerMarkerRef.current = null
      questLayerRef.current = null
      syncFnsRef.current = []
      floorApplyRef.current = null
    }
  }, [imap, markers])

  useEffect(() => {
    // 切换楼层：底图 + 标记的楼层分级（当前层正常，其它层压暗并标方向箭头）
    floorApplyRef.current?.(floorSel)
  }, [floorSel, imap])

  useEffect(() => {
    syncFnsRef.current.forEach((fn) => fn())
  }, [chips])

  /* ---------- keepAlive：切回地图页（或从隐藏恢复）时重算尺寸并复位视图 ---------- */
  useEffect(() => {
    if (page !== 'map') return
    requestAnimationFrame(() => {
      const m = mapRef.current
      if (m) {
        m.invalidateSize()
        if (rawBoundsRef.current) m.fitBounds(rawBoundsRef.current)
      }
    })
  }, [page])

  /* ---------- 玩家标记（截图驱动，带朝向旋转） ---------- */

  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    const sp = shotRef.current
    if (!sp || !imap) return
    const ll = L.latLng(pos(sp.position))
    // 玩家坐标不在当前地图的世界范围内则不显示（按地图真实范围判断，与用户缩放无关）
    const mb = imap.bounds
    const inMap =
      mb && mb.length === 2
        ? L.latLngBounds(
            L.latLng(mb[0][1], mb[0][0]),
            L.latLng(mb[1][1], mb[1][0]),
          ).contains(ll)
        : true
    if (!inMap) {
      if (playerMarkerRef.current && map.hasLayer(playerMarkerRef.current)) {
        map.removeLayer(playerMarkerRef.current)
        playerMarkerRef.current = null
      }
      return
    }
    const deg = iconRotationDeg(sp.rotation, imap.coordinateRotation)
    if (!playerMarkerRef.current) {
      playerMarkerRef.current = L.marker(ll, {
        icon: L.divIcon({
          className: 'map-player',
          // 纯三角箭头（无尾部条），尖朝上（0deg=北），整体随 rotation 旋转
          html: `<svg viewBox="0 0 24 24" width="44" height="44" style="transform:rotate(${deg.toFixed(
            1,
          )}deg)"><path d="M12 2 L21 22 L12 16 L3 22 Z" fill="#27e0c0" stroke="#0a1f1b" stroke-width="1.2" stroke-linejoin="round"/></svg>`,
          iconSize: [44, 44],
          iconAnchor: [22, 22],
        }),
        zIndexOffset: 10000,
        interactive: false,
      }).addTo(map)
    } else {
      playerMarkerRef.current.setLatLng(ll)
      const svg = playerMarkerRef.current
        .getElement()
        ?.querySelector<SVGSVGElement>('svg')
      if (svg) svg.style.transform = `rotate(${deg.toFixed(1)}deg)`
    }
    // 自动居中关闭：完全不跟随（用户自由浏览地图），只更新箭头方向
    if (!autoCenterRef.current) return
    // 目标缩放级别来自工具栏「自动聚焦」进度条；自动缩放开启时每次定位都缩到该级别，
    // 关闭时保持用户当前缩放。animate:false——无平移动画，截图一到立即到位
    const targetZoom = Math.max(
      imap.minZoom ?? 1,
      Math.min(imap.maxZoom ?? 6, focusZoomRef.current),
    )
    // 自动缩放开启：每次定位都缩到目标级别；关闭：只平移，保持用户当前缩放。
    // 这里必须无条件遵守开关，不能有「首帧例外」——换图、测试、首次定位都会走这条路径，
    // 任何例外都会表现为「没勾自动缩放却还是缩放了」。
    map.setView(ll, autoZoomRef.current ? targetZoom : map.getZoom(), { animate: false })
  }, [shotPos, imap])

  // 地图弹窗标题 → 任务浮窗：展开后滚动到对应任务卡片（等一帧让列表渲染出来）。
  // 必须放在条件 return 之前，否则违反 Hooks 规则（首次渲染 hook 数不一致而崩溃）
  useEffect(() => {
    if (!tasksOpen || !focusQuestId) return
    const t = window.setTimeout(() => {
      document
        .getElementById(`mapq-${focusQuestId}`)
        ?.scrollIntoView({ block: 'center', behavior: 'smooth' })
      setFocusQuestId(null)
    }, 40)
    return () => window.clearTimeout(t)
  }, [tasksOpen, focusQuestId])

  /* ---------- 进行中任务的目标标记 ---------- */

  useEffect(() => {
    const map = mapRef.current
    if (!map || !imap || !qzDoc) return
    if (questLayerRef.current) {
      if (map.hasLayer(questLayerRef.current)) map.removeLayer(questLayerRef.current)
      questLayerRef.current = null
    }
    // 「任务目标」开关：此前它只出现在依赖数组里、effect 内并未判断，
    // 所以切换开关会重跑却照旧绘制，表现为开关无效。
    if (!resolveChipOn(chips, catKey('quests'))) return
    const lg = L.layerGroup()
    const untracked = untrackedRef.current
    // 按设置里的 Wiki 站点生成链接（取快照即可：切换站点后下次重绘生效）
    const wikiUrlFor = useStore.getState().wikiUrlFor
    for (const [tid, t] of Object.entries(qzDoc.tasks)) {
      if (!inProgressIds.has(tid)) continue // 只显示正在进行的任务
      if (untracked.has(tid)) continue // 用户取消跟踪的任务不绘制
      for (const o of t.objectives ?? []) {
        if (!(o.maps ?? []).includes(imap.key)) continue // 目标与本图无关
        for (const z of o.zones ?? []) {
          if (z.nn !== imap.key) continue
          const qName = escapeHtml(t.nameZh ?? t.name ?? '任务')
          // 任务区域：半透明黄色区块，提升目标可见度
          if (z.outline && z.outline.length >= 3) {
            const pts = z.outline.map((p) => pos({ x: p.x, z: p.z }))
            L.polygon(pts, {
              color: '#f5c518',
              weight: 2,
              opacity: 0.9,
              fillColor: '#f5c518',
              // 与 .quest-zone 的呼吸动画下限一致（动画生效时以 CSS 为准）
              fillOpacity: 0.07,
              interactive: false,
              className: 'quest-zone',
            }).addTo(lg)
          }
          // 图标 + 任务名（文字比地点/撤离点标签小一号）
          const icon = L.divIcon({
            className: 'quest-obj-marker',
            html:
              `<img src="${ICON_BASE}quest_objective.png" alt="" />` +
              `<span class="quest-obj-name">${qName}</span>`,
            iconSize: [30, 30],
            iconAnchor: [15, 15],
          })
          lg.addLayer(
            L.marker(pos(z.position), { icon, zIndexOffset: 600 }).bindPopup(
              popupHtml(
                `◎ ${t.nameZh ?? t.name ?? '任务'}`,
                [
                  ...(o.descZh ? [o.descZh] : []),
                  ...(o.optional ? ['可选目标'] : []),
                ],
                wikiUrlFor(tid),
                // 坐标精简：直接 x y z，右下角一行；不再有「坐标 / 高度」这类说明
                [
                  `${z.position.x.toFixed(1)} ${fmtNum(z.position.y)} ${z.position.z.toFixed(1)}`,
                ],
                tid,
              ),
            ),
          )
        }
      }
    }
    lg.addTo(map)
    questLayerRef.current = lg
  }, [qzDoc, inProgressIds, imap, chips, untrackedQuests])

  /* ---------- 渲染 ---------- */

  if (loadErr) {
    return (
      <div className="h-full flex items-center justify-center text-red-400 text-[15px]">
        地图数据加载失败：{loadErr}
      </div>
    )
  }
  if (!skeleton || !markers) {
    return (
      <div className="h-full flex items-center justify-center text-muted text-[15px]">
        正在加载地图数据…
      </div>
    )
  }

  const floors = imap?.layers ?? []
  // 楼层列表（从高到低）：先按名字里的层号，名字里没有层号的（医务室 / 隧道 / 车库…）
  // 再按实际高度。同一顺序在图层构建里用作标记的「楼层排名」。
  const floorItems = sortFloors(floors)
  // 地图任务浮窗数据：本图的进行中任务（无 zone 数据时不过滤，避免误隐藏）
  const mapInProgressQuests = playerQuests.filter((q) => {
    if (q.status !== 'in_progress') return false
    if (!qzDoc || !imap) return true
    const t = qzDoc.tasks[q.questId]
    if (!t) return false
    return (t.objectives ?? []).some(
      (o) =>
        (o.maps ?? []).includes(imap.key) ||
        (o.zones ?? []).some((z) => z.nn === imap.key),
    )
  })

  // 本图 Boss 刷新率（按刷新率降序，数据来自 map-bosses.json）
  const mapBosses = (imap && bossDoc?.maps?.[imap.key]) ?? []

  // 自动聚焦面板内容（桌面工具条与移动端左下角浮层共用）
  const focusBody = (
    <>
      <label className="flex items-center justify-between gap-2 text-[13px] text-[#e6edf3] py-1">
        <span title="关闭后完全不跟随定位，可自由浏览地图">自动聚焦</span>
        <input
          type="checkbox"
          checked={autoCenter}
          onChange={(e) => setAutoCenter(e.target.checked)}
          className="accent-amber"
        />
      </label>
      {/* 自动缩放是自动聚焦的从属选项：未开启聚焦时缩放无从谈起，故隐藏 */}
      {autoCenter && (
        <label className="flex items-center justify-between gap-2 text-[13px] text-[#e6edf3] py-1">
          <span>自动缩放</span>
          <input
            type="checkbox"
            checked={autoZoomMap}
            onChange={(e) => setAutoZoomMap(e.target.checked)}
            className="accent-amber"
          />
        </label>
      )}
      {/* 缩放比例条仅在需要缩放时才有意义 */}
      {autoCenter && autoZoomMap && (
        <div className="pt-2 mt-1 border-t border-line">
          <div className="flex items-center justify-between text-[13px] text-muted mb-1">
            <span>聚焦缩放</span>
            <span className="text-[#d4a174]">{focusZoom.toFixed(1)}×</span>
          </div>
          <input
            type="range"
            min={imap?.minZoom ?? 1}
            max={imap?.maxZoom ?? 6}
            step={0.5}
            value={focusZoom}
            onChange={(e) => setFocusZoom(Number(e.target.value))}
            className="w-full accent-amber"
          />
        </div>
      )}
      <button
        onClick={() => {
          // 测试：绕过截图监控服务，直接构造一个虚拟玩家位置，走与真实截图一致的后续渲染
          const b = imap?.bounds
          let x = 100,
            z = 100
          if (b && b.length === 2) {
            x = (b[0][0] + b[1][0]) / 2
            z = (b[0][1] + b[1][1]) / 2
            const jx = Math.abs(b[1][0] - b[0][0]) * 0.12
            const jz = Math.abs(b[1][1] - b[0][1]) * 0.12
            x += (Math.random() * 2 - 1) * jx
            z += (Math.random() * 2 - 1) * jz
          }
          const now = new Date()
          const p2 = (n: number) => String(n).padStart(2, '0')
          const ts = `${now.getFullYear()}-${p2(now.getMonth() + 1)}-${p2(
            now.getDate(),
          )}[${p2(now.getHours())}-${p2(now.getMinutes())}]`
          setShotPos({
            position: { x, y: 12, z },
            rotation: Math.random() * 360,
            timestamp: ts,
            file: 'simulated',
          })
        }}
        className="w-full text-right px-1 pt-2 text-[12px] text-muted/70 hover:text-[#d4a174]"
      >
        测试
      </button>
    </>
  )

  return (
    <div className="h-full flex flex-col bg-ink-900">
      {/* 地图区 */}
      <div className="relative flex-1 min-h-0">
        <div id={mapDivId} className="absolute inset-0" />
        {/* 图标开关浮动选单：左下角（桌面与移动端共用） */}
        <div
          ref={chipsPanelRef}
          className="absolute left-3 bottom-3 z-[600] flex flex-col items-start gap-2"
        >
            {chipsOpen && <MapIconPanel groups={iconGroups} />}
            <button
              onClick={() => {
                setFocusOpen(false)
                setChipsOpen((o) => !o)
              }}
              title="地图图标显隐（分类 / 子分类）"
              className={`px-2.5 py-1.5 rounded border bg-ink-800/80 shadow-lg text-[13px] transition-colors ${
                chipsOpen
                  ? 'border-amber text-[#d4a174] bg-amber/10'
                  : 'border-line text-[#e6edf3] hover:border-amber/70'
              }`}
            >
              图标 {chipsOpen ? '▾' : '▴'}
            </button>
        </div>
        {/* 右上角浮动按钮组：聚焦 + 层级切换。
            层级 z 需高于右下角「地图信息」浮窗（z-600），否则展开的楼层选单会被它盖住 */}
        <div className="absolute right-3 top-3 z-[620] flex items-start gap-1.5">
          {/* 聚焦（层级切换左侧） */}
          <div ref={focusRef} className="relative flex flex-col items-end gap-1.5">
            <button
              onClick={() => {
                setFocusOpen((v) => !v)
                setChipsOpen(false)
              }}
              title="自动聚焦：定位后自动居中地图（可选自动缩放）"
              className={`px-2.5 py-1.5 rounded border bg-ink-800/80 shadow-lg text-[13px] transition-colors ${
                focusOpen
                  ? 'border-amber text-[#d4a174] bg-amber/10'
                  : 'border-line text-[#e6edf3] hover:border-amber/70'
              }`}
            >
              聚焦
            </button>
            {focusOpen && (
              <div className="w-60 rounded-md border border-line bg-ink-800 p-3 shadow-lg shadow-black/40">
                {focusBody}
              </div>
            )}
          </div>
          {/* 层级切换：地图右上浮动按钮（tarkov.dev 风格，自定义非原生组件） */}
          {floors.length > 0 && (
          // 面板改为 absolute 浮层：展开时不撑宽容器，否则会把左边的「聚焦」按钮顶开
          <div ref={floorRef} className="relative flex flex-col items-end gap-1.5">
            <button
              onClick={() => setFloorOpen((o) => !o)}
              title="切换地图层级"
              className="min-w-[86px] flex items-center justify-center gap-1.5 px-2.5 py-1.5 rounded border border-line bg-ink-800/80 shadow-lg text-[14px] text-[#e6edf3] hover:border-amber/70 transition-colors"
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden>
                <path
                  d="M12 3 2 8l10 5 10-5-10-5Z"
                  stroke="currentColor"
                  strokeWidth="1.6"
                  strokeLinejoin="round"
                />
                <path
                  d="m2 14 10 5 10-5"
                  stroke="currentColor"
                  strokeWidth="1.6"
                  strokeLinejoin="round"
                  opacity="0.55"
                />
              </svg>
              {floorSel === -1 ? '主层' : floorNameZh(floors[floorSel]?.name)}
              <span
                className="text-[11px] opacity-70 transition-transform"
                style={{ transform: floorOpen ? 'rotate(180deg)' : 'none' }}
              >
                ▼
              </span>
            </button>

            {floorOpen && (
              <div className="absolute right-0 top-[calc(100%+6px)] z-[610] min-w-[110px] py-1 rounded-md border border-line bg-ink-800/80 shadow-xl backdrop-blur-sm">
                {floorItems.map(({ lyr, i }) => (
                  <button
                    key={lyr?.name ?? 'main'}
                    onClick={() => {
                      setFloorSel(i)
                      setFloorOpen(false)
                    }}
                    className={`w-full text-left px-2.5 py-1.5 text-[14px] whitespace-nowrap ${
                      floorSel === i
                        ? 'text-[#d4a174] bg-amber/10'
                        : 'text-muted hover:text-[#e6edf3] hover:bg-ink-700/60'
                    }`}
                  >
                    {lyr ? floorNameZh(lyr.name) : '主层'}
                  </button>
                ))}
              </div>
            )}
          </div>
          )}
        </div>

        {/* 左上角浮窗行：任务 + 地图选单 */}
        <div
          className="absolute left-3 top-3 z-[600] flex items-start gap-1.5"
          onWheel={(e) => e.stopPropagation()}
        >
          {/* 任务浮窗：按钮常驻，展开面板为浮层（absolute），不影响右侧地图按钮布局 */}
          <div ref={tasksRef} className="relative">
          <button
            onClick={() => setTasksOpen((o) => !o)}
            title="进行中任务"
            className="flex items-center gap-1.5 px-2.5 py-1.5 rounded border border-line bg-ink-800/80 shadow-lg text-[14px] text-[#e6edf3] hover:border-amber/70 transition-colors"
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden>
              <path
                d="M5 4h14v16H5V4Z"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinejoin="round"
              />
              <path
                d="m8.5 12 2.2 2.2L15.5 9.5"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
            任务{mapInProgressQuests.length > 0 ? ` · ${mapInProgressQuests.length}` : ''}
            <span
              className="text-[11px] opacity-70 transition-transform"
              style={{ transform: tasksOpen ? 'rotate(180deg)' : 'none' }}
            >
              ▼
            </span>
          </button>
          {tasksOpen && (
            // 宽高都按缩放反算：用 dvh 而非 vh（移动端 vh 含地址栏，会高估可用高度）；
            // 11rem 预留：面板顶部起点（按钮+间距）+ 底部左下角「图标」按钮，避免溢出屏幕
            <div className="absolute left-0 top-[calc(100%+6px)] z-[610] w-[380px] max-w-[calc((100vw-24px)/var(--ui-scale,1))] max-h-[calc((100dvh-11rem)/var(--ui-scale,1))] overflow-y-auto rounded-xl border border-line bg-ink-800/80 shadow-xl backdrop-blur-sm p-2.5 space-y-2">
              {mapInProgressQuests.length === 0 ? (
                <div className="text-[13px] text-muted px-0.5 py-3 text-center">
                  本地图暂无进行中任务
                </div>
              ) : (
                mapInProgressQuests.map((q) => (
                  <div key={q.questId} id={`mapq-${q.questId}`}>
                    <QuestCard
                      quest={q}
                      // 这里只列进行中任务，状态药丸没有信息量，隐藏
                      hideStatus
                      // 跟踪开关内置成标题前的罗盘按钮
                      tracked={!untrackedQuests.includes(q.questId)}
                      onToggleTrack={() => toggleQuestTracked(q.questId)}
                    />
                  </div>
                ))
              )}
            </div>
          )}
          </div>
          {/* 地图选单：任务按钮右侧（原左下角），面板同样浮层化 */}
          <div ref={mapMenuRef} className="relative">
            <button
              onClick={() => setMapMenuOpen((o) => !o)}
              title="选择地图"
              className="flex items-center gap-1.5 px-2.5 py-1.5 rounded border border-line bg-ink-800/80 shadow-lg text-[14px] text-[#e6edf3] hover:border-amber/70 transition-colors"
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden>
                <path
                  d="M9 4 3 6v14l6-2 6 2 6-2V4l-6 2-6-2Z"
                  stroke="currentColor"
                  strokeWidth="1.6"
                  strokeLinejoin="round"
                />
                <path d="M9 4v14M15 6v14" stroke="currentColor" strokeWidth="1.2" opacity="0.6" />
              </svg>
              {(skeleton.groups ?? []).find((g) => g.normalizedName === selected)?.nameZh ||
                selected ||
                '选择地图'}
              <span
                className="text-[11px] opacity-70 transition-transform"
                style={{ transform: mapMenuOpen ? 'rotate(180deg)' : 'none' }}
              >
                ▼
              </span>
            </button>
            {mapMenuOpen && (
              <div className="absolute left-0 top-[calc(100%+6px)] z-[610] w-[120px] max-h-[calc(45dvh/var(--ui-scale,1))] overflow-y-auto py-1 rounded-md border border-line bg-ink-800/80 shadow-xl backdrop-blur-sm">
                {skeleton.groups
                  .filter((g) => g.maps.some((m) => m.projection === 'interactive'))
                  .map((g) => (
                    <button
                      key={g.normalizedName}
                      onClick={() => {
                        setSelected(g.normalizedName)
                        setFloorSel(-1)
                        setMapMenuOpen(false)
                      }}
                      title={g.nameZh || g.normalizedName}
                      className={`w-full text-left px-1.5 py-1.5 text-[13px] truncate ${
                        selected === g.normalizedName
                          ? 'text-[#d4a174] bg-amber/10'
                          : 'text-muted hover:text-[#e6edf3] hover:bg-ink-700/60'
                      }`}
                    >
                      {g.nameZh || g.normalizedName}
                    </button>
                  ))}
              </div>
            )}
          </div>
        </div>

        {/* 地图信息：右下角浮动按钮 —— Boss 刷新率。
            面板为常显浮层，容器整体 pointer-events-none 鼠标穿透不挡地图，
            仅按钮 pointer-events-auto 可点；select-none 防止拖动时选中文字 */}
        <div
          ref={infoRef}
          className="pointer-events-none select-none absolute right-3 bottom-3 z-[600] flex flex-col items-end gap-1.5"
          onWheel={(e) => e.stopPropagation()}
        >
          {infoOpen && (
            <div className="pointer-events-none w-[180px] max-h-[calc(60dvh/var(--ui-scale,1))] overflow-y-auto rounded-xl border border-line bg-ink-800/60 shadow-xl p-2.5 space-y-2.5">
              <div>
                <div className="text-[13px] text-muted mb-1">Boss 刷新率</div>
                {mapBosses.length === 0 ? (
                  <div className="text-[13px] text-muted/70">本图无固定 Boss</div>
                ) : (
                  <div className="space-y-1">
                    {mapBosses.map((b) => (
                      <div
                        key={b.id}
                        className="flex items-center justify-between gap-2 text-[14px]"
                      >
                        <span className="flex items-center gap-1.5 min-w-0">
                          {bossImage(b.id) && (
                            <img
                              src={bossImage(b.id)!}
                              alt=""
                              loading="lazy"
                              draggable={false}
                              className="w-[18px] h-[18px] shrink-0 rounded-full object-cover bg-ink-700/60"
                            />
                          )}
                          <span className="text-[#c9d1d9] truncate" title={b.nameZh}>
                            {b.nameZh}
                          </span>
                        </span>
                        <span className="shrink-0 tabular-nums text-amber">
                          {Math.round(b.chance * 100)}%
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}
          <button
            onClick={() => setInfoOpen((o) => !o)}
            title="地图信息：Boss 刷新率"
            className="pointer-events-auto flex items-center gap-1.5 px-2.5 py-1.5 rounded border border-line bg-ink-800/80 shadow-lg text-[14px] text-[#e6edf3] hover:border-amber/70 transition-colors"
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden>
              <circle cx="12" cy="12" r="8.4" stroke="currentColor" strokeWidth="1.6" />
              <path
                d="M12 10.6v6M12 7.8v.6"
                stroke="currentColor"
                strokeWidth="1.9"
                strokeLinecap="round"
              />
            </svg>
            地图信息
            <span
              className="text-[11px] opacity-70 transition-transform"
              style={{ transform: infoOpen ? 'rotate(180deg)' : 'none' }}
            >
              ▼
            </span>
          </button>
        </div>

        {/* 坐标状态条：底部居中（右下已让给地图信息按钮） */}
        <div className="absolute bottom-2 left-1/2 -translate-x-1/2 z-[500] px-2 py-1 rounded bg-black/50 text-[12.5px] text-[#8b949e] pointer-events-none">
          {cursorCoord ? `X ${cursorCoord.x.toFixed(1)} · Z ${cursorCoord.z.toFixed(1)}` : ''}
          {shotPos && (
            <>
              {'　'}
              {`玩家 ${shotPos.position.x.toFixed(1)}, ${shotPos.position.z.toFixed(1)}`}
            </>
          )}
        </div>
      </div>
    </div>
  )
}
