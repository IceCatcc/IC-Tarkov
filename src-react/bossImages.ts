import img0 from './assets/bosses/bossTagilla.png'
import img1 from './assets/bosses/bossBully.webp'
import img2 from './assets/bosses/bossKnight.png'
import img3 from './assets/bosses/bossPartisan.png'
import img4 from './assets/bosses/sectantPriest.webp'
import img5 from './assets/bosses/bossKojaniy.png'
import img6 from './assets/bosses/bossZryachiy.png'
import img7 from './assets/bosses/ExUsec.webp'
import img8 from './assets/bosses/bossSanitar.png'
import img9 from './assets/bosses/Sentry.webp'
import img10 from './assets/bosses/bossGluhar.png'
import img11 from './assets/bosses/PmcBot.webp'
import img12 from './assets/bosses/bossKilla.png'
import img13 from './assets/bosses/bossBoar.png'
import img14 from './assets/bosses/bossKolontay.png'
import img15 from './assets/bosses/blackDivision.webp'
import img16 from './assets/bosses/vsRFSniper.webp'
import img17 from './assets/bosses/vsRF.webp'
import img18 from './assets/bosses/bossTagillaAgro.webp'
import img19 from './assets/bosses/bossBullyBlackDiv.webp'
import img20 from './assets/bosses/pmcBotBlackDiv.webp'
import img21 from './assets/bosses/bossWedge.webp'
import img22 from './assets/bosses/bossWedgeLab.webp'

const BY_ID: Record<string, string> = {
  "bossTagilla": img0,
  "bossBully": img1,
  "bossKnight": img2,
  "bossPartisan": img3,
  "sectantPriest": img4,
  "bossKojaniy": img5,
  "bossZryachiy": img6,
  "ExUsec": img7,
  "bossSanitar": img8,
  "Sentry": img9,
  "bossGluhar": img10,
  "PmcBot": img11,
  "bossKilla": img12,
  "bossBoar": img13,
  "bossKolontay": img14,
  "blackDivision": img15,
  "vsRFSniper": img16,
  "vsRF": img17,
  "bossTagillaAgro": img18,
  "bossBullyBlackDiv": img19,
  "pmcBotBlackDiv": img20,
  "bossWedge": img21,
  "bossWedgeLab": img22,
}

export function bossImage(id?: string | null): string | null {
  if (!id) return null
  return BY_ID[id] ?? null
}

/**
 * 日志角色名不带 `boss` 前缀、但确实是 Boss 的少数例外。
 * - `sectantPriest`：邪教徒祭司
 * - `blackDivision`：黑色守望（事件 Boss）
 */
const NON_PREFIX_BOSSES = new Set(['sectantpriest', 'blackdivision'])

/**
 * 是否是真 Boss 的日志角色。
 *
 * aiData 日志里除了 Boss，还会出现 pmcBEAR / pmcUSEC / assault / marksman /
 * follower* / shooterBTR 等普通 AI；地图绘制只认 Boss。
 * EFT 里 Boss 的角色名绝大多数以 `boss` 开头（bossKilla / bossKnight / bossTagilla …），
 * 邪教徒祭司等个别例外列在 `NON_PREFIX_BOSSES`，其余一律不算。
 */
export function isBossRole(role?: string | null): boolean {
  if (!role) return false
  const lower = role.toLowerCase()
  return lower.startsWith('boss') || NON_PREFIX_BOSSES.has(lower)
}
