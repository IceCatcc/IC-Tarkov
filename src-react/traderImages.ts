// 自动生成：按商人 ID 映射头像（来源 assets.tarkov.dev）
import img0 from './assets/traders/54cb50c76803fa8b248b4571.webp'
import img1 from './assets/traders/54cb57776803fa99248b456e.webp'
import img2 from './assets/traders/579dc571d53a0658a154fbec.webp'
import img3 from './assets/traders/58330581ace78e27b8b10cee.webp'
import img4 from './assets/traders/5935c25fb3acc3127c3d8cd9.webp'
import img5 from './assets/traders/5a7c2eca46aef81a7ca2145d.webp'
import img6 from './assets/traders/5ac3b934156ae10c4430e83c.webp'
import img7 from './assets/traders/5c0647fdd443bc2504c2d371.webp'
import img8 from './assets/traders/638f541a29ffd1183d187f57.webp'
import img9 from './assets/traders/656f0f98d80a697f855d34b1.webp'
import img10 from './assets/traders/6617beeaa9cfa777ca915b7c.webp'
import img11 from './assets/traders/688246518448b05efd61d461.webp'
import img12 from './assets/traders/688246958448b05efd61d462.webp'
import img13 from './assets/traders/68fe15910f29ba3fdbba9d54.webp'
import img14 from './assets/traders/68fe15990f29ba3fdbba9d55.webp'
import img15 from './assets/traders/69e0d6cc77b63940375b9173.webp'

const BY_ID: Record<string, string> = {
  '54cb50c76803fa8b248b4571': img0, // prapor
  '54cb57776803fa99248b456e': img1, // therapist
  '579dc571d53a0658a154fbec': img2, // fence
  '58330581ace78e27b8b10cee': img3, // skier
  '5935c25fb3acc3127c3d8cd9': img4, // peacekeeper
  '5a7c2eca46aef81a7ca2145d': img5, // mechanic
  '5ac3b934156ae10c4430e83c': img6, // ragman
  '5c0647fdd443bc2504c2d371': img7, // jaeger
  '638f541a29ffd1183d187f57': img8, // lightkeeper
  '656f0f98d80a697f855d34b1': img9, // btr-driver
  '6617beeaa9cfa777ca915b7c': img10, // ref
  '688246518448b05efd61d461': img11, // mr-kerman
  '688246958448b05efd61d462': img12, // voevoda
  '68fe15910f29ba3fdbba9d54': img13, // taran
  '68fe15990f29ba3fdbba9d55': img14, // radio-station
  '69e0d6cc77b63940375b9173': img15, // survivor
}

export function traderImage(traderId?: string | null): string | null {
  if (!traderId) return null
  return BY_ID[traderId] ?? null
}
