import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { listen } from '@tauri-apps/api/event'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import './map.css'
import {
  getPlayerPosition,
  fetchTarkovTime,
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
import { useStore, useTopPad } from '../store'
import { QuestCard } from '../components/QuestCard'

/* ================= 常量 ================= */

const ICON_BASE = 'maps/interactive/'

// 常见英文楼层名的中文显示
const FLOOR_NAME_ZH: Record<string, string> = {
  'Ground Floor': '主层',
  'Ground Level': '主层',
  '1st Floor': '1楼',
  'First Floor': '1楼',
  '2nd Floor': '2楼',
  'Second Floor': '2楼',
  'Second Level': '2楼',
  '3rd Floor': '3楼',
  'Third Floor': '3楼',
  '4th Floor': '4楼',
  'Fourth Floor': '4楼',
  '5th Floor': '5楼',
  'Fifth Floor': '5楼',
  '6th Floor': '6楼',
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
/** 楼层实际高度（extents height 上限的最大值），用于排序；主层（null）按 0 处理 */
const floorHeight = (lyr: SkeletonLayer | null): number => {
  if (!lyr) return 0
  const hs = (lyr.extents ?? [])
    .map((e) => e.height?.[1])
    .filter((v): v is number => typeof v === 'number')
  return hs.length ? Math.max(...hs) : Number.NEGATIVE_INFINITY
}
// lootContainer normalizedName -> 已下载图标文件
const CONTAINER_ICONS = new Set([
  'buried-barrel-cache',
  'cash-register',
  'crate',
  'dead-scav',
  'drawer',
  'duffle-bag',
  'festive-airdrop-supply-crate',
  'grenade-box',
  'ground-cache',
  'jacket',
  'medbag-smu06',
  'medcase',
  'pc-block',
  'plastic-suitcase',
  'safe',
  'toolbox',
  'weapon-box',
  'wooden-ammo-box',
  'wooden-crate',
])
const DEFAULT_CONTAINER_ICON = 'container_crate'

const SPAWN_ICON: Record<string, string> = {
  player: 'spawn_pmc',
  pmc: 'spawn_pmc',
  botpmc: 'spawn_pmc',
  scav: 'spawn_scav',
  bot: 'spawn_scav',
  sniper_scav: 'spawn_sniper_scav',
  boss: 'spawn_boss',
  rogue: 'spawn_rogue',
  bloodhound: 'spawn_bloodhound',
  'cultist-priest': 'spawn_cultist-priest',
  'black-div': 'spawn_black-div',
  af: 'spawn_af',
}

const EXTRACT_ICON: Record<string, string> = {
  pmc: 'extract_pmc',
  scav: 'extract_scav',
  shared: 'extract_shared',
  transit: 'extract_transit',
}

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

type ChipKey =
  | 'quests'
  | 'extract_pmc'
  | 'extract_scav'
  | 'player_spawns'
  | 'ai_spawns'
  | 'bosses'
  | 'locks'
  | 'hazards'
  | 'containers'
  | 'switches'
  | 'weapons'
  | 'btr'
  | 'labels'

const CHIP_DEFS: { key: ChipKey; label: string }[] = [
  { key: 'quests', label: '任务目标' },
  { key: 'extract_pmc', label: 'PMC撤离' },
  { key: 'extract_scav', label: 'Scav撤离' },
  { key: 'player_spawns', label: '玩家出生点' },
  { key: 'ai_spawns', label: 'AI出生点' },
  { key: 'bosses', label: 'Boss' },
  { key: 'locks', label: '钥匙锁' },
  { key: 'hazards', label: '危险区' },
  { key: 'containers', label: '容器' },
  { key: 'switches', label: '开关' },
  { key: 'weapons', label: '固定武器' },
  { key: 'btr', label: 'BTR' },
]

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

/**
 * 塔科夫游戏内时钟：现实 1 秒 = 游戏 7 秒。
 * @param realMs 现实时间毫秒戳
 * @param offsetHours 左右局偏移（左局 0，右局 +12）
 */
function tarkovClockText(realMs: number, offsetHours: number): string {
  const gameMs = realMs * 7 + offsetHours * 3600_000
  const total = Math.floor(gameMs / 1000) % 86400
  const h = String(Math.floor(total / 3600)).padStart(2, '0')
  const m = String(Math.floor((total % 3600) / 60)).padStart(2, '0')
  const s = String(total % 60).padStart(2, '0')
  return `${h}:${m}:${s}`
}

/** HTML 转义（任务名等文本注入到 divIcon/popup 前使用） */
function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string,
  )
}

/** 标记弹窗内容 */
function popupHtml(title: string, meta: string[]) {
  return `<div><div class="map-popup-title">${title}</div>${meta
    .map((m) => `<div class="map-popup-meta">${m}</div>`)
    .join('')}</div>`
}

/* ================= 组件 ================= */

export function MapPage() {
  const [skeleton, setSkeleton] = useState<SkeletonDoc | null>(null)
  const [markers, setMarkers] = useState<MapMarkersDoc | null>(null)
  const [qzDoc, setQzDoc] = useState<QuestZonesDoc | null>(null)
  const [bossDoc, setBossDoc] = useState<MapBossesDoc | null>(null)
  const [loadErr, setLoadErr] = useState('')
  // 侧边栏折叠时，顶部工具条为左上角浮动按钮预留空位
  const topPad = useTopPad()
  const [selected, setSelected] = useState<string>(() => useStore.getState().currentMap ?? 'factory')
  const autoZoomMap = useStore((s) => s.autoZoomMap)
  const setAutoZoomMap = useStore((s) => s.setAutoZoomMap)
  const untrackedQuests = useStore((s) => s.untrackedQuests)
  const toggleQuestTracked = useStore((s) => s.toggleQuestTracked)
  const [chips, setChips] = useState<Record<ChipKey, boolean>>({
    quests: true,
    extract_pmc: true,
    extract_scav: true,
    player_spawns: false,
    ai_spawns: false,
    bosses: true,
    locks: false,
    hazards: false,
    containers: false,
    switches: false,
    weapons: false,
    btr: false,
    labels: false,
  })
  const [floorSel, setFloorSel] = useState(-1) // -1 = 默认主层
  const [floorOpen, setFloorOpen] = useState(false) // 层级切换浮层
  const [mapMenuOpen, setMapMenuOpen] = useState(false) // 左下角地图选单浮层
  const [tasksOpen, setTasksOpen] = useState(false) // 右下角任务浮窗
  const [infoOpen, setInfoOpen] = useState(false) // 右下角地图信息浮窗
  // 塔科夫游戏内时间：{ serverMs: 同步到的服务器时间, localMs: 同步时的本地时间 }
  // 同步失败时保持 null（顶部时间显示隐藏）
  const [tarkovClock, setTarkovClock] = useState<{ serverMs: number; localMs: number } | null>(
    null,
  )
  const [nowTick, setNowTick] = useState(() => Date.now())
  const [cursorCoord, setCursorCoord] = useState<{ x: number; z: number } | null>(null)
  // 三个浮窗（地图选单/任务/层级）的容器 ref：点击外部自动关闭
  const mapMenuRef = useRef<HTMLDivElement | null>(null)
  const tasksRef = useRef<HTMLDivElement | null>(null)
  const infoRef = useRef<HTMLDivElement | null>(null)
  const floorRef = useRef<HTMLDivElement | null>(null)
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
        if (prev !== nn) {
          setFloorSel(-1)
          panOnceRef.current = false // 换图后首次收到位置自动平移一次
        }
        return nn
      })
      useStore.getState().setCurrentMap(nn)
    }
  }, [currentMapId, markers, selectable])

  /* ---------- 塔科夫游戏内时间（左右局） ---------- */
  // 游戏内时间是现实的 7 倍速；左右局相差 12 小时且同时正向流逝
  useEffect(() => {
    let timer: number | undefined
    const sync = async () => {
      const serverMs = await fetchTarkovTime()
      if (serverMs) setTarkovClock({ serverMs, localMs: Date.now() })
    }
    void sync()
    // 1s 刷新显示，10 分钟重新与服务器同步一次
    timer = window.setInterval(() => setNowTick(Date.now()), 1000)
    const resync = window.setInterval(() => void sync(), 10 * 60 * 1000)
    return () => {
      if (timer) window.clearInterval(timer)
      window.clearInterval(resync)
    }
    // currentMapId 变化 = 进入（切换）地图，此时重新同步一次时间
  }, [currentMapId])

  /* ---------- Leaflet 构建（每张地图重建实例，保证状态干净） ---------- */

  const mapDivId = 'eft-spy-map'
  const mapRef = useRef<L.Map | null>(null)
  const imapRef = useRef<SkeletonMap | undefined>(imap)
  imapRef.current = imap
  const shotRef = useRef<PlayerPositionPayload | null>(shotPos)
  shotRef.current = shotPos
  const playerMarkerRef = useRef<L.Marker | null>(null)
  const questLayerRef = useRef<L.LayerGroup | null>(null)
  const panOnceRef = useRef(false)
  // 楼层选择 ref：标记灰显的 syncAll 闭包在构建 effect 内创建，通过 ref 读最新值
  const floorSelRef = useRef(floorSel)
  floorSelRef.current = floorSel
  // 自动缩放 / 任务跟踪 ref：地图构建 effect 与跟随 effect 通过 ref 读最新值
  const autoZoomRef = useRef(false)
  autoZoomRef.current = autoZoomMap
  const untrackedRef = useRef<Set<string>>(new Set())
  untrackedRef.current = new Set(untrackedQuests)
  // keepAlive 适配：页面隐藏（display:none）时容器尺寸为 0，需记录可见状态并在切回时重算
  const pageRef = useRef(page)
  pageRef.current = page
  const rawBoundsRef = useRef<L.LatLngBounds | null>(null)

  // 点击浮窗外部自动关闭（容器内 onMouseDown 已 stopPropagation，不会误触发）
  // 注意：「地图信息」面板不在此列——它只由按钮点击切换显隐，点外部不关闭
  useEffect(() => {
    if (!mapMenuOpen && !tasksOpen && !floorOpen) return
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node
      if (mapMenuOpen && mapMenuRef.current && !mapMenuRef.current.contains(t))
        setMapMenuOpen(false)
      if (tasksOpen && tasksRef.current && !tasksRef.current.contains(t)) setTasksOpen(false)
      if (floorOpen && floorRef.current && !floorRef.current.contains(t)) setFloorOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [mapMenuOpen, tasksOpen, floorOpen])

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

    const applyFloor = (idx: number) => {
      defaultHandle?.[idx === -1 ? 'show' : 'hide']()
      for (const [i, h] of floorHandles) h[i === idx ? 'show' : 'hide']()
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
    const coordMeta = (en: MarkerEntry) => {
      const rows: string[] = []
      if (en.position)
        rows.push(`坐标 X ${en.position.x.toFixed(1)} · Z ${en.position.z.toFixed(1)}`)
      if (typeof en.top === 'number' || typeof en.bottom === 'number')
        rows.push(`高度 ${fmtNum(en.top)} ~ ${fmtNum(en.bottom)}`)
      return rows
    }

    const makeIcon = (file: string) =>
      L.icon({ iconUrl: `${ICON_BASE}${file}.png`, iconSize: [20, 20], iconAnchor: [10, 10] })

    // —— 标记自动分层：按高度（top/bottom/position.y）与楼层 extents 的 height 区间求交 ——
    const floorMarkers: { m: L.Marker; idx: number }[] = []
    const markerFloorIdx = (en: MarkerEntry): number => {
      const layers = imap.layers ?? []
      if (!layers.length) return -1
      const lo2 = en.bottom ?? en.top ?? en.position?.y
      const hi2 = en.top ?? en.bottom ?? en.position?.y
      if (lo2 == null || hi2 == null) return -1 // 无高度信息：归属主层（不参与灰显）
      for (let i = 0; i < layers.length; i++) {
        for (const ext of layers[i].extents ?? []) {
          const [lo, hi] = ext.height ?? []
          if (lo == null || hi == null) continue
          if (hi2 >= lo && lo2 <= hi) return i // 高度区间相交
        }
      }
      return -1
    }
    /** 按当前楼层灰显不属于该层的标记（无高度信息的标记保持正常） */
    const syncFloors = () => {
      const cur = floorSelRef.current
      const hasFloors = (imap.layers?.length ?? 0) > 0
      for (const { m, idx } of floorMarkers) {
        m.setOpacity(!hasFloors || idx === -1 || idx === cur ? 1 : 0.2)
      }
    }

    const groupOf = (
      list: MarkerEntry[],
      iconFile: (en: MarkerEntry) => string,
      fallback?: (en: MarkerEntry) => string,
    ): L.LayerGroup => {
      const lg = L.layerGroup()
      for (const en of list) {
        if (!en.position) continue
        const title = en.nameZh || en.name || (fallback && fallback(en)) || '未命名'
        const mk = L.marker(pos(en.position), { icon: makeIcon(iconFile(en)) }).bindPopup(
          popupHtml(title, [
            ...(en.faction ? [`阵营 ${en.faction}`] : []),
            ...coordMeta(en),
          ]),
        )
        floorMarkers.push({ m: mk, idx: markerFloorIdx(en) })
        lg.addLayer(mk)
      }
      return lg
    }

    const spawnIcon = (en: MarkerEntry) => {
      for (const c of en.categories ?? []) if (SPAWN_ICON[c]) return SPAWN_ICON[c]
      return 'spawn_scav'
    }
    const extractIcon = (en: MarkerEntry) =>
      EXTRACT_ICON[(en.faction ?? '').toLowerCase()] ?? 'extract_shared'
    const containerIcon = (en: MarkerEntry) =>
      en.icon && CONTAINER_ICONS.has(en.icon) ? `container_${en.icon}` : DEFAULT_CONTAINER_ICON
    const hazardIcon = (en: MarkerEntry) => (en.kind === 'mortar' ? 'hazard_mortar' : 'hazard')

    const chipGroups = new Map<Exclude<ChipKey, 'labels'>, L.LayerGroup>()
    const defs: [
      Exclude<ChipKey, 'labels'>,
      MarkerEntry[],
      (en: MarkerEntry) => string,
      ((en: MarkerEntry) => string)?,
    ][] = [
      [
        'player_spawns',
        (mm.spawns ?? []).filter(
          (s) => !(s.categories ?? []).includes('boss') && (s.categories ?? []).includes('player'),
        ),
        spawnIcon,
        () => '玩家出生点',
      ],
      [
        'ai_spawns',
        (mm.spawns ?? []).filter(
          (s) =>
            !(s.categories ?? []).includes('boss') && !(s.categories ?? []).includes('player'),
        ),
        spawnIcon,
        () => 'AI 出生点',
      ],
      [
        'bosses',
        [
          ...(mm.bosses ?? []),
          ...(mm.spawns ?? []).filter((s) => (s.categories ?? []).includes('boss')),
        ],
        () => 'spawn_boss',
        () => 'Boss',
      ],
      ['locks', mm.locks ?? [], () => 'lock', undefined],
      ['hazards', mm.hazards ?? [], hazardIcon, undefined],
      ['containers', mm.lootContainers ?? [], containerIcon, undefined],
      ['switches', mm.switches ?? [], () => 'switch', undefined],
      ['weapons', mm.stationaryWeapons ?? [], () => 'stationarygun', undefined],
      ['btr', mm.btrStops ?? [], () => 'btr_stop', undefined],
    ]
    for (const [key, list, iconFn, fb] of defs) {
      if (!list.length) continue
      chipGroups.set(key, groupOf(list, iconFn, fb))
    }

    const keyOf = (
      m: Map<Exclude<ChipKey, 'labels'>, L.LayerGroup>,
      target: L.LayerGroup,
    ): Exclude<ChipKey, 'labels'> | null => {
      for (const [k, v] of m) if (v === target) return k
      return null
    }

    const syncAll = () => {
      const cur = chipsRef.current
      for (const [, lg] of chipGroups) {
        const key = keyOf(chipGroups, lg)
        if (!key) continue
        if (cur[key] && !container.hasLayer(lg)) lg.addTo(container)
        else if (!cur[key] && container.hasLayer(lg)) container.removeLayer(lg)
      }
    }
    // 撤离点：单独构建，直接永久绘制名称（不点击），按阵营配色
    const EXTRACT_COLOR: Record<string, string> = {
      pmc: '#f5c518', // PMC（USEC/BEAR）
      scav: '#58a6ff', // Scav
      shared: '#3fb950', // 共享
      transit: '#8b949e',
    }
    // 图层层级：PMC 在最上，shared/transit 居中，scav 在最下
    const EXTRACT_ZINDEX: Record<string, number> = {
      pmc: 1000,
      shared: 500,
      transit: 500,
      scav: 100,
    }
    const extractLayer = L.layerGroup()
    const extractMarkers: { m: L.Marker; fac: string }[] = []
    for (const en of mm.extracts ?? []) {
      if (!en.position) continue
      const fac = (en.faction ?? 'shared').toLowerCase()
      const color = EXTRACT_COLOR[fac] ?? EXTRACT_COLOR.shared
      const reqs = en.requirements ?? []
      const m = L.marker(pos(en.position), { icon: makeIcon(extractIcon(en)) })
      m.setZIndexOffset(EXTRACT_ZINDEX[fac] ?? 500)
      floorMarkers.push({ m, idx: markerFloorIdx(en) })
      m.bindPopup(
        popupHtml(en.nameZh ?? en.name ?? '未命名', [
          ...(en.faction ? [`阵营 ${en.faction}`] : []),
          ...reqs.map((r) => `撤离要求：${reqHtml(r)}`),
          ...coordMeta(en),
        ]),
      )
      // 永久标签：名称（按阵营配色）+ 撤离要求小标签，无需点击即可见
      const wrap = document.createElement('div')
      wrap.className = 'extract-label'
      const nameEl = document.createElement('div')
      nameEl.className = 'extract-name'
      nameEl.textContent = en.nameZh ?? en.name ?? ''
      nameEl.style.color = color
      wrap.appendChild(nameEl)
      for (const r of reqs) {
        const chip = document.createElement('span')
        chip.className = `extract-req ${reqClass(r)}`
        chip.textContent = reqText(r)
        wrap.appendChild(chip)
      }
      m.bindTooltip(wrap, {
        permanent: true,
        direction: 'top',
        className: 'extract-label',
        offset: [0, -10],
      })
      extractLayer.addLayer(m)
      extractMarkers.push({ m, fac })
    }
    // 撤离点按阵营显隐：PMC/Scav 各自独立开关；shared/transit（共享/合作）任一勾选即显示
    const syncExtracts = () => {
      const cur = chipsRef.current
      const pmcOn = cur['extract_pmc']
      const scavOn = cur['extract_scav']
      for (const { m, fac } of extractMarkers) {
        const show = fac === 'pmc' ? pmcOn : fac === 'scav' ? scavOn : pmcOn || scavOn
        const on = extractLayer.hasLayer(m)
        if (show && !on) extractLayer.addLayer(m)
        else if (!show && on) extractLayer.removeLayer(m)
      }
    }
    if (container.hasLayer(extractLayer)) container.removeLayer(extractLayer)
    extractLayer.addTo(container)
    syncExtracts()

    syncAll()
    syncFloors()
    syncFnsRef.current = [syncAll, syncExtracts, syncFloors]

    return () => {
      cancelled = true
      container.remove()
      mapRef.current = null
      playerMarkerRef.current = null
      questLayerRef.current = null
      syncFnsRef.current = []
      floorApplyRef.current = null
    }
  }, [imap, markers])

  useEffect(() => {
    floorApplyRef.current?.(floorSel)
    // 楼层切换后重新同步标记灰显
    syncFnsRef.current.forEach((fn) => fn())
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
    // 玩家坐标不在当前地图范围内则不显示（截图未按图过滤时的兜底）
    if (!map.getBounds().pad(0.35).contains(ll)) {
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
          html: `<img src="${ICON_BASE}player-position.png" style="transform:rotate(${deg.toFixed(
            1,
          )}deg)">`,
          iconSize: [44, 44],
          iconAnchor: [22, 22],
        }),
        zIndexOffset: 10000,
        interactive: false,
      }).addTo(map)
    } else {
      playerMarkerRef.current.setLatLng(ll)
      const img = playerMarkerRef.current
        .getElement()
        ?.querySelector<HTMLImageElement>('img')
      if (img) img.style.transform = `rotate(${deg.toFixed(1)}deg)`
    }
    // 每次截图都平移跟随玩家；「自动缩放」开启时每次都缩放到聚焦级别，
    // 关闭时保持用户当前缩放。animate:false——无平移动画，截图一到立即到位
    const targetZoom = Math.max(imap.minZoom ?? 1, Math.min(imap.maxZoom ?? 6, 4))
    if (!panOnceRef.current) {
      panOnceRef.current = true
      map.setView(ll, targetZoom, { animate: false })
    } else if (autoZoomRef.current) {
      map.setView(ll, targetZoom, { animate: false })
    } else {
      map.setView(ll, map.getZoom(), { animate: false })
    }
  }, [shotPos, imap])

  /* ---------- 进行中任务的目标标记 ---------- */

  useEffect(() => {
    const map = mapRef.current
    if (!map || !imap || !qzDoc) return
    if (questLayerRef.current) {
      if (map.hasLayer(questLayerRef.current)) map.removeLayer(questLayerRef.current)
      questLayerRef.current = null
    }
    const lg = L.layerGroup()
    const untracked = untrackedRef.current
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
              fillOpacity: 0.18,
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
              popupHtml(`◎ ${t.nameZh ?? t.name ?? '任务'}`, [
                ...(o.descZh ? [o.descZh] : []),
                ...(o.optional ? ['可选目标'] : []),
                ...(typeof z.top === 'number' || typeof z.bottom === 'number'
                  ? [`高度 ${fmtNum(z.top)} ~ ${fmtNum(z.bottom)}`]
                  : []),
                `坐标 X ${z.position.x.toFixed(1)} · Z ${z.position.z.toFixed(1)}`,
              ]),
            ),
          )
        }
      }
    }
    lg.addTo(map)
    questLayerRef.current = lg
  }, [qzDoc, inProgressIds, imap, chips.quests, untrackedQuests])

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
  // 楼层按实际高度排序（越高越上面），主层（高度 0）参与排序：
  // 如工厂 → 3楼、2楼、主层、隧道。i=-1 表示主层。
  const floorItems: { lyr: SkeletonLayer | null; i: number }[] = [
    { lyr: null, i: -1 },
    ...floors.map((lyr, i) => ({ lyr, i })),
  ].sort((a, b) => floorHeight(b.lyr) - floorHeight(a.lyr))
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

  // 地图时间（左右局）：同步失败时为空，面板内显示「暂不可用」
  const clockText = tarkovClock
    ? {
        left: tarkovClockText(tarkovClock.serverMs + (nowTick - tarkovClock.localMs), 0),
        right: tarkovClockText(tarkovClock.serverMs + (nowTick - tarkovClock.localMs), 12),
      }
    : null

  // 本图 Boss 刷新率（按刷新率降序，数据来自 map-bosses.json）
  const mapBosses = (imap && bossDoc?.maps?.[imap.key]) ?? []

  return (
    <div className="h-full flex flex-col bg-ink-900">
      {/* 工具条（地图选单已移至左下角浮动按钮） */}
      <div
        className="shrink-0 flex items-center flex-wrap gap-x-3 gap-y-1 px-3 py-2 border-b border-line bg-ink-800"
        style={{ paddingLeft: 12 + topPad }}
      >
        <div className="flex items-center gap-1 flex-wrap">
          {CHIP_DEFS.map((c) => (
            <button
              key={c.key}
              onClick={() => setChips((p) => ({ ...p, [c.key]: !p[c.key] }))}
              className={`px-2 py-[3px] rounded text-[13px] border ${
                chips[c.key]
                  ? 'border-amber text-[#d4a174] bg-amber/10'
                  : 'border-line text-muted hover:text-[#e6edf3]'
              }`}
            >
              {c.label}
            </button>
          ))}
        </div>
        <div className="flex-1" />
        {/* 自动缩放：截图定位后是否每次都缩放聚焦（关闭则只平移、保持当前缩放） */}
        <button
          onClick={() => setAutoZoomMap(!autoZoomMap)}
          title={
            autoZoomMap
              ? '自动缩放已开启：每次截图定位都会缩放到聚焦级别'
              : '自动缩放已关闭：截图定位只平移，保持你当前的缩放级别'
          }
          className={`shrink-0 flex items-center gap-1.5 px-2 py-[3px] rounded text-[13px] border ${
            autoZoomMap
              ? 'border-amber text-[#d4a174] bg-amber/10'
              : 'border-line text-muted hover:text-[#e6edf3]'
          }`}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden>
            <circle cx="11" cy="11" r="6.4" stroke="currentColor" strokeWidth="1.8" />
            <path
              d="M20 20l-4.4-4.4M11 8.4v5.2M8.4 11h5.2"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
            />
          </svg>
          自动缩放
        </button>
      </div>

      {/* 地图区 */}
      <div className="relative flex-1 min-h-0">
        <div id={mapDivId} className="absolute inset-0" />
        {/* 层级切换：地图右上浮动按钮（tarkov.dev 风格，自定义非原生组件） */}
        {floors.length > 0 && (
          <div ref={floorRef} className="absolute right-3 top-3 z-[600] flex flex-col items-end gap-1.5">
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
              <div className="min-w-[110px] py-1 rounded-md border border-line bg-ink-800/80 shadow-xl backdrop-blur-sm">
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

        {/* 地图选单：左下角浮动按钮（原顶栏 select 移此） */}
        <div
          ref={mapMenuRef}
          className="absolute left-3 bottom-3 z-[600] flex flex-col items-start gap-1.5"
          onMouseDown={(e) => e.stopPropagation()}
          onWheel={(e) => e.stopPropagation()}
        >
          {mapMenuOpen && (
            <div className="w-[120px] max-h-[45vh] overflow-y-auto py-1 rounded-md border border-line bg-ink-800/80 shadow-xl backdrop-blur-sm">
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
        </div>

        {/* 任务浮窗：左上角浮动按钮，显示监控页的进行中任务卡片 */}
        <div
          ref={tasksRef}
          className="absolute left-3 top-3 z-[600] flex flex-col items-start gap-1.5"
          onMouseDown={(e) => e.stopPropagation()}
          onWheel={(e) => e.stopPropagation()}
        >
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
            <div className="w-[380px] max-w-[calc(100vw-24px)] max-h-[60vh] overflow-y-auto rounded-xl border border-line bg-ink-800/80 shadow-xl backdrop-blur-sm p-2.5 space-y-2">
              <div className="text-[13px] text-muted px-0.5">
                本图进行中任务 · {mapInProgressQuests.length}
                <span className="ml-1 opacity-70">
                  （◉ 跟踪/○ 不跟踪，不跟踪的任务不在地图绘制）
                </span>
              </div>
              {mapInProgressQuests.length === 0 ? (
                <div className="text-[13px] text-muted px-0.5 py-3 text-center">
                  本地图暂无进行中任务
                </div>
              ) : (
                mapInProgressQuests.map((q) => {
                  const tracked = !untrackedQuests.includes(q.questId)
                  return (
                    <div key={q.questId} className="flex items-start gap-1.5">
                      <button
                        onClick={() => toggleQuestTracked(q.questId)}
                        title={tracked ? '取消跟踪：不在地图绘制该任务目标' : '跟踪：在地图绘制该任务目标'}
                        className={`mt-3 shrink-0 w-5 h-5 grid place-items-center rounded border text-[12px] ${
                          tracked
                            ? 'border-amber text-[#d4a174] bg-amber/10'
                            : 'border-line text-muted hover:text-[#e6edf3]'
                        }`}
                      >
                        {tracked ? '◉' : '○'}
                      </button>
                      <div className="flex-1 min-w-0">
                        <QuestCard quest={q} />
                      </div>
                    </div>
                  )
                })
              )}
            </div>
          )}
        </div>

        {/* 地图信息：右下角浮动按钮 —— Boss 刷新率 + 地图时间 */}
        <div
          ref={infoRef}
          className="absolute right-3 bottom-3 z-[600] flex flex-col items-end gap-1.5"
          onMouseDown={(e) => e.stopPropagation()}
          onWheel={(e) => e.stopPropagation()}
        >
          {infoOpen && (
            <div className="w-[280px] max-h-[60vh] overflow-y-auto rounded-xl border border-line bg-ink-800/80 shadow-xl backdrop-blur-sm p-2.5 space-y-2.5">
              <div>
                <div className="text-[13px] text-muted mb-1">地图时间</div>
                {clockText ? (
                  <div className="text-[14px] text-[#c9d1d9] tabular-nums leading-relaxed">
                    <div>左局 {clockText.left}</div>
                    <div>右局 {clockText.right}</div>
                  </div>
                ) : (
                  <div className="text-[13px] text-muted/70">
                    暂不可用（无可用时间源，预留）
                  </div>
                )}
              </div>
              <div className="border-t border-line pt-2">
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
                        <span className="text-[#c9d1d9] truncate">{b.nameZh}</span>
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
            title="地图信息：Boss 刷新率与地图时间"
            className="flex items-center gap-1.5 px-2.5 py-1.5 rounded border border-line bg-ink-800/80 shadow-lg text-[14px] text-[#e6edf3] hover:border-amber/70 transition-colors"
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

        {/* 坐标状态条：底部居中（左下/右下已让给浮窗按钮） */}
        <div className="absolute bottom-2 left-1/2 -translate-x-1/2 z-[500] px-2 py-1 rounded bg-black/50 text-[12.5px] text-[#8b949e] pointer-events-none">
          {cursorCoord ? `X ${cursorCoord.x.toFixed(1)} · Z ${cursorCoord.z.toFixed(1)}` : ''}
          {shotPos && (
            <>
              {'　'}
              {`玩家 ${shotPos.position.x.toFixed(1)}, ${shotPos.position.z.toFixed(1)} · 航向 ${Math.round(
                iconRotationDeg(shotPos.rotation, 0),
              )}° · ${shotPos.timestamp}`}
            </>
          )}
        </div>
      </div>
    </div>
  )
}
