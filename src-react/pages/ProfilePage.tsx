import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { useStore, useTopPad } from '../store'
import { saveSettings, getMaps } from '../tauri'
import { traderImage } from '../traderImages'
import { TRADERS } from '../traderMeta'
import type { PlayerProfile, MapInfo } from '../types'

// 地图解锁展示顺序（中心区 / 工厂 / 实验室 含变体合并为一组统一切换；
// Ground Zero 教程不列出）；同组任一勾选即视为已解锁
type MapRow = { type: 'group' | 'single'; label: string; ids: string[] }
const MAP_DISPLAY_ORDER: MapRow[] = [
  { type: 'group', label: '中心区', ids: ['653e6760052c01c1c805532f', '65b8d6f5cdde2479cb2a3125'] },
  { type: 'single', label: '立交桥', ids: ['5714dbc024597771384a510d'] },
  { type: 'single', label: '海关', ids: ['56f40101d2720b2a4d8b45d6'] },
  { type: 'group', label: '工厂', ids: ['55f2d3fd4bdc2d5f408b4567', '59fc81d786f774390775787e'] },
  { type: 'single', label: '森林', ids: ['5704e3c2d2720bac5b8b4567'] },
  { type: 'single', label: '海岸线', ids: ['5704e554d2720bac5b8b456e'] },
  { type: 'single', label: '街区', ids: ['5714dc692459777137212e12'] },
  { type: 'single', label: '储备站', ids: ['5704e5fad2720bc05b8b4567'] },
  { type: 'single', label: '灯塔', ids: ['5704e4dad2720bb55b8b4567'] },
  { type: 'group', label: '实验室', ids: ['5b0fc42d86f7744a585f9105', '6a294a5b5eb5f9a1700417b7'] },
  { type: 'single', label: '迷宫', ids: ['6733700029c367a3d40b02af'] },
  { type: 'single', label: '破冰船', ids: ['69af492a4819ea4ba10a69c5'] },
  { type: 'single', label: '码头', ids: ['65cc8f81a9aac3e77d0cfd3e'] },
]

export function ProfilePage() {
  const settings = useStore((s) => s.settings)
  const setSettings = useStore((s) => s.setSettings)
  // 侧边栏折叠时，顶部标题为左上角浮动按钮预留空位
  const topPad = useTopPad()

  // profile 直接派生自 store（settings.profile），不再用本地 useState——
  // 本地 useState 只在首次挂载取值，若保存失败或设置晚于挂载加载，切页重挂载会回退默认值。
  const profile: PlayerProfile = settings.profile ?? { level: 1, loyalty: {}, lockedMaps: [] }
  const [maps, setMaps] = useState<MapInfo[]>([])
  const [flash, setFlash] = useState(false)
  const flashTimer = useRef<number | undefined>(undefined)

  // 加载全部地图列表（用于「地图解锁」管理）
  useEffect(() => {
    let alive = true
    getMaps()
      .then((list) => alive && setMaps(list))
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [])

  // 任意改动后自动保存（无需点「保存」按钮）：先同步 store（页面切换不丢），再异步落盘
  const persist = useCallback(
    (next: PlayerProfile) => {
      setSettings({ ...settings, profile: next })
      setFlash(true)
      if (flashTimer.current) window.clearTimeout(flashTimer.current)
      flashTimer.current = window.setTimeout(() => setFlash(false), 1500)
      saveSettings(
        settings.logDir,
        settings.screenshotDir,
        settings.deleteScreenshots,
        next,
      )
        .then((st) => setSettings(st))
        .catch((e) => console.error('保存角色失败', e))
    },
    [settings, setSettings],
  )

  const applyLoyalty = (traderId: string, ll: number) => {
    persist({ ...profile, loyalty: { ...profile.loyalty, [traderId]: ll } })
  }
  const applyLevel = (lvl: number) => {
    persist({ ...profile, level: lvl })
  }
  const applyLockedMaps = (next: string[]) => {
    persist({ ...profile, lockedMaps: next })
  }
  const toggleMapLocked = (id: string, locked: boolean) => {
    const cur = profile.lockedMaps ?? []
    const next = locked ? [...new Set([...cur, id])] : cur.filter((m) => m !== id)
    applyLockedMaps(next)
  }
  // 变体组整体切换：勾选=全部解锁，取消=全部锁定
  const toggleMapGroup = (ids: string[], locked: boolean) => {
    const cur = profile.lockedMaps ?? []
    const next = locked
      ? [...new Set([...cur, ...ids])]
      : cur.filter((m) => !ids.includes(m))
    applyLockedMaps(next)
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-[1400px] mx-auto px-6 py-6">
        <div className="text-[17px] font-medium mb-1" style={{ paddingLeft: topPad }}>
          角色管理
        </div>

        {/* 角色 + 商人好感：卡片网格，从左向右排列、排不下自动换行（尺寸一致） */}
        <div className="mt-6 grid gap-2.5" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(230px, 1fr))' }}>
          {/* 角色等级卡片 */}
          <div className="rounded-lg border border-line bg-ink-800/60 px-3 py-2.5">
            <div className="flex items-center gap-2 mb-2">
              <span className="text-[15px] text-[#e6edf3]">玩家</span>
              <span className="px-2 py-[1px] rounded-full bg-amber/10 border border-amber/40 text-amber text-[13px] tabular-nums">
                Lv.{profile.level}
              </span>
            </div>
            <div className="text-[13px] text-muted mb-1">当前等级：</div>
            <HorizontalNumberScroller min={1} max={80} value={profile.level} onChange={applyLevel} />
          </div>

          {TRADERS.map((t) => {
            const av = traderImage(t.id)
            const cur = profile.loyalty[t.id] ?? 1
            return (
              <div
                key={t.id}
                className={`flex flex-col gap-2 rounded-lg border px-3 py-2.5 min-h-[116px] justify-between ${
                  t.special ? 'border-dashed' : ''
                } ${cur === 0 ? 'border-red-500/40 bg-red-500/5' : 'border-line bg-ink-800/60'}`}
              >
                {/* 上：头像 + 名称 + 未解锁 Tag */}
                <div className="flex items-center gap-2.5 min-w-0">
                  {av ? (
                    <img
                      src={av}
                      alt={t.name}
                      className={`w-10 h-10 rounded-full object-cover border border-line shrink-0 ${
                        cur === 0 ? 'grayscale opacity-50' : ''
                      }`}
                    />
                  ) : (
                    <span className="w-10 h-10" />
                  )}
                  <span
                    className={`text-[15px] truncate flex-1 min-w-0 ${
                      cur === 0
                        ? 'text-muted line-through decoration-red-400/60'
                        : 'text-[#e6edf3]'
                    }`}
                    title={`${t.name}${t.unlockQuestId ? ' · 有解锁任务依赖' : ''}`}
                  >
                    {t.zh}
                  </span>
                  {cur === 0 && (
                    <span className="shrink-0 text-[12px] px-1.5 py-0.5 rounded bg-red-500/15 text-red-300 border border-red-500/40">
                      未解锁
                    </span>
                  )}
                </div>

                {/* 下：忠诚等级按钮组 */}
                {/* 下：忠诚等级按钮组（宽度由文字撑开，不换行；放不下自动换行排列） */}
                <div className="flex items-center gap-1 flex-wrap">
                  {[0, 1, 2, 3, 4].map((ll) => (
                    <button
                      key={ll}
                      type="button"
                      onClick={() => applyLoyalty(t.id, ll)}
                      title={`${t.name} 忠诚等级 / 解锁状态`}
                      className={`whitespace-nowrap px-1.5 py-1 rounded text-[13px] leading-none border transition-colors ${
                        cur === ll
                          ? 'bg-amber text-black border-amber'
                          : 'bg-ink-700 border-line text-muted hover:text-[#e6edf3]'
                      }`}
                    >
                      {ll === 0 ? '未解锁' : `LL${ll}`}
                    </button>
                  ))}
                </div>
              </div>
            )
          })}
        </div>

        {/* 地图解锁管理：未勾选 = 该地图已锁定，相关任务在「专注模式」与「地图解锁」筛选下不显示 */}
        <div className="mt-7">
          <label className="text-[14px] text-muted block mb-1.5">地图解锁</label>
          <div className="text-[13px] text-muted mb-2 leading-relaxed">
            勾选表示该地图已解锁；未勾选的地图会视为「已锁定」，其任务在开启「专注模式」或「地图解锁」筛选时被隐藏。
          </div>
          {maps.length === 0 ? (
            <div className="text-[14px] text-muted">加载地图列表…</div>
          ) : (
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-1.5">
              {MAP_DISPLAY_ORDER.map((row) => {
                const lockedList = profile.lockedMaps ?? []
                const unlocked =
                  row.type === 'group'
                    ? row.ids.some((id) => !lockedList.includes(id))
                    : !lockedList.includes(row.ids[0])
                const title =
                  row.type === 'group'
                    ? `包含：${maps
                        .filter((m) => row.ids.includes(m.id))
                        .map((m) => m.name)
                        .join('、')}`
                    : ''
                return (
                  <label
                    key={row.label}
                    title={title}
                    className="flex items-center gap-2 text-[14px] text-[#e6edf3] bg-ink-800/60 border border-line rounded px-2 py-1.5 cursor-pointer select-none hover:border-amber/60"
                  >
                    <input
                      type="checkbox"
                      checked={unlocked}
                      onChange={(e) =>
                        row.type === 'group'
                          ? toggleMapGroup(row.ids, !e.target.checked)
                          : toggleMapLocked(row.ids[0], !e.target.checked)
                      }
                      className="accent-[#ef9f27]"
                    />
                    {row.label}
                  </label>
                )
              })}
            </div>
          )}
        </div>

        <div className="flex items-center gap-3 mt-6 mb-4">
          <span className="text-[14px] text-muted">改动自动保存</span>
          {flash && <span className="text-[14px] text-ok">✓ 已保存</span>}
        </div>
      </div>
    </div>
  )
}

/**
 * 横向数字滚轮选择器：数字从左到右排列，按住左右拖拽滚动，
 * 中间高亮当前值，前后各显示 2 个数字（视窗共 5 个），松手吸附选中。
 */
function HorizontalNumberScroller({
  min,
  max,
  value,
  onChange,
  itemW = 46,
}: {
  min: number
  max: number
  value: number
  onChange: (v: number) => void
  itemW?: number
}) {
  const count = max - min + 1
  const visible = 5
  const viewportW = visible * itemW
  const centerX = (visible / 2) * itemW
  const clamp = (v: number) => Math.max(min, Math.min(max, v))
  // 让值 sel 居中时的轨道偏移（轨道索引 = sel - min）
  const baseTranslate = (sel: number) => centerX - ((sel - min) * itemW + itemW / 2)
  // 由偏移反推选中下标（0-based）
  const indexFromTranslate = (t: number) =>
    Math.round((visible / 2 - 0.5) - t / itemW)

  const [display, setDisplay] = useState(value)
  const [translate, setTranslate] = useState(() => baseTranslate(value))
  const [dragging, setDragging] = useState(false)
  const drag = useRef<{ startX: number; startTranslate: number; moved: boolean } | null>(null)
  const viewportRef = useRef<HTMLDivElement | null>(null)

  // 外部值变化（且非拖拽中）时同步
  useEffect(() => {
    if (!dragging) {
      setDisplay(value)
      setTranslate(baseTranslate(value))
    }
  }, [value, dragging])

  const onPointerDown = (e: ReactPointerEvent) => {
    ;(e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId)
    drag.current = { startX: e.clientX, startTranslate: translate, moved: false }
    setDragging(true)
  }

  const onPointerMove = (e: ReactPointerEvent) => {
    if (!drag.current) return
    const dx = e.clientX - drag.current.startX
    if (Math.abs(dx) > 3) drag.current.moved = true
    const next = drag.current.startTranslate + dx
    setTranslate(next)
    setDisplay(clamp(min + indexFromTranslate(next)))
  }

  const onPointerUp = (e: ReactPointerEvent) => {
    if (!drag.current) return
    const moved = drag.current.moved
    drag.current = null
    setDragging(false)

    let target = display
    // 未拖动（视为点击）：按点击位置相对中心偏移选择附近数字
    if (!moved) {
      const rect = viewportRef.current?.getBoundingClientRect()
      if (rect) {
        const offset = e.clientX - (rect.left + rect.width / 2)
        target = clamp(display + Math.round(offset / itemW))
      }
    }
    target = clamp(target)
    setTranslate(baseTranslate(target))
    setDisplay(target)
    onChange(target)
  }

  return (
    <div className="select-none">
      <div
        ref={viewportRef}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        className={`relative overflow-hidden mx-auto ${dragging ? 'cursor-grabbing' : 'cursor-grab'}`}
        style={{ width: viewportW, height: 56, touchAction: 'none' }}
      >
        {/* 居中高亮选中框（前后各 2 个数字，共 5 个可见） */}
        <div
          className="absolute top-1 bottom-1 left-1/2 -translate-x-1/2 rounded-lg border border-amber/60 bg-amber/10 pointer-events-none"
          style={{ width: itemW }}
        />
        {/* 数字轨道 */}
        <div
          className="flex h-full items-center"
          style={{
            transform: `translateX(${translate}px)`,
            transition: dragging ? 'none' : 'transform 0.18s ease-out',
          }}
        >
          {Array.from({ length: count }, (_, i) => {
            const n = min + i
            const active = n === display
            return (
              <div
                key={n}
                className="flex items-center justify-center shrink-0"
                style={{ width: itemW, height: '100%' }}
              >
                <span
                  className={`text-[15px] tabular-nums transition-all ${
                    active ? 'text-amber font-semibold scale-125' : 'text-muted'
                  }`}
                >
                  {n}
                </span>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
