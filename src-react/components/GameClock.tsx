import { useEffect, useState } from 'react'
import { useStore } from '../store'

/**
 * 塔科夫游戏内时间（并入地图页右下角「地图信息」面板）。
 *
 * 算法（纯本地计算，不依赖任何后端接口）：
 *   游戏时间 = (UTC 秒数 × 7 + 偏移量) % 86400
 * 即游戏内时间流速为现实的 7 倍，并带 +3 小时偏移；
 * 另有一套相差 12 小时的时间（游戏时间 + 12h），一并展示。
 * 1000 / 7 ≈ 143ms 一跳，游戏秒逐秒跳动。
 */

const GAME_SPEED = 7
/** 偏移量（秒）：+3 小时 */
const GAME_OFFSET_SEC = 3 * 3600
const DAY_SEC = 24 * 3600
/** 现实 1 秒 = 游戏 7 秒，143ms 一跳让游戏秒逐秒 +1 */
const TICK_MS = 143

const pad = (n: number) => String(n).padStart(2, '0')

/** 总秒数 -> HH:MM:SS */
function fmtHMS(totalSec: number): string {
  const t = Math.floor(totalSec)
  return `${pad(Math.floor(t / 3600))}:${pad(Math.floor((t % 3600) / 60))}:${pad(t % 60)}`
}

/** UTC 秒数（含毫秒小数） */
function utcSecOf(d: Date): number {
  return d.getUTCHours() * 3600 + d.getUTCMinutes() * 60 + d.getUTCSeconds() + d.getUTCMilliseconds() / 1000
}

/** 当前游戏时间（秒，0–86400） */
function gameTimeSec(d: Date): number {
  return (utcSecOf(d) * GAME_SPEED + GAME_OFFSET_SEC) % DAY_SEC
}

export function GameClock() {
  // keepAlive：地图页隐藏（display:none）时停表，切回立即刷新一次
  const visible = useStore((s) => s.page === 'map')
  const [now, setNow] = useState(() => new Date())

  useEffect(() => {
    if (!visible) return
    setNow(new Date())
    const t = window.setInterval(() => setNow(new Date()), TICK_MS)
    return () => window.clearInterval(t)
  }, [visible])

  const g1 = gameTimeSec(now)
  const g2 = (g1 + DAY_SEC / 2) % DAY_SEC

  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between gap-2 text-[14px]">
        <span className="text-[13px] text-muted">游戏时间</span>
        <span className="shrink-0 tabular-nums text-amber">{fmtHMS(g1)}</span>
      </div>
      <div className="flex items-center justify-end gap-2 text-[14px]">
        <span className="shrink-0 tabular-nums text-amber">{fmtHMS(g2)}</span>
      </div>
    </div>
  )
}
