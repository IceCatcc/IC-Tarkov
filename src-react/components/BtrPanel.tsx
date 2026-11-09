import { useEffect, useMemo, useRef, useState } from 'react'
import { fmtClock, btrColor, btrLeg, type BtrMapData, type BtrRoute, type BtrLeg } from '../btr'
import { useStore } from '../store'
import type { RaidStatePayload } from '../types'

interface Props {
  map: BtrMapData
  /** 后端检测到的战局状态（web 端恒为 null） */
  raid: RaidStatePayload | null
  /** 战局是否就在当前查看的这张地图里（决定自动计时是否生效） */
  raidHere: boolean
  /** 路线筛选：'all' / 分组 key / 'route:<id>' */
  filter: string
  onFilter: (f: string) => void
  /** 面板是否展开；收起时组件继续挂载（计时继续） */
  visible: boolean
  /** 收起面板（只隐藏 UI，继续跟踪） */
  onClose: () => void
  /** 停止跟踪：结束计时并移除地图上的路线 */
  onStop: () => void
  /** 是否在地图上绘制候选路线轨迹（默认关闭：坐标是社区实测，灯塔图会偏） */
  showPath: boolean
  onTogglePath: () => void
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
  visible,
  onClose,
  onStop,
  showPath,
  onTogglePath,
}: Props) {
  // 开局偏移（秒）：日志进图 → 真正落地之间的加载时间，用它对不齐游戏倒计时时手动校准
  const offset = useStore((s) => s.btrOffset)
  const setOffset = useStore((s) => s.setBtrOffset)
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

  /**
   * 自动模式：战局剩余 = 时长 - 已过时间 - 校准偏移；出图后冻结在出图时刻。
   *
   * 已过时间优先按日志里的进图时间算；但如果那个时间戳明显不可信（时区和系统不一致 /
   * 时钟被改过，算出来是负数或远超战局时长），就退回「本机收到进图状态的时刻」——
   * 进图事件是实时的，与真正进图只差几秒，比一个差几小时的绝对值靠谱。
   */
  const autoRemain = useMemo(() => {
    if (!raid || !raidHere) return null
    // 已出图但没有出图时间（数据缺失）：不猜，交给手动模式
    if (!raid.active && !raid.endedAt) return null
    const duration = map.raidDuration
    const stopAt = raid.active ? nowMs : parseTs(raid.endedAt) ?? nowMs
    let elapsed: number | null = null
    const start = parseTs(raid.startedAt)
    if (start != null) {
      const e = (stopAt - start) / 1000
      // 合理的「已过时间」区间：允许略微提前（时钟误差）到战局结束后 5 分钟
      if (e >= -60 && e <= duration + 300) elapsed = e
    }
    if (elapsed == null) {
      elapsed = raid.active && raid.recvAt ? (nowMs - raid.recvAt) / 1000 : 0
    }
    return duration - elapsed - offset
  }, [raid, raidHere, nowMs, map.raidDuration, offset])

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
            title="停止跟踪：结束计时并隐藏地图上的候选路线"
            className="px-1.5 text-[11px] leading-5 rounded border border-line text-muted hover:border-amber/70 hover:text-[#d4a174]"
          >
            停止
          </button>
          <button
            onClick={onClose}
            title="收起面板（继续计时；地图上的站点名与轨迹不受影响）"
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

      {/* 开局校准：日志「进图」到真正落地之间还有加载时间，与游戏倒计时差几十秒时用它对齐 */}
      <div className="flex items-center gap-1" title="日志里的进图时间到真正落地之间还有加载时间：和游戏内倒计时对不上时调整这里。+ 让显示的剩余时间更少，- 让它更多。">
        <span className="text-[11px] text-muted">开局校准</span>
        <button
          onClick={() => setOffset(offset - 15)}
          className="px-1.5 py-0.5 rounded border border-line text-[11px] tabular-nums text-muted hover:border-amber/70 hover:text-[#d4a174]"
        >
          -15s
        </button>
        <span
          className={`min-w-[46px] text-center text-[11px] tabular-nums ${
            offset ? 'text-[#d4a174]' : 'text-muted'
          }`}
        >
          {offset > 0 ? '+' : ''}
          {offset}s
        </span>
        <button
          onClick={() => setOffset(offset + 15)}
          className="px-1.5 py-0.5 rounded border border-line text-[11px] tabular-nums text-muted hover:border-amber/70 hover:text-[#d4a174]"
        >
          +15s
        </button>
        <button
          onClick={() => setOffset(0)}
          disabled={!offset}
          className="px-1.5 py-0.5 rounded border border-line text-[11px] text-muted hover:border-amber/70 disabled:opacity-40"
        >
          归零
        </button>
        <span className="flex-1" />
        <button
          onClick={onTogglePath}
          title="在地图上画出候选路线的轨迹（社区实测坐标，灯塔图可能与实际路线有偏差；站点名称与图标始终显示）"
          className={chipCls(showPath)}
        >
          地图轨迹
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
              ? '按进图时间自动推算（本地/在线战局的实际时序可能有偏差，用「开局校准」对齐）。路线每局随机，看下方各线路的当前检查点。'
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

/** 一条路线的检查点进度：第一行「现在在哪 / 正在去哪 + 倒计时」，第二行「下一站 / 再下一站」 */
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
  const leg: BtrLeg | null = remain == null ? null : btrLeg(map, route, remain)
  const color = btrColor(map.routes.indexOf(route))
  const stopName = (id: string | null) => (id ? map.stops[id]?.nameZh ?? id : '')

  let head = '等待开始'
  let tail = ''
  if (leg) {
    if (leg.kind === 'waiting') {
      head = `尚未出现 · ${fmtClock(leg.eta ?? 0)} 后部署`
      tail = leg.toName ? `首站 ${leg.toName}` : ''
    } else if (leg.kind === 'stop') {
      head = `停靠 ${stopName(leg.fromStopId)} · ${fmtClock(leg.eta ?? 0)} 后发车`
      tail = [leg.toName && `下一站 ${leg.toName}`, leg.afterName && `再下一站 ${leg.afterName}`]
        .filter(Boolean)
        .join(' · ')
    } else if (leg.kind === 'travel') {
      head = `前往 ${leg.toName || '下一站'} · ${fmtClock(leg.eta ?? 0)} 后到`
      tail = [leg.fromStopId && `离开 ${stopName(leg.fromStopId)}`, leg.afterName && `再下一站 ${leg.afterName}`]
        .filter(Boolean)
        .join(' · ')
    } else {
      head = '本局路线已跑完'
      tail = leg.fromStopId ? `终点 ${stopName(leg.fromStopId)}` : ''
    }
  }
  return (
    <button
      onClick={onClick}
      title="点击只看这条路线"
      className={`w-full px-1.5 py-1 rounded text-left ${
        active ? 'bg-ink-700/70' : 'hover:bg-ink-700/40'
      }`}
    >
      <span className="flex items-center gap-2">
        <span className="w-2 h-2 rounded-full shrink-0" style={{ background: color }} />
        <span className="shrink-0">{route.nameZh}</span>
        <span
          className={`flex-1 text-right text-[11px] truncate ${
            leg?.kind === 'waiting' || !leg ? 'text-muted' : 'text-[#e6edf3]'
          }`}
        >
          {head}
        </span>
      </span>
      {tail && (
        <span className="mt-0.5 flex items-center gap-2 pl-4">
          <span className="flex-1 text-right text-[10.5px] text-muted/70 truncate">{tail}</span>
        </span>
      )}
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
