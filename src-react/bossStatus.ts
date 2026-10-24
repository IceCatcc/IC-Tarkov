import type { BossSpawnState } from './types'

/**
 * Boss / BTR 状态徽标的统一样式表（工具页「战局 Boss 监控」与地图页浮窗共用）。
 *
 * - `label`：完整文案（工具页徽标）
 * - `short`：地图页浮窗用的紧凑文案
 * - `cls`：带描边 + 底色的徽标样式
 * - `text`：只有文字色（紧凑行用）
 * - `dot`：状态点
 */
export type SpawnStatus = BossSpawnState['status']

export interface StatusStyle {
  label: string
  short: string
  cls: string
  text: string
  dot: string
}

export const STATUS_STYLE: Record<SpawnStatus, StatusStyle> = {
  confirmed: {
    label: '已刷新',
    short: '已刷',
    cls: 'border-[#3fb950]/45 bg-[#3fb950]/10 text-[#3fb950]',
    text: 'text-[#3fb950]',
    dot: 'bg-[#3fb950] shadow-[0_0_6px_#3fb950]',
  },
  planned: {
    label: '预计刷新',
    short: '预计',
    cls: 'border-amber/45 bg-amber/10 text-[#d4a174]',
    text: 'text-[#d4a174]',
    dot: 'bg-amber shadow-[0_0_6px_rgba(239,159,39,.9)]',
  },
  not_planned: {
    label: '本局不刷',
    short: '不刷',
    cls: 'border-line bg-ink-700/60 text-muted',
    text: 'text-muted/70',
    dot: 'bg-muted/60',
  },
  dead: {
    label: '已确认死亡',
    short: '死亡',
    cls: 'border-line/70 bg-ink-700/30 text-muted/70',
    text: 'text-muted/60',
    dot: 'bg-muted/40',
  },
  unknown: {
    label: '未检测',
    short: '未知',
    cls: 'border-line/60 bg-transparent text-muted/60',
    text: 'text-muted/50',
    dot: 'bg-muted/30',
  },
}

/** 有 BTR 的地图（normalizedName） */
export const BTR_MAPS = ['woods', 'streets-of-tarkov', 'lighthouse']

/** BTR 的状态文案（与 Boss 共用样式，但「已刷新」对装甲车读起来别扭） */
export const BTR_STATUS: Record<SpawnStatus, StatusStyle> = {
  confirmed: { ...STATUS_STYLE.confirmed, label: '已出现', short: '已出现' },
  planned: { ...STATUS_STYLE.planned, label: '预计出现', short: '预计' },
  not_planned: { ...STATUS_STYLE.not_planned, label: '本局不刷', short: '不刷' },
  dead: { ...STATUS_STYLE.dead, label: '已离场 / 被毁', short: '离场' },
  unknown: { ...STATUS_STYLE.unknown, label: '未检测', short: '未知' },
}
