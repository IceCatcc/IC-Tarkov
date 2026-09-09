import { useEffect, useRef, useState } from 'react'
import { useStore } from '../store'
import { catKey, resolveChipOn, subKey, type IconGroup } from '../mapIconGroups'

/**
 * 三态选择框：全选 / 部分选中（indeterminate）/ 全不选。
 * 点击语义：全不选或部分选中 → 全选；全选 → 全不选。
 */
function TriState({
  checked,
  partial,
  onChange,
  title,
}: {
  checked: boolean
  partial: boolean
  onChange: (next: boolean) => void
  title?: string
}) {
  const ref = useRef<HTMLInputElement | null>(null)
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = partial
  }, [partial])
  return (
    <input
      ref={ref}
      type="checkbox"
      checked={checked}
      onChange={(e) => onChange(e.target.checked)}
      title={title}
      className="w-3.5 h-3.5 accent-amber"
    />
  )
}

/**
 * 地图「图标」筛选面板（参考 tarkov.dev 的地图筛选）：
 * - 一级：图标分类（撤离点 / 出生点 / 容器 / 危险区 / 钥匙锁 …），三态选择框整体开关，可折叠；
 * - 二级：分类下按数据可区分的维度细分（撤离点按阵营、容器按容器类型、锁按名称…），
 *   每个子分类都能单独控制显示隐藏；
 * - 只有一个子分类的分类不再折叠，整行就是开关；
 * - 选择框统一放在文字前；
 * - 「任务目标」不列子项：单个任务的跟踪在右下角任务选单里操作，这里只做整体开关与计数。
 */
export function MapIconPanel({ groups }: { groups: IconGroup[] }) {
  const chips = useStore((s) => s.mapChips)
  const setMapChip = useStore((s) => s.setMapChip)
  const setMapChips = useStore((s) => s.setMapChips)
  const playerQuests = useStore((s) => s.playerQuests)
  const untracked = useStore((s) => s.untrackedQuests)
  const toggleQuestTracked = useStore((s) => s.toggleQuestTracked)
  const [open, setOpen] = useState<Record<string, boolean>>({})

  const toggleOpen = (k: string) => setOpen((o) => ({ ...o, [k]: !o[k] }))

  const ROW = 'flex items-center gap-1.5 w-full px-1.5 py-1 rounded hover:bg-ink-700/70'
  const SUB =
    'flex items-center gap-1.5 pl-5 pr-1.5 py-0.5 rounded cursor-pointer hover:bg-ink-700/70'
  const COUNT = 'text-[11px] text-muted/80 w-8 text-right shrink-0'

  /* ---- 任务目标：只做整体开关（单个任务的跟踪在右下角任务选单里） ---- */
  const inProgress = playerQuests.filter((q) => q.status === 'in_progress')
  const trackedCount = inProgress.filter((q) => !untracked.includes(q.questId)).length
  const questsAll = inProgress.length > 0 && trackedCount === inProgress.length
  const questsPartial = trackedCount > 0 && trackedCount < inProgress.length
  const toggleAllQuests = (on: boolean) => {
    for (const q of inProgress) {
      if (untracked.includes(q.questId) !== !on) toggleQuestTracked(q.questId)
    }
    // 全开时顺带打开分类总开关，避免它被旧值（false）挡住导致勾了也不显示
    if (on) setMapChip(catKey('quests'), true)
  }

  return (
    <div className="flex flex-col gap-0.5 p-1.5 w-[240px] max-h-[calc(52dvh/var(--ui-scale,1))] overflow-y-auto rounded-md border border-line bg-ink-800/95 shadow-lg backdrop-blur-sm">
      {inProgress.length > 0 && (
        <div className={ROW}>
          <TriState
            checked={questsAll}
            partial={questsPartial}
            onChange={toggleAllQuests}
            title={`任务目标：${questsAll ? '全部隐藏' : '全部显示'}（单个任务在右下角任务选单里跟踪）`}
          />
          <span className="flex-1 text-left text-[13px] font-medium text-[#e6edf3]">任务目标</span>
          <span className={COUNT}>
            {trackedCount}/{inProgress.length}
          </span>
        </div>
      )}

      {/* ---- 其余图标分类：子项由地图数据派生 ---- */}
      {groups.map((g) => {
        // hidden 子项（共用 / 过境撤离点）不在面板列出，显示与否跟随同分类的其他子项
        const subs = g.subs.filter((s) => !s.hidden)
        if (!subs.length) return null
        // 只有一个子分类时不再折叠：整行就是该子分类的开关
        if (subs.length === 1) {
          const s = subs[0]
          const on = resolveChipOn(chips, subKey(s.key))
          return (
            <div
              key={g.key}
              className={`${ROW} cursor-pointer`}
              onClick={() => setMapChip(subKey(s.key), !on)}
              title={`${g.label}（${s.list.length} 个）`}
            >
              <input
                type="checkbox"
                checked={on}
                onChange={() => setMapChip(subKey(s.key), !on)}
                className="w-3.5 h-3.5 accent-amber pointer-events-none"
              />
              <span
                className={`text-[13px] font-medium flex-1 truncate ${
                  on ? 'text-[#e6edf3]' : 'text-muted'
                }`}
              >
                {g.label}
              </span>
              <span className="text-[11px] text-muted/70 shrink-0">{s.list.length}</span>
            </div>
          )
        }
        const onCount = subs.filter((s) => resolveChipOn(chips, subKey(s.key))).length
        const allOn = onCount === subs.length
        const setAll = (on: boolean) => {
          const patch: Record<string, boolean> = {}
          for (const s of subs) patch[subKey(s.key)] = on
          setMapChips(patch)
        }
        return (
          <div key={g.key} className="flex flex-col">
            <div className={ROW}>
              <TriState
                checked={allOn}
                partial={!allOn && onCount > 0}
                onChange={setAll}
                title={`${g.label}：${allOn ? '全部隐藏' : '全部显示'}`}
              />
              <button
                onClick={() => toggleOpen(g.key)}
                className="flex-1 text-left text-[13px] font-medium text-[#e6edf3]"
              >
                {g.label}
              </button>
              <span className={COUNT}>
                {onCount}/{subs.length}
              </span>
              <button
                onClick={() => toggleOpen(g.key)}
                className="w-3 text-[10px] text-muted shrink-0"
                aria-label="展开/收起"
              >
                {open[g.key] ? '▾' : '▸'}
              </button>
            </div>
            {open[g.key] &&
              subs.map((s) => {
                const on = resolveChipOn(chips, subKey(s.key))
                return (
                  <div
                    key={s.key}
                    className={SUB}
                    onClick={() => setMapChip(subKey(s.key), !on)}
                    title={`${s.label}：${s.list.length} 个`}
                  >
                    <input
                      type="checkbox"
                      checked={on}
                      onChange={() => setMapChip(subKey(s.key), !on)}
                      className="w-3.5 h-3.5 accent-amber pointer-events-none"
                    />
                    <span
                      className={`text-[12px] truncate flex-1 ${
                        on ? 'text-[#e6edf3]' : 'text-muted'
                      }`}
                    >
                      {s.label}
                    </span>
                    <span className="text-[11px] text-muted/70 shrink-0">{s.list.length}</span>
                  </div>
                )
              })}
          </div>
        )
      })}

      {groups.length === 0 && inProgress.length === 0 && (
        <div className="px-2 py-1 text-[12px] text-muted">当前地图没有可显示的图标</div>
      )}
    </div>
  )
}
