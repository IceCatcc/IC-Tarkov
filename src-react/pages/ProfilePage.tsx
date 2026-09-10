import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { useStore, useTopPad } from '../store'
import { saveSettings } from '../tauri'
import { traderImage } from '../traderImages'
import { TRADERS } from '../traderMeta'
import type { PlayerProfile } from '../types'

export function ProfilePage() {
  const settings = useStore((s) => s.settings)
  const setSettings = useStore((s) => s.setSettings)
  // 侧边栏折叠时，顶部标题为左上角浮动按钮预留空位
  const topPad = useTopPad()

  // profile 直接派生自 store（settings.profile），不再用本地 useState——
  // 本地 useState 只在首次挂载取值，若保存失败或设置晚于挂载加载，切页重挂载会回退默认值。
  const profile: PlayerProfile = settings.profile ?? { level: 1, loyalty: {}, lockedMaps: [] }
  const [flash, setFlash] = useState(false)
  const flashTimer = useRef<number | undefined>(undefined)

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

        {/* 地图解锁管理已移除：等级 / LL / 地区等筛选入口都已取消，地图锁定不再参与任何过滤 */}

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
