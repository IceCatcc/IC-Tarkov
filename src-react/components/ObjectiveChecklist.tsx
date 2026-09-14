import type { ObjectiveInfo } from '../types'
import { useObjectivesDone, useStore } from '../store'

/**
 * 任务目标列表：每个目标可单独勾选完成（进度按任务模式持久化在后端）。
 * 勾选只影响玩家自己记录的进度，不改变任务的接取 / 完成状态。
 *
 * showHeader：额外渲染「目标 已完成/总数」标题行（任务链详情面板用）。
 */
export function ObjectiveChecklist({
  questId,
  objectives,
  showHeader,
  gap = 'space-y-1',
}: {
  questId: string
  objectives: ObjectiveInfo[]
  showHeader?: boolean
  /** li 之间的间距（各页面排版略有差异） */
  gap?: string
}) {
  const done = useObjectivesDone(questId)
  const toggleObjective = useStore((s) => s.toggleObjective)

  return (
    <div>
      {showHeader && (
        <div className="text-[13px] text-muted mb-1">
          目标
          <span className="ml-1 text-muted/80">
            {done.size}/{objectives.length}
          </span>
        </div>
      )}
      <ul className={`${gap} text-[14px] text-[#c9d1d9]`}>
        {objectives.map((o) => {
          const checked = done.has(o.id)
          return (
            <li key={o.id || o.description}>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation()
                  void toggleObjective(questId, o.id, !checked)
                }}
                title={checked ? '点击取消该目标的完成标记' : '点击标记该目标为已完成'}
                className="flex items-start gap-1.5 w-full text-left group"
              >
                <span
                  className={`mt-[3px] shrink-0 w-3.5 h-3.5 rounded-[3px] border grid place-items-center transition-colors ${
                    checked
                      ? 'bg-[#2ea043] border-[#2ea043]'
                      : 'border-line group-hover:border-amber/70'
                  }`}
                >
                  {checked && (
                    <span className="text-[10px] leading-none text-white select-none">✓</span>
                  )}
                </span>
                <span className={`leading-snug ${checked ? 'line-through text-muted' : ''}`}>
                  {o.description}
                  {o.count != null && o.count > 0 && (
                    <span className="text-amber">（{o.count}）</span>
                  )}
                </span>
              </button>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
