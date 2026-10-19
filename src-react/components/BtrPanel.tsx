import { useEffect, useMemo, useRef, useState } from 'react'
import { fmtClock, btrColor, btrSnapshot, type BtrMapData, type BtrRoute } from '../btr'
import type { RaidStatePayload } from '../types'

/** 面板上报给地图图层的最小状态：图层只认「当前剩余秒数 + 筛选」，不参与 React 渲染 */
export interface BtrLayerState {
  remain: number | null
  filter: string
}

interface Props {
  map: BtrMapData
  /** 后端检测到的战局状态（web 端恒为 null） */
  raid: RaidStatePayload | null
  /** 战局是否就在当前查看的这张地图里（决定自动计时是否生效） */
  raidHere: boolean
  /** 路线筛选：'all' / 分组 key / 'route:<id>' */
  filter: string
  onFilter: (f: string) => void
  onState: (s: BtrLayerState) => void
  /** 面板是否展开；收起时组件继续挂载（计时与地图绘制不中断） */
  visible: boolean
  /** 收起面板（只隐藏 UI，继续跟踪） */
  onClose: () => void
  /** 停止跟踪：结束计时并移除地图上的路线 / 车辆 */
  onStop: () => void
}

/** 日志时间戳（本地时间 `YYYY-MM-DD HH:mm:ss`）-> 毫秒 */
function parseTs(ts: string | null | undefined): number | null {
  if (!ts) return null
  const m = ts.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/)
  if (!m) return null
  const d = new Date(
    Number(m[1]),
    Number(m[2]) - 1,
    Number(m[3]),
    Number(m[4]),
    Number(m[5]),
    Number(m[6]),
  )
  return Number.isFinite(d.getTime()) ? d.getTime() : null
}

/** 参考站的快捷时间点：战局剩余时间预设（秒） */
function quickTimes(raidDuration: number): number[] {
  return [raidDuration, 1800, 1500, 1200, 900, 600, 300, 60]
    .filter((v, i, a) => v > 0 && v <= raidDuration && a.indexOf(v) === i)
    .sort((a, b) => b - a)
}

export function BtrPanel({
  map,
  raid,
  raidHere,
  filter,
  onFilter,
  onState,
  visible,
  onClose,
  onStop,
}: Props) {
  // 时钟：auto = 跟随进图时间；manual = 用户暂停 / 跳转后本地倒计时
  const [manual, setManual] = useState<{
    base: number
    at: number
    running: boolean
  } | null>(null)
  const [nowMs, setNowMs] = useState(() => Date.now())
  const [inputMin, setInputMin] = useState('')
  const [inputSec, setInputSec] = useState('')

  useEffect(() => {
    const t = window.setInterval(() => setNowMs(Date.now()), 500)
    return () => window.clearInterval(t)
  }, [])

  // 检测到新一局（进图时间变化）：丢掉上一局的手动跳转，回到跟随进图时间
  const startedAt = raid?.startedAt ?? null
  const lastStartRef = useRef(startedAt)
  useEffect(() => {
    if (lastStartRef.current === startedAt) return
    lastStartRef.current = startedAt
    if (startedAt) setManual(null)
  }, [startedAt])

  /** 自动模式：战局剩余 = 时长 - (now - 进图时间)；出图后冻结在出图时刻 */
  const autoRemain = useMemo(() => {
    if (!raid || !raidHere) return null
    const start = parseTs(raid.startedAt)
    if (start == null) return null
    // 已出图但没有出图时间（数据缺失）：不猜，交给手动模式
    if (!raid.active && !raid.endedAt) return null
    const end = raid.active ? null : parseTs(raid.endedAt)
    const at = end ?? nowMs
    return map.raidDuration - (at - start) / 1000
  }, [raid, raidHere, nowMs, map.raidDuration])

  const rawRemain = manual
    ? manual.running
      ? manual.base - (nowMs - manual.at) / 1000
      : manual.base
    : autoRemain
  const remain = rawRemain == null ? null : Math.max(0, Math.min(map.raidDuration, rawRemain))
  const ended = remain != null && remain <= 0

  const routes = useMemo(
    () =>
      map.routes.filter(
        (r) => filter === 'all' || r.group === filter || filter === `route:${r.id}`,
      ),
    [map.routes, filter],
  )

  // 上报给地图图层（每 0.5s 一次；父组件只更新 Leaflet 图层，不 setState）
  const onStateRef = useRef(onState)
  onStateRef.current = onState
  useEffect(() => {
    onStateRef.current({ remain, filter })
  }, [remain, filter])

  const autoActive = !manual && raid?.active === true && raidHere && remain != null
  const running = manual ? manual.running : autoActive && !ended

  const pause = () => {
    if (remain == null) return
    setManual({ base: remain, at: Date.now(), running: false })
  }
  const resume = () => {
    const base = remain ?? map.raidDuration
    setManual({ base, at: Date.now(), running: true })
  }
  const jumpTo = (sec: number) => {
    const v = Math.max(0, Math.min(map.raidDuration, sec))
    setManual({ base: v, at: Date.now(), running: true })
  }
  const reset = () => setManual(null)
  const applyInput = () => {
    const m = Number(inputMin)
    const s = Number(inputSec)
    if (!Number.isFinite(m) && !Number.isFinite(s)) return
    const total = (Number.isFinite(m) ? m : 0) * 60 + (Number.isFinite(s) ? s : 0)
    jumpTo(total)
  }

  // 收起只是隐藏 UI：组件保持挂载，计时与地图绘制照常
  if (!visible) return null

  return (
    <div className="absolute left-0 top-[calc(100%+6px)] z-[610] w-[330px] max-w-[calc(100vw-24px)] rounded-xl border border-line bg-ink-800/90 shadow-xl backdrop-blur-sm p-3 space-y-2.5 text-[13px] text-[#e6edf3]">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5">
          <BtrIcon color="#58a6ff" />
          <span className="font-medium">BTR 路线跟踪</span>
          <span className="text-[11px] text-muted">{map.nameZh}</span>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={onStop}
            title="停止跟踪：结束计时并隐藏地图上的路线与车辆"
            className="px-1.5 text-[11px] leading-5 rounded border border-line text-muted hover:border-amber/70 hover:text-[#d4a174]"
          >
            停止
          </button>
          <button
            onClick={onClose}
            title="收起面板（继续计时与绘制）"
            className="px-1 text-[15px] leading-none text-muted hover:text-[#e6edf3]"
          >
            ×
          </button>
        </div>
      </div>

      <div className="flex items-end justify-between gap-2">
        <div>
          <div className="text-[11px] text-muted">战局剩余</div>
          <div className="text-[20px] leading-tight tabular-nums text-amber">
            {remain == null ? '--:--' : fmtClock(remain)}
          </div>
        </div>
        <div className="text-right text-[11px] leading-5">
          <div className={autoActive ? 'text-[#3fb950]' : 'text-muted'}>
            {autoActive ? '已接入进图时间' : manual ? '手动计时' : '未追踪'}
          </div>
          <div className="text-muted/80">
            BTR 约 {map.spawnChance}% 出现 · 每局随机路线
          </div>
        </div>
      </div>

      <div className="flex items-center gap-1.5">
        {running ? (
          <button
            onClick={pause}
            disabled={remain == null}
            className="px-2.5 py-1 rounded border border-line bg-ink-700/60 hover:border-amber/70 disabled:opacity-40"
          >
            暂停
          </button>
        ) : (
          <button
            onClick={resume}
            className="px-2.5 py-1 rounded border border-amber/60 bg-amber/10 text-[#d4a174] hover:bg-amber/20"
          >
            继续追踪
          </button>
        )}
        <button
          onClick={reset}
          title="回到跟随进图时间"
          className="px-2.5 py-1 rounded border border-line hover:border-amber/70"
        >
          复位
        </button>
        <span className="flex-1" />
        <span className="text-[11px] text-muted">跳转</span>
      </div>

      <div className="flex flex-wrap gap-1">
        {quickTimes(map.raidDuration).map((v) => (
          <button
            key={v}
            onClick={() => jumpTo(v)}
            className="px-1.5 py-0.5 rounded border border-line text-[11px] tabular-nums text-muted hover:border-amber/70 hover:text-[#d4a174]"
          >
            {fmtClock(v)}
          </button>
        ))}
      </div>

      <div className="flex items-center gap-1">
        <input
          value={inputMin}
          onChange={(e) => setInputMin(e.target.value.replace(/\D/g, ''))}
          inputMode="numeric"
          placeholder="分"
          className="w-12 px-1.5 py-0.5 rounded border border-line bg-ink-900/60 text-center tabular-nums"
        />
        <span className="text-muted">:</span>
        <input
          value={inputSec}
          onChange={(e) => setInputSec(e.target.value.replace(/\D/g, ''))}
          inputMode="numeric"
          placeholder="秒"
          className="w-12 px-1.5 py-0.5 rounded border border-line bg-ink-900/60 text-center tabular-nums"
        />
        <button
          onClick={applyInput}
          className="px-2 py-0.5 rounded border border-line hover:border-amber/70"
        >
          设为剩余时间
        </button>
      </div>

      <div className="flex flex-wrap gap-1 pt-1 border-t border-line">
        <button
          onClick={() => onFilter('all')}
          className={chipCls(filter === 'all')}
        >
          全部路线
        </button>
        {map.groups.map((g) => (
          <button key={g.key} onClick={() => onFilter(g.key)} className={chipCls(filter === g.key)}>
            {g.nameZh}
          </button>
        ))}
      </div>

      <div className="space-y-1 max-h-[32vh] overflow-y-auto pr-0.5">
        {routes.map((r) => (
          <RouteRow
            key={r.id}
            map={map}
            route={r}
            remain={remain}
            active={filter === `route:${r.id}`}
            onClick={() => onFilter(filter === `route:${r.id}` ? 'all' : `route:${r.id}`)}
          />
        ))}
        {routes.length === 0 && <div className="text-[12px] text-muted">没有匹配的路线</div>}
      </div>

      <div className="text-[11px] leading-4 text-muted/80">
        {ended
          ? '战局已结束，倒计时已停止。可点「继续追踪」或上方时间点手动推算。'
          : !raid?.startedAt
            ? '未检测到进图：可直接点「继续追踪」或选择时间点手动推算。'
            : raidHere
              ? '按进图时间自动推算；出图（或游戏进程退出）后停止。路线每局随机，可看下方候选。'
              : '当前战局不在本图，自动计时不生效。'}
      </div>
    </div>
  )
}

function chipCls(on: boolean): string {
  return `px-1.5 py-0.5 rounded border text-[11px] ${
    on
      ? 'border-amber/70 bg-amber/10 text-[#d4a174]'
      : 'border-line text-muted hover:border-amber/70'
  }`
}

function RouteRow({
  map,
  route,
  remain,
  active,
  onClick,
}: {
  map: BtrMapData
  route: BtrRoute
  remain: number | null
  active: boolean
  onClick: () => void
}) {
  const snap = remain == null ? null : btrSnapshot(map, route, remain)
  const color = btrColor(map.routes.indexOf(route))
  let text = '等待开始'
  if (snap) {
    if (snap.kind === 'waiting') text = `尚未出现（${fmtClock(snap.eta ?? 0)} 后）`
    else if (snap.kind === 'stop') text = `停靠 ${map.stops[snap.stopId ?? '']?.nameZh ?? '站点'} · ${fmtClock(snap.eta ?? 0)} 后发车`
    else if (snap.kind === 'travel')
      text = `前往 ${snap.nextStopName || '下一站'} · ${fmtClock(snap.eta ?? 0)}`
    else text = '本局路线已跑完'
  }
  return (
    <button
      onClick={onClick}
      title="点击只看这条路线"
      className={`w-full flex items-center gap-2 px-1.5 py-1 rounded text-left ${
        active ? 'bg-ink-700/70' : 'hover:bg-ink-700/40'
      }`}
    >
      <span className="w-2 h-2 rounded-full shrink-0" style={{ background: color }} />
      <span className="shrink-0">{route.nameZh}</span>
      <span className="flex-1 text-right text-[11px] text-muted truncate">{text}</span>
    </button>
  )
}

/** 小装甲车图标（面板标题用，与地图标记同为填充风格） */
export function BtrIcon({ color }: { color: string }) {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden>
      <path
        d="M3 14V9.5c0-.6.4-1 1-1h2l2-2.5h6L16 8.5h4c.6 0 1 .4 1 1V14c0 .6-.4 1-1 1h-1.2a2.3 2.3 0 0 1-4.6 0H9.8a2.3 2.3 0 0 1-4.6 0H4c-.6 0-1-.4-1-1Z"
        fill={color}
        stroke="rgba(0,0,0,0.55)"
        strokeWidth="1"
        strokeLinejoin="round"
      />
      <circle cx="7.5" cy="15" r="1.9" fill="rgba(0,0,0,0.55)" />
      <circle cx="16.5" cy="15" r="1.9" fill="rgba(0,0,0,0.55)" />
      <path d="M9 8.5h6" stroke="rgba(0,0,0,0.45)" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  )
}
