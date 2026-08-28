import { useCallback, useEffect, useRef, useState } from 'react'
import { useStore } from '../store'
import { saveSettings, getMaps } from '../tauri'
import { traderImage } from '../traderImages'
import { TRADERS } from '../traderMeta'
import type { PlayerProfile, MapInfo } from '../types'

export function ProfilePage() {
  const settings = useStore((s) => s.settings)
  const setSettings = useStore((s) => s.setSettings)

  const [profile, setProfile] = useState<PlayerProfile>(
    settings.profile ?? { level: 1, loyalty: {}, lockedMaps: [] },
  )
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

  // 任意改动后自动保存（无需点「保存」按钮）
  const persist = useCallback(
    (next: PlayerProfile) => {
      setProfile(next)
      setFlash(true)
      if (flashTimer.current) window.clearTimeout(flashTimer.current)
      flashTimer.current = window.setTimeout(() => setFlash(false), 1500)
      saveSettings(
        settings.logDir,
        settings.screenshotDir,
        settings.deleteScreenshots,
        next,
      )
        .then(setSettings)
        .catch((e) => console.error('保存角色失败', e))
    },
    [settings.logDir, settings.screenshotDir, settings.deleteScreenshots, setSettings],
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

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-[720px] mx-auto px-6 py-6">
        <div className="text-[15px] font-medium mb-1">角色管理</div>
        <div className="text-[12px] text-muted mb-5 leading-relaxed">
          日志中不含好感度信息，需在此维护；点击商人右侧按钮即可切换忠诚等级 / 解锁状态，改动自动保存。
          任务图谱默认只显示「好感达标」的任务。标为「未解锁」的商人，其全部任务会被隐藏
          （如 Jaeger 需完成机械师「介绍」任务后解锁）。商人对应任务在图谱中还会排在解锁任务右侧。
        </div>

        <label className="text-[12px] text-muted block mb-1.5">玩家等级</label>
        <input
          type="number"
          min={1}
          max={80}
          value={profile.level}
          onChange={(e) => {
            applyLevel(Math.max(1, Math.min(80, Number(e.target.value) || 1)))
          }}
          className="w-28 bg-ink-700 border border-line rounded px-2 py-1.5 text-[13px] text-[#e6edf3]"
        />

        <div className="mt-6 space-y-2">
          {TRADERS.map((t) => {
            const av = traderImage(t.id)
            const cur = profile.loyalty[t.id] ?? 1
            return (
              <div
                key={t.id}
                className={`flex items-center gap-3 rounded-lg border px-3 py-2 ${
                  t.special ? 'border-dashed' : ''
                } ${cur === 0 ? 'border-red-500/40 bg-red-500/5' : 'border-line bg-ink-800/60'}`}
              >
                {av ? (
                  <img
                    src={av}
                    alt={t.name}
                    className={`w-9 h-9 rounded-full object-cover border border-line shrink-0 ${
                      cur === 0 ? 'grayscale opacity-50' : ''
                    }`}
                  />
                ) : (
                  <span className="w-9 h-9" />
                )}
                <span
                  className={`text-[13px] truncate flex-1 min-w-0 ${
                    cur === 0 ? 'text-muted line-through decoration-red-400/60' : 'text-[#e6edf3]'
                  }`}
                  title={`${t.name}${t.unlockQuestId ? ' · 有解锁任务依赖' : ''}`}
                >
                  {t.zh}
                  {cur === 0 && (
                    <span className="ml-2 text-[10px] px-1.5 py-0.5 rounded bg-red-500/15 text-red-300 border border-red-500/40 align-middle">
                      未解锁
                    </span>
                  )}
                </span>
                <div className="flex items-center gap-1 shrink-0">
                  {[0, 1, 2, 3, 4].map((ll) => (
                    <button
                      key={ll}
                      type="button"
                      onClick={() => applyLoyalty(t.id, ll)}
                      title={`${t.name} 忠诚等级 / 解锁状态`}
                      className={`px-2 py-1 rounded text-[11px] border transition-colors ${
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
          <label className="text-[12px] text-muted block mb-1.5">地图解锁</label>
          <div className="text-[11px] text-muted mb-2 leading-relaxed">
            勾选表示该地图已解锁；未勾选的地图会视为「已锁定」，其任务在开启「专注模式」或「地图解锁」筛选时被隐藏。
          </div>
          {maps.length === 0 ? (
            <div className="text-[12px] text-muted">加载地图列表…</div>
          ) : (
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-1.5">
              {maps.map((m) => {
                const locked = (profile.lockedMaps ?? []).includes(m.id)
                return (
                  <label
                    key={m.id}
                    className="flex items-center gap-2 text-[12px] text-[#e6edf3] bg-ink-800/60 border border-line rounded px-2 py-1.5 cursor-pointer select-none hover:border-amber/60"
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
          <span className="text-[12px] text-muted">改动自动保存</span>
          {flash && <span className="text-[12px] text-ok">✓ 已保存</span>}
        </div>
      </div>
    </div>
  )
}
