import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { confirm, open } from '@tauri-apps/plugin-dialog'
import {
  applyBossLoggingConfig,
  getBossLoggingStatus,
  getBossMonitor,
  getMapBosses,
  getMapsSkeleton,
  restoreBossLoggingConfig,
  setBossGameRoot,
  setBossMonitorEnabled,
  setBossMonitorNotify,
} from '../tauri'
import { useStore } from '../store'
import { isMobile, isWeb } from '../platform'
import { bossImage, isBossRole } from '../bossImages'
import type {
  BossSpawnState,
  LoggingConfigStatus,
  MapBossesDoc,
  SkeletonDoc,
} from '../types'

type SpawnStatus = BossSpawnState['status']

const STATUS_STYLE: Record<SpawnStatus, { label: string; cls: string; dot: string }> = {
  confirmed: {
    label: '已刷新',
    cls: 'border-[#3fb950]/45 bg-[#3fb950]/10 text-[#3fb950]',
    dot: 'bg-[#3fb950] shadow-[0_0_6px_#3fb950]',
  },
  planned: {
    label: '预计刷新',
    cls: 'border-amber/45 bg-amber/10 text-[#d4a174]',
    dot: 'bg-amber shadow-[0_0_6px_rgba(239,159,39,.9)]',
  },
  not_planned: {
    label: '本局不刷',
    cls: 'border-line bg-ink-700/60 text-muted',
    dot: 'bg-muted/60',
  },
  dead: {
    label: '已确认死亡',
    cls: 'border-line/70 bg-ink-700/30 text-muted/70',
    dot: 'bg-muted/40',
  },
  unknown: {
    label: '未检测',
    cls: 'border-line/60 bg-transparent text-muted/60',
    dot: 'bg-muted/30',
  },
}

/** 有 BTR 的地图（normalizedName） */
const BTR_MAPS = ['woods', 'streets-of-tarkov', 'lighthouse']

/** BTR 的状态文案（与 Boss 共用样式，但「已刷新」对装甲车读起来别扭） */
const BTR_STATUS: Record<SpawnStatus, { label: string; cls: string; dot: string }> = {
  confirmed: { ...STATUS_STYLE.confirmed, label: '已出现' },
  planned: { ...STATUS_STYLE.planned, label: '预计出现' },
  not_planned: { ...STATUS_STYLE.not_planned, label: '本局不刷' },
  dead: { ...STATUS_STYLE.dead, label: '已离场 / 被毁' },
  unknown: { ...STATUS_STYLE.unknown, label: '未检测' },
}

/** 日志时间戳 `yyyy-MM-dd HH:mm:ss.fff` → `HH:mm:ss` */
function clock(ts?: string | null): string {
  if (!ts) return ''
  return ts.length >= 19 ? ts.slice(11, 19) : ts
}

/** 取数组最后一项（时间列表的「最近一次」） */
function lastOf(arr?: string[] | null): string | undefined {
  return arr && arr.length > 0 ? arr[arr.length - 1] : undefined
}

/**
 * 刷新概率：日志里的 `BossChance` 是百分数（0~100），
 * 数据集里的 `chance` 是小数（0~1），口径不同要分开换算。
 */
function chancePct(live?: BossSpawnState, fallback?: number | null): string {
  if (live?.chance != null) return `${Math.round(live.chance)}%`
  if (fallback != null) return `${Math.round(fallback * 100)}%`
  return '—'
}

/**
 * 本地战局 Boss 监控：读取本机游戏日志（application / aiData / backend），
 * 显示当前战局地图与每只 Boss 的「生成判定 / 实际刷新 / 死亡」状态，
 * 并可一键修改 / 恢复游戏的 `Logging.config` 以便输出详细 AI 记录。
 *
 * 注意：只读日志与改日志级别，不碰游戏内存；但第三方工具的安全性无法保证，
 * 使用风险由用户自行承担（界面上有醒目提示）。
 */
export function BossMonitorTool() {
  const unsupported = isWeb() || isMobile()
  // 快照由 tauri-impl 的全局监听写进 store，地图页共用同一份
  const monitor = useStore((s) => s.boss)
  // 地图绘制开关（随 mapPrefs.bossMarkers 持久化，地图页只读结果）
  const bossMarkers = useStore((s) => s.bossMarkers)
  const setBossMarkers = useStore((s) => s.setBossMarkers)
  const [cfg, setCfg] = useState<LoggingConfigStatus | null>(null)
  const [bossDoc, setBossDoc] = useState<MapBossesDoc | null>(null)
  const [skeleton, setSkeleton] = useState<SkeletonDoc | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [feedback, setFeedback] = useState<{ kind: 'ok' | 'warn'; text: string } | null>(null)

  useEffect(() => {
    if (unsupported) {
      setLoading(false)
      return
    }
    let cancelled = false
    Promise.all([
      getBossMonitor(),
      getBossLoggingStatus().catch(() => null),
      getMapBosses().catch(() => null),
      getMapsSkeleton().catch(() => null),
    ])
      .then(([m, c, bd, sk]) => {
        if (cancelled) return
        useStore.getState().setBoss(m)
        setCfg(c)
        setBossDoc(bd)
        setSkeleton(sk)
      })
      .catch((e) => !cancelled && setError(String(e)))
      .finally(() => !cancelled && setLoading(false))

    return () => {
      cancelled = true
    }
  }, [unsupported])

  const mapNames = useMemo(() => {
    const out: Record<string, string> = {}
    for (const g of skeleton?.groups ?? []) {
      out[g.normalizedName] = g.nameZh || g.normalizedName
    }
    return out
  }, [skeleton])

  const enabled = !!monitor?.enabled
  const map = monitor?.map ?? ''
  const mapLabel = monitor?.mapName || mapNames[map] || map

  // BTR 只有在森林 / 街区 / 灯塔出现；其它地图上只有真的读到日志信号才显示
  const btr = monitor?.btr
  const btrRelevant =
    !!btr &&
    (BTR_MAPS.includes(map) ||
      btr.status !== 'unknown' ||
      btr.readyAt.length > 0 ||
      btr.taxiAt.length > 0)
  const btrSt = BTR_STATUS[(btr?.status as SpawnStatus | undefined) ?? 'unknown'] ?? BTR_STATUS.unknown

  // 本图 Boss 表（数据集给出刷新概率）与日志状态合并；日志里出现但不属于本图的角色单列
  const rows = useMemo(() => {
    const live = new Map<string, BossSpawnState>()
    for (const b of monitor?.bosses ?? []) live.set(b.role.toLowerCase(), b)
    const known = (bossDoc?.maps?.[map] ?? []).map((b) => ({
      id: b.id,
      name: b.nameZh || b.name || b.id,
      chance: b.chance,
      live: live.get(b.id.toLowerCase()),
    }))
    const extras = (monitor?.bosses ?? [])
      .filter(
        (b) =>
          // 只列真 Boss：日志里的 pmc / assault / marksman / follower 等普通 AI 不进来
          // （BTR 有独立状态卡，不混在 Boss 列表里）
          isBossRole(b.role) &&
          !known.some((r) => r.id.toLowerCase() === b.role.toLowerCase()),
      )
      .map((b) => ({ id: b.role, name: b.role, chance: null as number | null, live: b }))
    return [...known, ...extras]
  }, [bossDoc, monitor, map])

  const refreshCfg = useCallback(async () => {
    try {
      setCfg(await getBossLoggingStatus())
    } catch (e) {
      setError(String(e))
    }
  }, [])

  const toggleMonitor = async () => {
    if (!monitor) return
    if (!monitor.enabled) {
      const ok = await confirm(
        '开启后会自动把游戏 Logging.config 中 aiData 的日志级别改成 Trace，' +
          '关闭监控时再自动改回 Error（都需重启游戏才生效）。\n' +
          '本功能只读取本机日志与改日志级别，但官方未对该行为作出说明：' +
          '未知是否会造成封号影响，风险自负。\n\n确定开启监控？',
        { title: '开启本地战局 Boss 监控', kind: 'warning' },
      )
      if (!ok) return
    }
    setBusy('toggle')
    setError(null)
    try {
      const next = await setBossMonitorEnabled(!monitor.enabled)
      useStore.getState().setBoss(next)
      // 开关会同步修改 / 还原 Logging.config，刷新配置状态并按结果给出提示
      const st = await getBossLoggingStatus().catch(() => null)
      if (st) setCfg(st)
      if (next.enabled) {
        if (st?.patched) {
          setFeedback({ kind: 'ok', text: '监控已开启：日志配置已改为 Trace（重启游戏后生效）' })
        } else {
          setFeedback({
            kind: 'warn',
            text: `监控已开启，但日志配置未能自动修改${
              st?.error ? `：${st.error}` : '（可能没有写入权限）'
            }`,
          })
        }
      } else if (st && !st.patched && st.aiDataLevel.toLowerCase() === st.restoreTarget.toLowerCase()) {
        setFeedback({ kind: 'ok', text: `监控已关闭：日志配置已恢复为 ${st.restoreTarget}` })
      } else {
        setFeedback({
          kind: 'warn',
          text: '监控已关闭，但日志配置未能自动恢复（可在下方手动点「恢复原配置」）',
        })
      }
    } catch (e) {
      setError(String(e))
    } finally {
      setBusy(null)
    }
  }

  const toggleNotify = async () => {
    if (!monitor) return
    setBusy('notify')
    setError(null)
    try {
      useStore.getState().setBoss(await setBossMonitorNotify(!monitor.notify))
    } catch (e) {
      setError(String(e))
    } finally {
      setBusy(null)
    }
  }

  const pickRoot = async () => {
    try {
      const selected = await open({
        directory: true,
        multiple: false,
        title: '选择游戏安装目录（与 EscapeFromTarkov.exe 同级）',
      })
      const dir = Array.isArray(selected) ? selected[0] : selected
      if (!dir) return
      setBusy('pick')
      setError(null)
      const next = await setBossGameRoot(String(dir))
      setCfg(next)
      setFeedback(
        next.found
          ? { kind: 'ok', text: '已定位到 Logging.config' }
          : { kind: 'warn', text: '该目录下没有找到 Logging.config' },
      )
    } catch (e) {
      setError(String(e))
    } finally {
      setBusy(null)
    }
  }

  const applyConfig = async () => {
    const ok = await confirm(
      '将把 Logging.config 中 aiData 规则的 minLevel 改为 Trace。\n' +
        '修改后需要重启游戏才能生效；随时可以点「恢复原配置」写回 Error。\n\n是否继续？',
      { title: '一键修改日志配置', kind: 'warning' },
    )
    if (!ok) return
    setBusy('apply')
    setError(null)
    setFeedback(null)
    try {
      const next = await applyBossLoggingConfig()
      setCfg(next)
      setFeedback({ kind: 'ok', text: '已修改日志配置：重启游戏后开始输出详细 AI 记录' })
    } catch (e) {
      setError(String(e))
    } finally {
      setBusy(null)
    }
  }

  const restoreConfig = async () => {
    const ok = await confirm(
      `将把 aiData 的 minLevel 固定写回原始级别（${cfg?.restoreTarget || 'Error'}）。\n` +
        '只改这一项，其它日志规则与格式保持不变。\n\n是否继续？',
      { title: '恢复原日志配置', kind: 'warning' },
    )
    if (!ok) return
    setBusy('restore')
    setError(null)
    setFeedback(null)
    try {
      const next = await restoreBossLoggingConfig()
      setCfg(next)
      setFeedback({ kind: 'ok', text: `已恢复：aiData → ${next.restoreTarget}（重启游戏后生效）` })
    } catch (e) {
      setError(String(e))
    } finally {
      setBusy(null)
    }
  }

  if (unsupported) {
    return (
      <Notice
        title="本地战局 Boss 监控仅电脑端可用"
        text="该功能直接读取本机《逃离塔科夫》的日志文件，并修改游戏安装目录下的 Logging.config；浏览器与手机端没有这些文件。"
      />
    )
  }

  if (loading) {
    return <div className="py-8 text-[13px] text-muted">正在读取监控状态…</div>
  }

  return (
    <div className="mx-auto w-full max-w-[920px] space-y-3 pb-6">
      {/* 风险提示：按要求常驻显眼展示 */}
      <div className="rounded-xl border border-[#f85149]/40 bg-[#f85149]/[0.07] px-4 py-3">
        <div className="flex items-start gap-2.5">
          <span className="mt-0.5 shrink-0 text-[#ff9b95]">
            <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8">
              <path d="M12 3.6 21 19.4H3z" strokeLinejoin="round" />
              <path d="M12 9.4v4.6M12 16.6v.6" strokeLinecap="round" />
            </svg>
          </span>
          <div className="min-w-0">
            <div className="text-[13px] font-medium text-[#ff9b95]">
              功能警告：未知是否会造成封号影响
            </div>
            <div className="mt-1 text-[12px] leading-relaxed text-muted/85">
              本功能只读取本机游戏日志，并可修改游戏的 <Code>Logging.config</Code>（日志级别），
              不读写游戏内存、不注入进程、不修改游戏资源。但任何第三方工具都无法保证安全，
              是否使用（尤其是线上战局）请自行判断并承担风险。
            </div>
          </div>
        </div>
      </div>

      {/* 总开关 */}
      <div className="relative overflow-hidden rounded-xl border border-line/80 bg-gradient-to-br from-[#1b2231] via-[#161b22] to-[#12161d]">
        <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-amber/60 to-transparent" />
        <div className="flex items-center gap-3 px-4 py-3">
          <span
            className={`grid h-10 w-10 shrink-0 place-items-center rounded-lg border transition-colors ${
              enabled
                ? 'border-amber/40 bg-amber/10 text-[#d4a174] shadow-[0_0_16px_-6px_rgba(239,159,39,.8)]'
                : 'border-line bg-ink-700/50 text-muted'
            }`}
          >
            <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.6">
              <circle cx="12" cy="12" r="3.2" />
              <path d="M12 3v2.2M12 18.8V21M3 12h2.2M18.8 12H21M5.6 5.6l1.6 1.6M16.8 16.8l1.6 1.6M18.4 5.6l-1.6 1.6M7.2 16.8l-1.6 1.6" strokeLinecap="round" />
            </svg>
          </span>
          <div className="min-w-0">
            <div className="text-[14px] text-[#e6edf3]">本地战局 Boss 监控</div>
            <div className="mt-0.5 text-[11px] leading-snug text-muted/80">
              读本机战局日志 · Boss / BTR 刷新 · 仅本地 PvE / 离线战局有效
            </div>
          </div>
          <div className="ml-auto flex shrink-0 items-center gap-3">
            <div className="text-right">
              <div className={`text-[11px] ${enabled ? 'text-[#3fb950]' : 'text-muted/70'}`}>
                {enabled ? '已启用' : '已关闭'}
              </div>
              <div className="text-[10px] text-muted/50">
                {monitor?.hasAiData ? '详细 AI 日志已生效' : '等待详细 AI 日志'}
              </div>
            </div>
            <Switch checked={enabled} disabled={busy === 'toggle'} onChange={toggleMonitor} />
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-line/50 bg-[#0f141b]/40 px-4 py-2 text-[11px] text-muted/70">
          <label className="flex cursor-pointer select-none items-center gap-2">
            <input
              type="checkbox"
              checked={!!monitor?.notify}
              disabled={busy === 'notify'}
              onChange={toggleNotify}
              className="accent-amber"
            />
            刷新时弹底部悬浮通知（仅「确认刷新」提示）
          </label>
          <label
            className="flex cursor-pointer select-none items-center gap-2"
            title="把日志里确认刷新的 Boss / BTR 按坐标画在地图上（Boss 用头像，BTR 用蓝色字样），已确认死亡的淡显"
          >
            <input
              type="checkbox"
              checked={bossMarkers}
              onChange={(e) => setBossMarkers(e.target.checked)}
              className="accent-amber"
            />
            在地图上绘制刷新位置
          </label>
          <span className="ml-auto truncate font-mono text-[10.5px] text-muted/50">
            {monitor?.session ? `会话 ${monitor.session}` : '尚未检测到日志会话'}
          </span>
        </div>
      </div>

      {error && <Notice title="操作失败" text={error} tone="err" />}
      {feedback && (
        <div
          className={`rounded-lg border px-3 py-2 text-[12px] ${
            feedback.kind === 'ok'
              ? 'border-[#3fb950]/40 bg-[#3fb950]/[0.07] text-[#7ee787]'
              : 'border-amber/40 bg-amber/[0.07] text-[#d4a174]'
          }`}
        >
          {feedback.text}
        </div>
      )}

      {/* 当前战局 */}
      <Section
        title="当前战局"
        hint={mapLabel ? `${mapLabel}${monitor?.ended ? ' · 已结束' : ''}` : undefined}
        icon={<IconRadar />}
        right={
          <button
            onClick={() =>
              getBossMonitor()
                .then((m) => useStore.getState().setBoss(m))
                .catch(() => {})
            }
            className="rounded border border-line/80 px-2 py-1 text-[11px] text-muted hover:border-amber/50 hover:text-[#d4a174]"
          >
            刷新
          </button>
        }
      >
        <div className="flex flex-wrap items-center gap-x-5 gap-y-1 border-b border-line/40 bg-[#0f141b]/30 px-3.5 py-2 text-[11.5px]">
          <span className="text-muted">
            地图：
            <span className="text-[#e6edf3]">{mapLabel || '未进入战局'}</span>
          </span>
          <span className="text-muted">
            状态：
            <span className={monitor?.inRaid ? 'text-[#3fb950]' : 'text-muted/70'}>
              {monitor?.inRaid ? '战局进行中' : enabled ? '待机' : '监控已关闭'}
            </span>
          </span>
          {monitor?.startedAt && (
            <span className="text-muted">
              进图：
              <span className="font-mono text-[#c9d1d9]">{clock(monitor.startedAt)}</span>
            </span>
          )}
          <span className="ml-auto text-[11px] text-muted/60">{monitor?.diagnostic}</span>
        </div>

        {!enabled ? (
          <div className="px-4 py-8 text-center text-[12px] text-muted/70">
            打开上方开关后开始读取日志（需要先在设置里配置日志目录）。
          </div>
        ) : rows.length === 0 ? (
          <div className="px-4 py-8 text-center text-[12px] leading-relaxed text-muted/70">
            {map
              ? '数据里这张地图没有固定 Boss。'
              : '尚未检测到战局：进入本地（PvE / 离线）战局后会自动开始监控。'}
          </div>
        ) : (
          <ul className="divide-y divide-line/40">
            {rows.map((r) => {
              const live = r.live
              const st = STATUS_STYLE[(live?.status as SpawnStatus) ?? 'unknown'] ?? STATUS_STYLE.unknown
              const img = bossImage(r.id)
              return (
                <li key={r.id} className="flex items-center gap-3 px-3.5 py-2.5">
                  {img ? (
                    <img
                      src={img}
                      alt=""
                      loading="lazy"
                      draggable={false}
                      className="h-8 w-8 shrink-0 rounded-full bg-ink-700/60 object-cover"
                    />
                  ) : (
                    <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full border border-line/70 bg-ink-700/40 text-[10px] text-muted/60">
                      ?
                    </span>
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-[13px] text-[#e6edf3]" title={r.id}>
                        {r.name}
                      </span>
                      <span className={`shrink-0 rounded border px-1.5 py-px text-[10px] ${st.cls}`}>
                        <span className={`mr-1 inline-block h-1.5 w-1.5 rounded-full ${st.dot}`} />
                        {st.label}
                      </span>
                      {live && live.count > 1 && (
                        <span className="shrink-0 text-[10.5px] text-muted/60">×{live.count}</span>
                      )}
                    </div>
                    <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[10.5px] text-muted/70">
                      <span>
                        刷新概率
                        <span className="ml-1 tabular-nums text-amber">{chancePct(live, r.chance)}</span>
                      </span>
                      {live?.zone && <span className="truncate">区域 {live.zone}</span>}
                      {live?.position && <span className="truncate font-mono">{live.position}</span>}
                      {live?.at && <span className="ml-auto font-mono">{clock(live.at)}</span>}
                    </div>
                  </div>
                </li>
              )
            })}
          </ul>
        )}

        {enabled && btrRelevant && btr && (
          <div className="border-t border-line/40 px-3.5 py-2.5">
            <div className="flex items-center gap-2">
              <span className="text-[#58a6ff]">
                <IconBtr />
              </span>
              <span className="text-[13px] text-[#e6edf3]">BTR 装甲车</span>
              <span className={`shrink-0 rounded border px-1.5 py-px text-[10px] ${btrSt.cls}`}>
                <span className={`mr-1 inline-block h-1.5 w-1.5 rounded-full ${btrSt.dot}`} />
                {btrSt.label}
              </span>
              {btr.position && (
                <span className="min-w-0 truncate font-mono text-[10.5px] text-muted/60">
                  {btr.position}
                </span>
              )}
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-0.5 text-[10.5px] text-muted/70">
              <span>
                出发准备信号
                <span className="mx-1 tabular-nums text-amber">{btr.readyAt.length}</span>次
                {btr.readyAt.length > 0 && (
                  <span className="ml-1 font-mono">{clock(lastOf(btr.readyAt))}</span>
                )}
              </span>
              <span>
                购买运送：
                {btr.taxiAt.length > 0 ? (
                  <>
                    <span className="mx-1 tabular-nums text-amber">{btr.taxiAt.length}</span>次
                    <span className="ml-1 font-mono">{clock(lastOf(btr.taxiAt))}</span>
                  </>
                ) : (
                  '未记录'
                )}
              </span>
              {btr.at && <span className="ml-auto font-mono">{clock(btr.at)}</span>}
            </div>
            <div className="mt-1 text-[10.5px] leading-relaxed text-muted/55">
              BTR 只在森林 / 街区 / 灯塔出现。「出发准备信号」来自日志里的音频控制器事件
              （<Code>OnReadyToDeparture</Code>），代表装甲车即将发车；购车记录来自
              <Code>Service PlayerTaxi</Code>。
            </div>
          </div>
        )}

        <div className="border-t border-line/40 bg-[#0f141b]/30 px-3.5 py-2 text-[10.5px] leading-relaxed text-muted/55">
          「已刷新」= 日志里出现了实际激活记录；「预计刷新」= 系统已判定本局要刷（还没激活）；
          「本局不刷」= 判定未命中。区域与坐标是首次刷新时的位置，不是 Boss 当前所在处。
        </div>
      </Section>

      {/* 日志配置 */}
      <Section
        title="游戏日志配置"
        hint="一键修改 / 恢复 Logging.config"
        icon={<IconFile />}
        right={
          <button
            onClick={refreshCfg}
            className="rounded border border-line/80 px-2 py-1 text-[11px] text-muted hover:border-amber/50 hover:text-[#d4a174]"
          >
            重新检测
          </button>
        }
      >
        <div className="space-y-2 px-3.5 py-3">
          <div className="flex justify-between gap-3 text-[11.5px]">
            <span className="shrink-0 text-muted">配置文件</span>
            <span className="min-w-0 break-all text-right font-mono text-[11px] text-[#c9d1d9]">
              {cfg?.configPath || '未找到 Logging.config'}
            </span>
          </div>
          <div className="flex justify-between gap-3 text-[11.5px]">
            <span className="shrink-0 text-muted">aiData 级别</span>
            <span className={cfg?.patched ? 'text-[#3fb950]' : 'text-amber'}>
              {cfg?.found ? cfg.aiDataLevel || '（缺失）' : '—'}
              {cfg?.found && !cfg.patched && ' · 未开启详细 AI 日志'}
            </span>
          </div>
          <div className="flex justify-between gap-3 text-[11.5px]">
            <span className="shrink-0 text-muted">还原目标</span>
            <span className="text-[#3fb950]">
              {cfg?.restoreTarget || 'Error'}
              <span className="ml-1 text-muted/60">（aiData 原始级别）</span>
            </span>
          </div>
          {cfg?.error && (
            <div className="rounded border border-amber/35 bg-amber/[0.06] px-2.5 py-2 text-[11.5px] leading-relaxed text-[#d4a174]">
              {cfg.error}
            </div>
          )}
          {!cfg && (
            <div className="rounded border border-line/70 bg-ink-800/50 px-2.5 py-2 text-[11.5px] text-muted/80">
              读取不到日志配置状态，可点右上角「重新检测」重试。
            </div>
          )}
          <div className="flex flex-wrap items-center gap-2 pt-1">
            <ActionButton onClick={applyConfig} tone="primary" disabled={busy !== null || !cfg?.found}>
              {busy === 'apply' ? '修改中…' : '一键修改'}
            </ActionButton>
            <ActionButton
              onClick={restoreConfig}
              tone="danger"
              disabled={busy !== null || !cfg?.found || !cfg.patched}
            >
              {busy === 'restore' ? '恢复中…' : '恢复原配置'}
            </ActionButton>
            <ActionButton onClick={pickRoot} tone="plain" disabled={busy !== null}>
              {busy === 'pick' ? '读取中…' : '选择游戏目录'}
            </ActionButton>
            <span className="ml-auto text-[10.5px] text-muted/55">
              修改后需重启游戏才生效
            </span>
          </div>
          <div className="text-[10.5px] leading-relaxed text-muted/55">
            只改 <Code>rules[].fileName = "aiData"</Code> 的 <Code>minLevel</Code>（→ Trace）。
            「恢复」固定写回原始级别 <Code>Error</Code>，不记录原值、也不生成备份文件；
            当前级别若不是 Trace（已被手动改过）会拒绝自动还原。其它日志规则原样保留。
            游戏以管理员身份运行时，写入可能因权限不足失败。
          </div>
        </div>
      </Section>

      <div className="rounded-xl border border-line/70 bg-ink-800/40 px-3.5 py-3 text-[11.5px] leading-relaxed text-muted/70">
        <div className="mb-1 text-[12px] text-[#e6edf3]">说明</div>
        <ul className="list-disc space-y-1 pl-4">
          <li>仅在**本地运行**的战局里有效（PvE / 离线）；在线战局由服务器托管，本机日志不会输出 AI 生成细节。</li>
          <li>「预计刷新」来自日志里的生成判定（roll），与是否已经激活是两件事，因此能区分「本局不刷」与「刷了但还没激活」。</li>
          <li>开启监控会自动把 <Code>aiData</Code> 调到 <Code>Trace</Code>，关闭时自动改回 <Code>Error</Code>（都需重启游戏生效）；下方配置卡的两个按钮可手动补做。</li>
          <li>日志目录取自「设置」里配置的路径（通常为 <Code>%LOCALAPPDATA%\Temp\Battlestate Games\EscapeFromTarkov\Logs</Code>）。</li>
          <li>BTR 与 Boss 走同一套日志判定（生成判定 / 实际激活），另单独记录「出发准备信号」与购车记录；不发车信号时也可能已经出现，以状态徽标为准。</li>
          <li>关闭监控会清空实时状态，但不会动游戏日志与 Logging.config。</li>
        </ul>
      </div>
    </div>
  )
}

/* ---------------- 小组件 ---------------- */

function Code({ children }: { children: ReactNode }) {
  return <code className="rounded bg-white/[0.06] px-1 py-px font-mono text-[10.5px]">{children}</code>
}

function Section({
  title,
  hint,
  icon,
  right,
  children,
}: {
  title: string
  hint?: string
  icon: ReactNode
  right?: ReactNode
  children: ReactNode
}) {
  return (
    <div className="overflow-hidden rounded-xl border border-line/80 bg-gradient-to-b from-[#161b22] to-[#131820]">
      <div className="flex items-center gap-2 border-b border-line/60 bg-white/[0.02] px-3.5 py-2">
        <span className="text-[#d4a174]">{icon}</span>
        <h2 className="text-[12.5px] font-medium tracking-wide text-[#e6edf3]">{title}</h2>
        {hint && <span className="truncate text-[10.5px] text-muted/60">{hint}</span>}
        {right && <span className="ml-auto shrink-0">{right}</span>}
      </div>
      {children}
    </div>
  )
}

function Switch({
  checked,
  disabled,
  onChange,
}: {
  checked: boolean
  disabled?: boolean
  onChange: () => void
}) {
  return (
    <button
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={onChange}
      className={`relative h-5 w-9 shrink-0 rounded-full transition-colors disabled:opacity-60 ${
        checked ? 'bg-amber/80' : 'bg-ink-600'
      }`}
    >
      <span
        className={`absolute top-0.5 h-4 w-4 rounded-full bg-[#f2f5f8] shadow transition-all ${
          checked ? 'left-[18px]' : 'left-0.5'
        }`}
      />
    </button>
  )
}

function ActionButton({
  children,
  onClick,
  tone,
  disabled,
}: {
  children: ReactNode
  onClick: () => void
  tone: 'plain' | 'primary' | 'danger'
  disabled?: boolean
}) {
  const cls =
    tone === 'primary'
      ? 'border-amber/50 bg-amber/15 text-[#e8b071] hover:bg-amber/25'
      : tone === 'danger'
        ? 'border-line/80 text-muted hover:border-[#f85149]/50 hover:text-[#f85149]'
        : 'border-line/80 text-muted hover:border-line hover:text-[#e6edf3]'
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`h-8 rounded-md border px-3 text-[12px] transition-colors disabled:opacity-45 ${cls}`}
    >
      {children}
    </button>
  )
}

function Notice({
  title,
  text,
  tone = 'plain',
}: {
  title: string
  text: string
  tone?: 'plain' | 'err'
}) {
  return (
    <div
      className={`rounded-xl border px-4 py-3 ${
        tone === 'err' ? 'border-[#f85149]/40 bg-[#f85149]/5' : 'border-line/80 bg-ink-800/60'
      }`}
    >
      <div className="text-[13px] text-[#e6edf3]">{title}</div>
      <div className="mt-1 text-[12px] leading-relaxed text-muted/80">{text}</div>
    </div>
  )
}

function IconRadar() {
  return (
    <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="12" cy="12" r="8.2" />
      <circle cx="12" cy="12" r="3.2" />
      <path d="M12 12 18 6" strokeLinecap="round" />
    </svg>
  )
}

function IconBtr() {
  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.6">
      <path d="M3 14.5V9.5c0-.5.4-1 1-1h2l2-2.5h6L16 8.5h4c.5 0 1 .5 1 1v5c0 .5-.5 1-1 1h-1.3a2.2 2.2 0 0 1-4.4 0H9.7a2.2 2.2 0 0 1-4.4 0H4c-.6 0-1-.5-1-1Z" strokeLinejoin="round" />
      <circle cx="7.5" cy="15.4" r="1.7" />
      <circle cx="16.5" cy="15.4" r="1.7" />
      <path d="M9.5 8.5h5" strokeLinecap="round" />
    </svg>
  )
}

function IconFile() {
  return (
    <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M6 3.5h7l5 5V20a.5.5 0 0 1-.5.5h-11A.5.5 0 0 1 6 20z" strokeLinejoin="round" />
      <path d="M13 3.5V9h5" strokeLinejoin="round" />
    </svg>
  )
}
