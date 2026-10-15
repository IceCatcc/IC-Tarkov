/**
 * 商人头像：商人 ID → `trader-icons/<商人id>.webp`。
 *
 * 图片随包分发（完整版）或首次启动下载（lite 版），运行期也可能被「更新图片资源」
 * 拉到数据目录 —— 这里只存相对路径，实际 URL 由 assetUrl() 决定
 * （优先运行时资源，缺失时回退随包资源）。
 *
 * 上游来源：https://assets.tarkov.dev/{商人id}.webp
 */
import { assetUrl } from './assetUrl'

/** 已知商人（供查阅；取图不依赖该表，上游新增商人时无需改代码） */
export const TRADER_IDS: readonly string[] = [
  '54cb50c76803fa8b248b4571', // prapor
  '54cb57776803fa99248b456e', // therapist
  '579dc571d53a0658a154fbec', // fence
  '58330581ace78e27b8b10cee', // skier
  '5935c25fb3acc3127c3d8cd9', // peacekeeper
  '5a7c2eca46aef81a7ca2145d', // mechanic
  '5ac3b934156ae10c4430e83c', // ragman
  '5c0647fdd443bc2504c2d371', // jaeger
  '638f541a29ffd1183d187f57', // lightkeeper
  '656f0f98d80a697f855d34b1', // btr-driver
  '6617beeaa9cfa777ca915b7c', // ref
  '688246518448b05efd61d461', // mr-kerman
  '688246958448b05efd61d462', // voevoda
  '68fe15910f29ba3fdbba9d54', // taran
  '68fe15990f29ba3fdbba9d55', // radio-station
  '69e0d6cc77b63940375b9173', // survivor
]

export function traderImage(traderId?: string | null): string | null {
  if (!traderId) return null
  return assetUrl(`trader-icons/${traderId}.webp`)
}
