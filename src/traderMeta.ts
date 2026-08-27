// 商人静态元数据（id 来自 json.tarkov.dev）
export interface TraderMeta {
  id: string
  /** 后台识别用名称 */
  name: string
  /** 界面展示中文名 */
  zh: string
  /** 特殊商人（Fence/灯塔守护者等，非普通装备商） */
  special?: boolean
  /** 解锁该商人的前置任务 id（其全部任务对该任务存在隐性右移依赖） */
  unlockQuestId?: string
}

/** Jaeger 由机械师「介绍」(5d2495a8...) 解锁；Lightkeeper 为隐藏长链，暂无单任务映射 */
export const TRADERS: TraderMeta[] = [
  { id: '54cb50c76803fa8b248b4571', name: 'Praper', zh: '普拉珀' },
  { id: '54cb57776803fa99248b456e', name: 'Therapist', zh: '医师' },
  { id: '58330581ace78e27b8b10cee', name: 'Skier', zh: '滑雪佬' },
  { id: '5935c25fb3acc3127c3d8cd9', name: 'Peacekeeper', zh: '和事佬' },
  { id: '5a7c2eca46aef81a7ca2145d', name: 'Mechanic', zh: '机械师' },
  { id: '5ac3b934156ae10c4430e83c', name: 'Ragman', zh: '拾荒者' },
  { id: '5c0647fdd443bc2504c2d371', name: 'Jaeger', zh: '猎人', unlockQuestId: '5d2495a886f77425cd51e403' },
  { id: '579dc571d53a0658a154fbec', name: 'Fence', zh: '绿商', special: true },
  { id: '638f541a29ffd1183d187f57', name: 'Lightkeeper', zh: '灯塔守望者', special: true },
  { id: '656f0f98d80a697f855d34b1', name: 'BTR Driver', zh: 'BTR司机', special: true },
  { id: '6617beeaa9cfa777ca915b7c', name: 'Arena Ref', zh: '竞技场裁判', special: true },
]

/** traderId -> 解锁任务 id */
export const TRADER_UNLOCK_QUEST: Record<string, string> = Object.fromEntries(
  TRADERS.filter((t) => t.unlockQuestId).map((t) => [t.id, t.unlockQuestId!]),
)

/** traderId -> 中文名（头像条/泳道等界面展示用） */
export const TRADER_ZH: Record<string, string> = Object.fromEntries(
  TRADERS.map((t) => [t.id, t.zh]),
)

/** 界面展示名：优先中文映射，未知商人回退原名 */
export function traderDisplayName(traderId: string, fallbackName?: string): string {
  return TRADER_ZH[traderId] ?? fallbackName ?? traderId
}

export function traderMetaName(id: string): string | undefined {
  return TRADERS.find((t) => t.id === id)?.name
}
