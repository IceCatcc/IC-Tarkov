/**
 * Boss 头像：Boss 内部名 → `boss-icons/<名称>.<png|webp>`。
 *
 * 图片随包分发（完整版）或首次启动下载（lite 版），运行期也可能被「更新数据」
 * 拉到数据目录 —— 这里只存相对路径，实际 URL 由 assetUrl() 决定。
 *
 * 与商人头像不同，上游没有统一的「按 id 取图」地址，且历史资源里 png / webp
 * 混用，因此这里保留一份「内部名 → 文件名」白名单（表外的 id 不显示头像）。
 */
import { assetUrl } from './assetUrl'

/** Boss 内部名 → boss-icons 下的文件名 */
const FILES: Record<string, string> = {
  bossTagilla: 'bossTagilla.png',
  bossBully: 'bossBully.webp',
  bossKnight: 'bossKnight.png',
  bossPartisan: 'bossPartisan.png',
  sectantPriest: 'sectantPriest.webp',
  bossKojaniy: 'bossKojaniy.png',
  bossZryachiy: 'bossZryachiy.png',
  ExUsec: 'ExUsec.webp',
  bossSanitar: 'bossSanitar.png',
  Sentry: 'Sentry.webp',
  bossGluhar: 'bossGluhar.png',
  PmcBot: 'PmcBot.webp',
  bossKilla: 'bossKilla.png',
  bossBoar: 'bossBoar.png',
  bossKolontay: 'bossKolontay.png',
  blackDivision: 'blackDivision.webp',
  vsRFSniper: 'vsRFSniper.webp',
  vsRF: 'vsRF.webp',
  bossTagillaAgro: 'bossTagillaAgro.webp',
  bossBullyBlackDiv: 'bossBullyBlackDiv.webp',
  pmcBotBlackDiv: 'pmcBotBlackDiv.webp',
  bossWedge: 'bossWedge.webp',
  bossWedgeLab: 'bossWedgeLab.webp',
}

export function bossImage(id?: string | null): string | null {
  if (!id) return null
  const file = FILES[id]
  return file ? assetUrl(`boss-icons/${file}`) : null
}
