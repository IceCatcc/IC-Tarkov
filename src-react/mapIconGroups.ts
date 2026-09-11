/**
 * 地图图标的「分类 / 子分类」派生（供图层构建与「图标」筛选面板共用）。
 *
 * 结构参考 tarkov.dev 的地图筛选：先按大类（撤离点、出生点、容器、危险区…）分组，
 * 大类下再按数据本身可区分的维度细分（撤离点按阵营、容器按容器类型、锁按名称…），
 * 每个子分类都可单独控制显示隐藏。
 *
 * 这里只负责「怎么分组 / 用什么图标 / 显示什么名字」，渲染细节（弹窗、永久标签、层级）
 * 由 MapPage 在拿到结果后附加。
 */

import type { MarkerEntry } from './types'

/** 当前地图的标记集合（后端 `markers.maps[mapKey]`） */
export type MapMarkers = Record<string, MarkerEntry[]>

/* ---------------- 图标文件名（与 public/maps/interactive 下的文件对应） ---------------- */

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

/**
 * 是否为狙击 AI 出生点。
 *
 * 数据里狙击点有两种形态，必须都覆盖，否则会被当成普通 AI：
 * 1. categories 里带 sniper / sniper_scav 之类的标记（仅少部分地图）；
 * 2. 绝大部分点的 categories 只有 ["bot"]，与普通 AI 完全一样，只能靠 zoneName 区分
 *    （海关 ZoneSnipeTower / ZoneBlockPostSniper、中心区 Zone_SniperPeak…）。
 */
export function isSniper(en: MarkerEntry): boolean {
  if ((en.categories ?? []).some((c) => /snipe/i.test(c))) return true
  return /snip/i.test(en.zoneName ?? '')
}

const spawnIcon = (en: MarkerEntry): string => {
  for (const c of en.categories ?? []) if (SPAWN_ICON[c]) return SPAWN_ICON[c]
  return 'spawn_scav'
}
const extractIcon = (en: MarkerEntry): string =>
  EXTRACT_ICON[(en.faction ?? '').toLowerCase()] ?? 'extract_shared'
const containerIcon = (en: MarkerEntry): string =>
  en.icon && CONTAINER_ICONS.has(en.icon) ? `container_${en.icon}` : DEFAULT_CONTAINER_ICON
const hazardIcon = (en: MarkerEntry): string => (en.kind === 'mortar' ? 'hazard_mortar' : 'hazard')

/* ---------------- 分类 / 子分类 ---------------- */

/** 子分类（可单独开关的最小单位） */
export interface IconSub {
  /** 完整 key：`分类:子分类`（如 `extracts:pmc`、`containers:weapon-box`） */
  key: string
  label: string
  list: MarkerEntry[]
  /** 图标文件名（不含目录与扩展名） */
  icon: (en: MarkerEntry) => string
  /** 无名称时的兜底标题 */
  name?: (en: MarkerEntry) => string
  /** 弹窗里的补充信息行（撤离点塞撤离要求） */
  meta?: (en: MarkerEntry) => string[]
  /** 永久标签（撤离点上直接显示名称） */
  tooltip?: (en: MarkerEntry) => HTMLElement | null
  /** 图层层级（撤离点按阵营分层） */
  zIndex?: (en: MarkerEntry) => number
  /** 图标高亮样式（红圈 = 狙击 AI） */
  highlight?: 'red'
  /** 面板里不单独列出（如共用撤离点：跟随 PMC / Scav 任一勾选） */
  hidden?: boolean
  /** 同分类下的子项 key 后缀：其中任一开启时本子项就显示（hidden 项用） */
  follow?: string[]
}

/** 分类（可整体开关，展开后逐个子项控制） */
export interface IconGroup {
  key: string
  label: string
  subs: IconSub[]
}

const EXTRACT_LABEL: Record<string, string> = {
  pmc: 'PMC 撤离点',
  scav: 'Scav 撤离点',
  shared: '共用撤离点',
  transit: '过境撤离点',
}
const SPAWN_LABEL: Record<string, string> = {
  player: '玩家出生点',
  ai: 'AI 出生点',
  sniper: '狙击 AI 出生点',
  boss: 'Boss 出生点',
}
const HAZARD_LABEL: Record<string, string> = {
  mortar: '迫击炮覆盖区',
  sniper: '狙击手',
  mine: '地雷区',
}

function groupBy(list: MarkerEntry[], keyFn: (en: MarkerEntry) => string) {
  const m = new Map<string, MarkerEntry[]>()
  for (const en of list) {
    const k = keyFn(en)
    const arr = m.get(k)
    if (arr) arr.push(en)
    else m.set(k, [en])
  }
  return m
}

const byLabel = (a: { label: string }, b: { label: string }) => a.label.localeCompare(b.label, 'zh')

export function buildIconGroups(mm: MapMarkers): IconGroup[] {
  const groups: IconGroup[] = []
  const push = (key: string, label: string, subs: IconSub[]) => {
    if (subs.length) groups.push({ key, label, subs })
  }

  // 撤离点：PMC / Scav 各自独立；共用 / 过境点不单独给选项，
  // 跟随「PMC 或 Scav 任一勾选」显示（面板里通过 hidden 隐藏该行）
  const extracts = groupBy(mm.extracts ?? [], (en) => (en.faction ?? 'shared').toLowerCase())
  const extractSubs: IconSub[] = []
  for (const fac of ['pmc', 'scav'] as const) {
    const list = extracts.get(fac)
    if (list?.length) {
      extractSubs.push({
        key: `extracts:${fac}`,
        label: EXTRACT_LABEL[fac],
        list,
        icon: extractIcon,
      })
    }
  }
  // 其余阵营（shared / transit 及任何未知值）归为「共用 / 过境撤离点」
  const shared = [...extracts.entries()]
    .filter(([fac]) => fac !== 'pmc' && fac !== 'scav')
    .flatMap(([, list]) => list)
  if (shared.length) {
    extractSubs.push({
      key: 'extracts:shared',
      label: '共用 / 过境撤离点',
      list: shared,
      icon: extractIcon,
      hidden: true,
      follow: ['pmc', 'scav'],
    })
  }
  push('extracts', '撤离点', extractSubs)

  // 出生点：玩家 / 普通 AI / 狙击 AI / Boss（Boss 数据分散在 bosses 与 spawns 两处）
  const spawns = mm.spawns ?? []
  const isBoss = (s: MarkerEntry) => (s.categories ?? []).includes('boss')
  const isPlayer = (s: MarkerEntry) => (s.categories ?? []).includes('player')
  // 四类互斥（Boss > 玩家 > 狙击 AI > 普通 AI）：少数点同时带 sniper 与 boss/player 标记，
  // 归入优先级更高的一类，否则同一坐标会在两个图层里各画一个图标。
  const player = spawns.filter((s) => !isBoss(s) && isPlayer(s))
  const sniper = spawns.filter((s) => isSniper(s) && !isBoss(s) && !isPlayer(s))
  const ai = spawns.filter((s) => !isBoss(s) && !isPlayer(s) && !isSniper(s))
  const boss = [...(mm.bosses ?? []), ...spawns.filter(isBoss)]
  push(
    'spawns',
    '出生点',
    (
      [
        ['player', player, spawnIcon, undefined],
        ['ai', ai, spawnIcon, undefined],
        ['sniper', sniper, () => 'spawn_sniper_scav', 'red' as const],
        ['boss', boss, () => 'spawn_boss', undefined],
      ] as [string, MarkerEntry[], (en: MarkerEntry) => string, 'red' | undefined][]
    )
      .filter(([, list]) => list.length)
      .map(([sub, list, iconFn, highlight]) => ({
        key: `spawns:${sub}`,
        label: SPAWN_LABEL[sub] ?? sub,
        list,
        icon: iconFn,
        // 数据在这些点上没有名称，给固定中文名
        name: () => SPAWN_LABEL[sub] ?? sub,
        highlight,
      })),
  )

  // 危险区：按 kind（迫击炮 / 狙击手 / 地雷…）
  const hazards = groupBy(mm.hazards ?? [], (en) => en.kind ?? 'other')
  push(
    'hazards',
    '危险区',
    [...hazards.entries()]
      .map(([kind, list]) => ({
        key: `hazards:${kind}`,
        label: HAZARD_LABEL[kind] ?? (kind === 'other' ? '其他危险区' : `危险区·${kind}`),
        list,
        icon: hazardIcon,
      }))
      .sort(byLabel),
  )

  // 容器：按容器类型（名称取该类型的中文名，取不到退回类型 key）
  const containers = groupBy(mm.lootContainers ?? [], (en) => en.icon ?? 'other')
  push(
    'containers',
    '容器',
    [...containers.entries()]
      .map(([icon, list]) => ({
        key: `containers:${icon}`,
        label: list[0]?.nameZh || list[0]?.name || icon,
        list,
        icon: containerIcon,
      }))
      .sort(byLabel),
  )

  // 钥匙锁：同名锁归为一组（同一把钥匙的多个门）
  const locks = groupBy(mm.locks ?? [], (en) => en.nameZh || en.name || '未命名')
  push(
    'locks',
    '钥匙锁',
    [...locks.entries()]
      .map(([nm, list]) => ({ key: `locks:${nm}`, label: nm, list, icon: () => 'lock' }))
      .sort(byLabel),
  )

  // 数量少、无需再细分的集合：整类作为一个子项
  const simple = (key: string, label: string, list: MarkerEntry[], icon: string) =>
    push(key, label, [{ key: `${key}:all`, label: '全部', list, icon: () => icon }])
  simple('switches', '开关 / 拉杆', mm.switches ?? [], 'switch')
  simple('weapons', '固定武器', mm.stationaryWeapons ?? [], 'stationarygun')
  simple('btr', 'BTR 站点', mm.btrStops ?? [], 'btr_stop')

  return groups
}

/* ---------------- 开关（chips）键与默认值 ---------------- */

/** 存储键：分类 `cat:<分类>`，子分类 `sub:<分类>:<子分类>` */
export const catKey = (cat: string) => `cat:${cat}`
export const subKey = (sub: string) => `sub:${sub}`

/** 默认显隐：未显式设置的子项继承所属分类 */
export const ICON_DEFAULTS: Record<string, boolean> = {
  'cat:quests': true,
  'cat:extracts': true,
  'cat:spawns': true,
  'cat:hazards': false,
  'cat:containers': false,
  'cat:locks': false,
  'cat:switches': false,
  'cat:weapons': false,
  'cat:btr': false,
  'sub:extracts:pmc': true,
  'sub:extracts:scav': true,
  'sub:extracts:shared': true,
  'sub:extracts:transit': true,
  'sub:spawns:player': false,
  'sub:spawns:ai': false,
  'sub:spawns:sniper': false,
  'sub:spawns:boss': true,
}

/** 解析开关状态：显式值 > 子项默认 > 所属分类默认 > false */
export function resolveChipOn(chips: Record<string, boolean>, key: string): boolean {
  const v = chips[key]
  if (typeof v === 'boolean') return v
  const d = ICON_DEFAULTS[key]
  if (typeof d === 'boolean') return d
  if (key.startsWith('sub:')) {
    const cat = key.split(':')[1]
    return ICON_DEFAULTS[catKey(cat)] ?? false
  }
  return false
}

/** 旧版扁平键 -> 新版键（旧设置一次性迁移用） */
const LEGACY_CHIP_MAP: Record<string, string> = {
  quests: catKey('quests'),
  extract_pmc: subKey('extracts:pmc'),
  extract_scav: subKey('extracts:scav'),
  player_spawns: subKey('spawns:player'),
  ai_spawns: subKey('spawns:ai'),
  sniper_spawns: subKey('spawns:sniper'),
  bosses: subKey('spawns:boss'),
  locks: catKey('locks'),
  hazards: catKey('hazards'),
  containers: catKey('containers'),
}

/** 把旧版 chips 迁移到新键（未知键丢弃，避免污染） */
export function migrateChips(chips: Record<string, boolean>): Record<string, boolean> {
  const out: Record<string, boolean> = {}
  for (const [k, v] of Object.entries(chips)) {
    if (typeof v !== 'boolean') continue
    if (k.startsWith('cat:') || k.startsWith('sub:')) {
      out[k] = v
      continue
    }
    const nk = LEGACY_CHIP_MAP[k]
    if (nk) out[nk] = v
  }
  return out
}
