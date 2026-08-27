import { useState } from 'react'
import { useStore } from '../store'
import { saveSettings } from '../tauri'
import { traderImage } from '../traderImages'
import { TRADERS } from '../traderMeta'
import type { PlayerProfile } from '../types'

export function ProfilePage() {
  const settings = useStore((s) => s.settings)
  const setSettings = useStore((s) => s.setSettings)

  const [profile, setProfile] = useState<PlayerProfile>(
    settings.profile ?? { level: 1, loyalty: {} },
  )
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)

  const setLoyalty = (traderId: string, ll: number) => {
    setSaved(false)
    setProfile((p) => ({ ...p, loyalty: { ...p.loyalty, [traderId]: ll } }))
  }

  const onSave = async () => {
    setSaving(true)
    try {
      const st = await saveSettings(settings.logDir, settings.screenshotDir, profile)
      setSettings(st)
      setSaved(true)
    } catch (e) {
      console.error('保存角色失败', e)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-[720px] mx-auto px-6 py-6">
        <div className="text-[15px] font-medium mb-1">角色管理</div>
        <div className="text-[12px] text-muted mb-5 leading-relaxed">
          日志中不含好感度信息，需在此手动维护；任务图谱默认只显示「好感达标」的任务。
          标为「未解锁」的商人，其全部任务会被隐藏（如 Jaeger 需完成机械师「介绍」任务后解锁）。
          商人对应任务在图谱中还会排在解锁任务右侧。
        </div>

        <label className="text-[12px] text-muted block mb-1.5">玩家等级</label>
        <input
          type="number"
          min={1}
          max={80}
          value={profile.level}
          onChange={(e) => {
            setSaved(false)
            setProfile((p) => ({
              ...p,
              level: Math.max(1, Math.min(80, Number(e.target.value) || 1)),
            }))
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
                <select
                  value={cur}
                  onChange={(e) => setLoyalty(t.id, Number(e.target.value))}
                  title={`${t.name} 忠诚等级 / 解锁状态`}
                  className="bg-ink-700 border border-line rounded px-2 py-1.5 text-[12px] text-[#e6edf3] shrink-0 w-[110px]"
                >
                  <option value={0}>未解锁</option>
                  <option value={1}>LL1</option>
                  <option value={2}>LL2</option>
                  <option value={3}>LL3</option>
                  <option value={4}>LL4</option>
                </select>
              </div>
            )
          })}
        </div>

        <div className="flex items-center gap-3 mt-6 mb-4">
          <button
            onClick={onSave}
            disabled={saving}
            className="px-5 py-2 rounded bg-amber text-black text-[12px] font-medium hover:opacity-90 disabled:opacity-50"
          >
            {saving ? '保存中…' : '保存'}
          </button>
          {saved && <span className="text-[12px] text-ok">✓ 已保存</span>}
        </div>
      </div>
    </div>
  )
}
