import { useEffect, useMemo, useRef, useState } from 'react'
import { listen } from '@tauri-apps/api/event'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import './map.css'
import { getPlayerPosition } from '../tauri'
import type { PlayerPositionPayload } from '../types'
import { useStore, useTopPad } from '../store'

/* ================= 类型（对应 public/data/*.json 生成脚本输出） ================= */

interface Position {
  x: number
  y?: number
  z: number
}

interface MarkerEntry {
  id?: string
  name?: string
  nameZh?: string | null
  position?: Position | null
  top?: number | null
  bottom?: number | null
  faction?: string | null
  categories?: string[]
  kind?: string | null
  icon?: string | null
  /** 撤离要求（合作撤离/信号弹/付费…），来自 tarkov.dev，缺失时为空 */
  requirements?: {
    type: string
    value?: string | null
    /** 物品类要求（itemRequired/payment）携带，用于 popup 显示图标 */
    itemId?: string
    name?: string
    count?: number | null
  }[] | null
}

interface MapMarkersDoc {
  version: number
  maps: Record<string, Record<string, MarkerEntry[]>>
  /** 游戏 nameId -> normalizedName（来自 json.tarkov.dev） */
  nameIds?: Record<string, string>
  /** 无独立地图的变体 location id 归并规则 */
  nameIdFallback?: Record<string, string>
}

interface SkeletonLayer {
  name: string
  svgLayer?: string
  tilePath?: string
  show?: boolean
}

interface SkeletonMap {
  key: string
  projection: string
  minZoom?: number
  maxZoom?: number
  tileSize?: number
  transform?: number[]
  coordinateRotation?: number
  bounds: [[number, number], [number, number]]
  svgPath?: string
  svgLayer?: string
  tilePath?: string
  layers?: SkeletonLayer[]
  labels?: { position: [number, number]; text: string; rotation?: number; size?: number }[]
}

interface SkeletonGroup {
  normalizedName: string
  nameZh?: string
  primaryPath?: string
  maps: SkeletonMap[]
}

interface SkeletonDoc {
  version: number
  groups: SkeletonGroup[]
}

/** quest-zones.json：进行中任务的目标位置（zones 带坐标） */
interface QuestZone {
  nn: string
  position: Position
  top?: number | null
  bottom?: number | null
  /** 区域多边形（游戏坐标 x/z），用于绘制半透明黄色区块 */
  outline?: { x: number; z: number }[]
}
interface QuestZoneObjective {
  type?: string | null
  optional?: boolean
  descZh?: string | null
  maps: string[]
  zones: QuestZone[]
}
interface QuestZonesDoc {
  version: number
  tasks: Record<
    string,
    { name?: string; nameZh?: string; objectives: QuestZoneObjective[] }
  >
}

/* ================= 常量 ================= */

const ICON_BASE = 'maps/interactive/'
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
  const [loadErr, setLoadErr] = useState('')
  // 侧边栏折叠时，顶部工具条为左上角浮动按钮预留空位
  const topPad = useTopPad()
  const [selected, setSelected] = useState<string>(() => useStore.getState().currentMap ?? 'factory')
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
  const [cursorCoord, setCursorCoord] = useState<{ x: number; z: number } | null>(null)
  // 截图解析出的玩家位置 + 全局当前地图（location id），由 tauri 全局监听写入，任何页面生效
  const [shotPos, setShotPos] = useState<PlayerPositionPayload | null>(null)
  const currentMapId = useStore((s) => s.currentMapId)
  const page = useStore((s) => s.page)

  useEffect(() => {
    const base = import.meta.env.BASE_URL.replace(/\/$/, '')
    Promise.all([
      fetch(`${base}/data/maps-skeleton.json`).then((r) => r.json()),
      fetch(`${base}/data/map-markers.json`).then((r) => r.json()),
      fetch(`${base}/data/quest-zones.json`).then((r) => r.json()),
    ])
      .then(([sk, mk, qz]) => {
        setSkeleton(sk as SkeletonDoc)
        setMarkers(mk as MapMarkersDoc)
        setQzDoc(qz as QuestZonesDoc)
      })
      .catch((e) => setLoadErr(String(e)))
  }, [])

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
  // keepAlive 适配：页面隐藏（display:none）时容器尺寸为 0，需记录可见状态并在切回时重算
  const pageRef = useRef(page)
  pageRef.current = page
  const rawBoundsRef = useRef<L.LatLngBounds | null>(null)

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
          const groups: { id: string; isBase: boolean; keepWith: string[]; el: SVGGElement }[] = []
          for (const child of Array.from(inner.children)) {
            if (child.nodeName !== 'g') continue
            const gEl = child as SVGGElement
            if (!gEl.id) continue
            const keepWith = ((gEl.dataset['keepWithGroup'] as string) ?? '')
              .split(',')
              .filter(Boolean)
            const isBase = gEl.id === imap.svgLayer || keepWith.includes(imap.svgLayer ?? '\u0000')
            groups.push({ id: gEl.id, isBase, keepWith, el: gEl })
            gEl.classList.add(isBase ? 'base-layer' : 'hidden-layer', ...(isBase ? [] : ['overlay-layer']))
          }
          // SVG 楼层显隐（官方机制）：选中楼层时根 svg 加 off-level 压暗 base，
          // 非该楼层的 overlay-layer 组加 hidden-layer 隐藏
          const showSvgFloor = (layerName: string) => {
            outer.classList.add('off-level')
            for (const gr of groups) {
              if (gr.isBase) continue // base 保留可见（被压暗）
              const match = gr.id === layerName || gr.keepWith.includes(layerName)
              gr.el.classList.toggle('hidden-layer', !match)
            }
          }
          ;(imap.layers ?? []).forEach((lyr, i) => {
            if (lyr.tilePath) return // tile 楼层在下方统一处理
            const name = lyr.svgLayer ?? lyr.name
            floorHandles.set(i, { show: () => showSvgFloor(name), hide: () => {} })
          })
          const svgDefault: FloorHandle = {
            show: () => {
              outer.classList.remove('off-level')
              for (const gr of groups) {
                if (!gr.isBase) gr.el.classList.add('hidden-layer')
              }
            },
            hide: () => {},
          }
          defaultHandle = svgDefault
          svgDefault.show()
          // 必须 addTo：Layer 构造后元素才会真正插入 overlay-pane
          L.svgOverlay(outer, rawBounds, { interactive: false }).addTo(container)
        })
        .catch((err) => console.error('svg load failed', err))
    }

    // tile 楼层
    ;(imap.layers ?? []).forEach((lyr, i) => {
      if (!lyr.tilePath) return
      const tl = L.tileLayer(lyr.tilePath, tileOpts)
      floorHandles.set(i, {
        show: () => {
          if (!container.hasLayer(tl)) tl.addTo(container)
          defaultHandle?.hide()
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

    const groupOf = (
      list: MarkerEntry[],
      iconFile: (en: MarkerEntry) => string,
      fallback?: (en: MarkerEntry) => string,
    ): L.LayerGroup => {
      const lg = L.layerGroup()
      for (const en of list) {
        if (!en.position) continue
        const title = en.nameZh || en.name || (fallback && fallback(en)) || '未命名'
        lg.addLayer(
          L.marker(pos(en.position), { icon: makeIcon(iconFile(en)) }).bindPopup(
            popupHtml(title, [
              ...(en.faction ? [`阵营 ${en.faction}`] : []),
              ...coordMeta(en),
            ]),
          ),
        )
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
    syncFnsRef.current = [syncAll, syncExtracts]

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
      // 首次出现：缩放 + 平移聚焦到玩家；后续截图保持当前缩放、平移跟随
      const targetZoom = Math.max(
        imap.minZoom ?? 1,
        Math.min(imap.maxZoom ?? 6, 4),
      )
      if (!panOnceRef.current) {
        panOnceRef.current = true
        map.setView(ll, targetZoom, { animate: true })
      } else {
        map.setView(ll, map.getZoom(), { animate: true })
      }
    } else {
      playerMarkerRef.current.setLatLng(ll)
      const img = playerMarkerRef.current
        .getElement()
        ?.querySelector<HTMLImageElement>('img')
      if (img) img.style.transform = `rotate(${deg.toFixed(1)}deg)`
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
    for (const [tid, t] of Object.entries(qzDoc.tasks)) {
      if (!inProgressIds.has(tid)) continue // 只显示正在进行的任务
      for (const o of t.objectives ?? []) {
        if (!(o.maps ?? []).includes(imap.key)) continue // 目标与本图无关
        for (const z of o.zones ?? []) {
          if (z.nn !== imap.key) continue
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
          lg.addLayer(
            L.marker(pos(z.position), {
              icon: L.icon({
                iconUrl: `${ICON_BASE}quest_objective.png`,
                iconSize: [30, 30],
                iconAnchor: [15, 15],
                className: 'quest-obj-marker',
              }),
              zIndexOffset: 600,
            }).bindPopup(
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
  }, [qzDoc, inProgressIds, imap, chips.quests])

  /* ---------- 渲染 ---------- */

  if (loadErr) {
    return (
      <div className="h-full flex items-center justify-center text-red-400 text-[13px]">
        地图数据加载失败：{loadErr}
      </div>
    )
  }
  if (!skeleton || !markers) {
    return (
      <div className="h-full flex items-center justify-center text-muted text-[13px]">
        正在加载地图数据…
      </div>
    )
  }

  const floors = imap?.layers ?? []

  return (
    <div className="h-full flex flex-col bg-ink-900">
      {/* 工具条 */}
      <div
        className="shrink-0 flex items-center flex-wrap gap-x-3 gap-y-1 px-3 py-2 border-b border-line bg-ink-800"
        style={{ paddingLeft: 12 + topPad }}
      >
        <select
          value={selected}
          onChange={(e) => {
            setSelected(e.target.value)
            setFloorSel(-1)
          }}
          className="bg-ink-700 border border-line rounded px-2 py-[4px] text-[12px] text-[#e6edf3] outline-none cursor-pointer"
        >
          {skeleton.groups
            .filter((g) => g.maps.some((m) => m.projection === 'interactive'))
            .map((g) => (
              <option key={g.normalizedName} value={g.normalizedName}>
                {g.nameZh || g.normalizedName}
              </option>
            ))}
        </select>
        <div className="flex items-center gap-1 flex-wrap">
          {CHIP_DEFS.map((c) => (
            <button
              key={c.key}
              onClick={() => setChips((p) => ({ ...p, [c.key]: !p[c.key] }))}
              className={`px-2 py-[3px] rounded text-[11px] border ${
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
        {currentMapId && (
          <span className="text-[10.5px] text-muted" title={`游戏 location id：${currentMapId}`}>
            当前地图：{markers.nameIdFallback?.[currentMapId] ?? markers.nameIds?.[currentMapId] ?? currentMapId}
          </span>
        )}
      </div>

      {/* 地图区 */}
      <div className="relative flex-1 min-h-0">
        <div id={mapDivId} className="absolute inset-0" />
        {/* 层级切换：地图右上浮动按钮（tarkov.dev 风格，自定义非原生组件） */}
        {floors.length > 0 && (
          <div className="absolute right-3 top-3 z-[600] flex flex-col items-end gap-1.5">
            <button
              onClick={() => setFloorOpen((o) => !o)}
              title="切换地图层级"
              className="min-w-[86px] flex items-center justify-center gap-1.5 px-2.5 py-1.5 rounded border border-line bg-ink-800/95 shadow-lg text-[12px] text-[#e6edf3] hover:border-amber/70 transition-colors"
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
              {floorSel === -1 ? '主层' : floors[floorSel]?.name || '主层'}
              <span
                className="text-[9px] opacity-70 transition-transform"
                style={{ transform: floorOpen ? 'rotate(180deg)' : 'none' }}
              >
                ▼
              </span>
            </button>

            {floorOpen && (
              <div className="min-w-[110px] py-1 rounded-md border border-line bg-ink-800/95 shadow-xl backdrop-blur-sm">
                <button
                  onClick={() => {
                    setFloorSel(-1)
                    setFloorOpen(false)
                  }}
                  className={`w-full text-left px-2.5 py-1.5 text-[12px] ${
                    floorSel === -1
                      ? 'text-[#d4a174] bg-amber/10'
                      : 'text-muted hover:text-[#e6edf3] hover:bg-ink-700/60'
                  }`}
                >
                  主层
                </button>
                {floors.map((f, i) => (
                  <button
                    key={f.name}
                    onClick={() => {
                      setFloorSel(i)
                      setFloorOpen(false)
                    }}
                    className={`w-full text-left px-2.5 py-1.5 text-[12px] ${
                      floorSel === i
                        ? 'text-[#d4a174] bg-amber/10'
                        : 'text-muted hover:text-[#e6edf3] hover:bg-ink-700/60'
                    }`}
                  >
                    {f.name}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        <div className="absolute left-2 bottom-2 z-[500] px-2 py-1 rounded bg-black/60 text-[10.5px] text-[#8b949e] pointer-events-none">
          {cursorCoord ? `X ${cursorCoord.x.toFixed(1)} · Z ${cursorCoord.z.toFixed(1)}` : ''}
          {'　'}
          {shotPos
            ? `玩家 ${shotPos.position.x.toFixed(1)}, ${shotPos.position.z.toFixed(1)} · 航向 ${Math.round(
                iconRotationDeg(shotPos.rotation, 0),
              )}° · ${shotPos.timestamp}`
            : '等待截图坐标…（进入 raid 后按 F12 截图即可定位）'}
        </div>
      </div>
    </div>
  )
}
