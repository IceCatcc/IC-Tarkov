import type { PlayerQuest } from '../types'
import { useStore, useQuestDetail, dedupeItems } from '../store'
import { traderImage } from '../traderImages'

export function QuestCard({ quest }: { quest: PlayerQuest }) {
  const completed = quest.status === 'completed'
  const avatar = traderImage(quest.traderId)
  const openWiki = useStore((s) => s.openWiki)
  const detail = useQuestDetail(quest.questId)

  // 所需物品（跨目标去重聚合，与任务图谱详情一致）
  const items = dedupeItems(
    (detail?.objectives ?? []).flatMap((o) => o.items ?? []),
  )

  return (
    <div
      className={`bg-ink-800 border border-line rounded-xl p-4 ${
        quest.wiki ? 'cursor-pointer hover:border-amber/60' : ''
      }`}
      onClick={() => quest.wiki && openWiki(quest.wiki)}
      title={quest.wiki ? '点击查看资料' : undefined}
    >
      {/* 第一行：头像 + 任务名（优先显示，加粗加大）+ 状态药丸 */}
      <div className="flex items-center gap-2 min-w-0">
        {avatar && (
          <img
            src={avatar}
            alt={quest.traderName}
            className="w-6 h-6 rounded-full object-cover border border-line shrink-0"
          />
        )}
        <span className="text-[18px] font-semibold truncate min-w-0">{quest.name}</span>
        <span
          className={`ml-auto px-2 py-0.5 rounded-full text-[13px] border shrink-0 ${
            completed
              ? 'bg-[#1b1f24] border-done text-muted'
              : 'bg-blue-soft border-blue text-blue'
          }`}
        >
          {completed ? '已完成' : '进行中'}
        </span>
      </div>

      {/* 第二行：商人名（弱化）+ 时间（最不重要） */}
      <div className="mt-1 flex items-center gap-2 text-[12px] text-muted flex-wrap">
        {quest.traderName && <span>{quest.traderName}</span>}
        {quest.acceptedAt && <span className="text-muted/60">接取 {quest.acceptedAt}</span>}
        {quest.completedAt && <span className="text-muted/60">完成 {quest.completedAt}</span>}
        {quest.minLevel != null && <span className="text-muted/60">最低 Lv{quest.minLevel}</span>}
      </div>

      {/* 任务目标 */}
      {detail?.objectives?.length ? (
        <div className="mt-3 pt-3 border-t border-line">
          <ul className="space-y-1 text-[14px] text-[#c9d1d9]">
            {detail.objectives.map((o, i) => (
              <li key={i} className="leading-snug">
                - {o.description}
                {o.count != null && o.count > 0 && (
                  <span className="text-amber">（{o.count}）</span>
                )}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {/* 所需物品 */}
      {items.length > 0 && (
        <div className="mt-3 pt-3 border-t border-line">
          <div className="flex flex-wrap gap-1.5">
            {items.slice(0, 12).map((it) => (
              <span
                key={it.id}
                className="inline-flex items-center gap-1 rounded bg-ink-700 border border-line pl-0.5 pr-1.5 py-0.5"
                title={`${it.name}${it.count ? ` ×${it.count}` : ''}`}
              >
                <img
                  src={`/item-icons/${it.id}.webp`}
                  alt=""
                  loading="lazy"
                  className="w-3.5 h-3.5 object-contain"
                />
                <span className="truncate max-w-[110px] text-[14px]">
                  {it.name}
                </span>
                {it.count != null && it.count > 0 && (
                  <span className="text-amber shrink-0">×{it.count}</span>
                )}
              </span>
            ))}
            {items.length > 12 && (
              <span className="text-[14px] text-muted self-center">
                +{items.length - 12}
              </span>
            )}
          </div>
        </div>
      )}

      {/* 奖励 */}
      {detail?.rewards?.length ? (
        <div className="mt-3 pt-3 border-t border-line">
          <div className="text-[14px] text-[#c9d1d9]">
            {detail.rewards.map((r, i) => (
              <span key={i}>
                {r.name} ×{r.count}
                {i < detail.rewards.length - 1 ? '、' : ''}
              </span>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  )
}
