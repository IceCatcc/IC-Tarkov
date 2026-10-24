import { useEffect, useMemo, useRef, useState } from 'react'
import type { BossMonitorPayload, BossSpawnState, MapBossesDoc } from '../types'
import { bossImage, isBossRole } from '../bossImages'
import { BTR_MAPS, BTR_STATUS, STATUS_STYLE } from '../bossStatus'
import { useStore } from '../store'

/**
 * 地图页的「战局 Boss」浮窗：内容与工具页「当前战局」一致，但压成紧凑列表，
 * 并且可以在地图容器内任意拖动位置（首次挂载贴在右上角、时钟下方）。
 *
 * 与「地图信息 → Boss 刷新率」面板完全解耦：那边只显示 tarkov.dev 上游刷新率，
 * 这边只显示本地战局监控的实时状态（预计刷新 / 已刷新 / 已死亡 / 护卫 / BTR）。
 */
export function BossMonitorMapPanel({
  monitor,
  bossDoc,
  selectedMap,
}: {
  monitor: BossMonitorPayload | null
  bossDoc: MapBossesDoc | null
  /** 地图页当前选中的地图（normalizedName），用于提示「显示的不是战局地图」 */
  selectedMap: string
}) {
  const ref = useRef<HTMLDivElement | null>(null)
  // null = 还没摆过位置，挂载后贴到容器右上角；拖动后固定为容器内坐标
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null)
  const dragRef = useRef<{ dx: number; dy: number } | null>(null)
  // 地图页 keepAlive 隐藏（display:none）时容器尺寸为 0，此时摆位置会算到左上角，
  // 所以等真正切到地图页再贴右上角
  const page = useStore((s) => s.page)

  useEffect(() => {
    if (pos || page !== 'map') return
    const el = ref.current
    const parent = el?.parentElement
    if (!el || !parent) return
    const pr = parent.getBoundingClientRect()
    if (pr.width < 80 || pr.height < 80) return
    setPos({ x: Math.max(8, pr.width - el.offsetWidth - 12), y: 62 })
  }, [pos, page])

  const mapKey = monitor?.map ?? ''

  const rows = useMemo(() => {
    const live = new Map<string, BossSpawnState>()
    for (const b of monitor?.bosses ?? []) live.set(b.role.toLowerCase(), b)
    const known = (bossDoc?.maps?.[mapKey] ?? []).map((b) => ({
      id: b.id,
      name: b.nameZh || b.name || b.id,
      chance: b.chance as number | null,
      live: live.get(b.id.toLowerCase()),
    }))
    // 日志里出现但不在本图 Boss 表里的（自定义模式 / 新 Boss）也列出来
    const extras = (monitor?.bosses ?? [])
      .filter(
        (b) => isBossRole(b.role) && !known.some((r) => r.id.toLowerCase() === b.role.toLowerCase()),
      )
      .map((b) => ({ id: b.role, name: b.role, chance: null, live: b }))
    return [...known, ...extras]
  }, [monitor, bossDoc, mapKey])

  const btr = monitor?.btr
  const btrVisible =
    !!btr &&
    (BTR_MAPS.includes(mapKey) ||
      btr.status !== 'unknown' ||
      btr.readyAt.length > 0 ||
      btr.taxiAt.length > 0)

  if (!monitor?.enabled) return null

  /* ---------------- 拖动 ---------------- */

  const onDown = (e: React.PointerEvent<HTMLDivElement>) => {
    const el = ref.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    dragRef.current = { dx: e.clientX - rect.left, dy: e.clientY - rect.top }
    e.currentTarget.setPointerCapture(e.pointerId)
    e.preventDefault()
    e.stopPropagation()
  }

  const onMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = dragRef.current
    const el = ref.current
    const parent = el?.parentElement
    if (!d || !el || !parent) return
    const pr = parent.getBoundingClientRect()
    // 夹在容器内：拖出边界会把浮窗藏到看不见的地方
    const x = Math.min(Math.max(0, e.clientX - pr.left - d.dx), Math.max(0, pr.width - el.offsetWidth))
    const y = Math.min(
      Math.max(0, e.clientY - pr.top - d.dy),
      Math.max(0, pr.height - el.offsetHeight),
    )
    setPos({ x, y })
  }

  const onUp = (e: React.PointerEvent<HTMLDivElement>) => {
    dragRef.current = null
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId)
    }
  }

  return (
    <div
      ref={ref}
      className="pointer-events-auto absolute z-[605] flex w-[224px] flex-col overflow-hidden rounded-lg border border-line bg-ink-800/85 shadow-xl shadow-black/40 backdrop-blur-sm"
      style={pos ? { left: pos.x, top: pos.y } : { right: 12, top: 62, visibility: 'hidden' }}
    >
      {/* 标题行即拖动手柄 */}
      <div
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
        title="拖动可移动面板"
        className="flex cursor-move touch-none items-center gap-1.5 border-b border-line/70 bg-ink-900/50 px-2 py-1"
      >
        <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor" className="shrink-0 text-muted/50" aria-hidden>
          <circle cx="9" cy="6" r="1.7" />
          <circle cx="15" cy="6" r="1.7" />
          <circle cx="9" cy="12" r="1.7" />
          <circle cx="15" cy="12" r="1.7" />
          <circle cx="9" cy="18" r="1.7" />
          <circle cx="15" cy="18" r="1.7" />
        </svg>
        <span className="text-[11.5px] text-[#e6edf3]">战局 Boss</span>
        <span className="ml-auto truncate text-[10.5px] text-muted/60">
          {monitor.inRaid ? monitor.mapName || mapKey : '未在战局'}
        </span>
      </div>

      {/* Boss 列表：与工具页同一份数据，压成一行一只 */}
      <div className="max-h-[38dvh] overflow-y-auto py-0.5">
        {rows.length === 0 ? (
          <div className="px-2 py-1.5 text-[10.5px] leading-relaxed text-muted/60">
            {monitor.inRaid ? '本图无固定 Boss' : monitor.diagnostic || '未检测到战局'}
          </div>
        ) : (
          rows.map((r) => {
            const st = STATUS_STYLE[r.live?.status ?? 'unknown']
            const guards =
              r.live && r.live.escortTotal > 0 && (r.live.status === 'confirmed' || r.live.status === 'dead')
                ? { total: r.live.escortTotal, alive: r.live.escortAlive }
                : null
            const pct =
              r.live?.chance != null
                ? `${Math.round(r.live.chance)}%`
                : r.chance != null
                  ? `${Math.round(r.chance * 100)}%`
                  : '—'
            const img = bossImage(r.id)
            return (
              <div
                key={r.id}
                title={`${r.name} · ${st.label} · 刷新率 ${pct}${
                  r.live?.zone ? ` · ${r.live.zone}` : ''
                }${guards ? ` · 护卫 ${guards.alive}/${guards.total}` : ''}`}
                className="flex items-center gap-1.5 px-2 py-[3px] text-[11.5px] hover:bg-ink-700/50"
              >
                {img ? (
                  <img
                    src={img}
                    alt=""
                    draggable={false}
                    className="h-[15px] w-[15px] shrink-0 rounded-full bg-ink-700/60 object-cover"
                  />
                ) : (
                  <span className="h-[15px] w-[15px] shrink-0 rounded-full bg-ink-700/60" />
                )}
                <span className="min-w-0 flex-1 truncate text-[#c9d1d9]">{r.name}</span>
                {guards && (
                  <span
                    className={`shrink-0 tabular-nums text-[10px] ${
                      guards.alive > 0 ? 'text-[#7ee787]' : 'text-muted/50'
                    }`}
                  >
                    {guards.alive}/{guards.total}
                  </span>
                )}
                {r.live && r.live.count > 1 && (
                  <span className="shrink-0 text-[10px] text-muted/50">×{r.live.count}</span>
                )}
                <span className="shrink-0 tabular-nums text-[10px] text-muted/55">{pct}</span>
                <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${st.dot}`} />
                <span className={`w-[26px] shrink-0 text-[10px] ${st.text}`}>{st.short}</span>
              </div>
            )
          })
        )}

        {/* BTR 单独一行（不在 Boss 表里） */}
        {btrVisible && btr && (
          <div
            title={`BTR · ${BTR_STATUS[btr.status].label}${
              btr.readyAt.length ? ` · 发车信号 ${btr.readyAt.length} 次` : ''
            }${btr.taxiAt.length ? ` · 购车 ${btr.taxiAt.length} 次` : ''}`}
            className="mt-0.5 flex items-center gap-1.5 border-t border-line/40 px-2 py-[3px] text-[11.5px]"
          >
            <span className="grid h-[15px] w-[15px] shrink-0 place-items-center rounded bg-[#1f6feb]/25 text-[8px] font-semibold text-[#7cb9ff]">
              BTR
            </span>
            <span className="min-w-0 flex-1 truncate text-[#c9d1d9]">BTR 装甲车</span>
            {(btr.taxiAt.length > 0 || btr.readyAt.length > 0) && (
              <span className="shrink-0 text-[9.5px] text-muted/55">
                {btr.readyAt.length > 0 ? `发车 ${btr.readyAt.length}` : ''}
                {btr.readyAt.length > 0 && btr.taxiAt.length > 0 ? ' · ' : ''}
                {btr.taxiAt.length > 0 ? `购车 ${btr.taxiAt.length}` : ''}
              </span>
            )}
            <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${BTR_STATUS[btr.status].dot}`} />
            <span className={`w-[26px] shrink-0 text-[10px] ${BTR_STATUS[btr.status].text}`}>
              {BTR_STATUS[btr.status].short}
            </span>
          </div>
        )}
      </div>

      {/* 正在看别的地图时给一句提示，免得以为数据没更新 */}
      {monitor.map && selectedMap && monitor.map !== selectedMap && (
        <div className="border-t border-line/40 px-2 py-1 text-[10px] text-amber/70">
          当前显示的不是战局地图
        </div>
      )}
    </div>
  )
}
