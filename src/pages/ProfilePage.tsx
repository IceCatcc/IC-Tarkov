import { useCallback, useEffect, useRef, useState } from 'react'
import { useStore, useTopPad } from '../store'
import { saveSettings, getMaps } from '../tauri'
import { traderImage } from '../traderImages'
import { TRADERS } from '../traderMeta'
import type { PlayerProfile, MapInfo } from '../types'

// 地图解锁里需要合并显示/统一切换的变体组（同组任一勾选即视为已解锁）
// 工厂：白天工厂 + 夜间工厂；实验室：实验室 + 实验室 (Dark)；中心区：中心区 + 中心区 21+
const MAP_GROUPS: { label: string; ids: string[] }[] = [
  { label: '工厂', ids: ['55f2d3fd4bdc2d5f408b4567', '59fc81d786f774390775787e'] },
  { label: '实验室', ids: ['5b0fc42d86f7744a585f9105', '6a294a5b5eb5f9a1700417b7'] },
  { label: '中心区', ids: ['653e6760052c01c1c805532f', '65b8d6f5cdde2479cb2a3125'] },
]
const GROUPED_IDS = new Set(MAP_GROUPS.flatMap((g) => g.ids))

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

        <label className="text-[14px] text-muted block mb-1.5">玩家等级</label>
        <input
          type="number"
          min={1}
          max={80}
          value={profile.level}
          onChange={(e) => {
            applyLevel(Math.max(1, Math.min(80, Number(e.target.value) || 1)))
          }}
          className="w-28 bg-ink-700 border border-line rounded px-2 py-1.5 text-[15px] text-[#e6edf3]"
        />

        {/* 商人好感：卡片网格，从左向右排列、排不下自动换行 */}
        <div className="mt-6 grid gap-2.5" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(210px, 1fr))' }}>
          {TRADERS.map((t) => {
            const av = traderImage(t.id)
            const cur = profile.loyalty[t.id] ?? 1
            return (
              <div
                key={t.id}
                className={`flex flex-col gap-2 rounded-lg border px-3 py-2.5 ${
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
              {/* 合并后的变体组（工厂 / 实验室 / 中心区），统一切换 */}
              {MAP_GROUPS.map((g) => {
                const lockedList = profile.lockedMaps ?? []
                // 组内任一未锁定即视为已解锁
                const unlocked = g.ids.some((id) => !lockedList.includes(id))
                const variants = maps
                  .filter((m) => g.ids.includes(m.id))
                  .map((m) => m.name)
                return (
                  <label
                    key={g.label}
                    title={`包含：${variants.join('、')}`}
                    className="flex items-center gap-2 text-[14px] text-[#e6edf3] bg-ink-800/60 border border-line rounded px-2 py-1.5 cursor-pointer select-none hover:border-amber/60"
                  >
                    <input
                      type="checkbox"
                      checked={unlocked}
                      onChange={(e) => toggleMapGroup(g.ids, !e.target.checked)}
                      className="accent-[#ef9f27]"
                    />
                    {g.label}
                  </label>
                )
              })}
              {/* 其余地图（不含已合并的变体） */}
              {maps
                .filter((m) => !GROUPED_IDS.has(m.id))
                .map((m) => {
                  const locked = (profile.lockedMaps ?? []).includes(m.id)
                  return (
                    <label
                      key={m.id}
                      className="flex items-center gap-2 text-[14px] text-[#e6edf3] bg-ink-800/60 border border-line rounded px-2 py-1.5 cursor-pointer select-none hover:border-amber/60"
                    >
                      <input
                        type="checkbox"
                        checked={!locked}
                        onChange={(e) => toggleMapLocked(m.id, !e.target.checked)}
                        className="accent-[#ef9f27]"
                      />
                      {m.name}
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
