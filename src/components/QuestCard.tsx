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
      {/* 同一行：头像 + 标题 + 商人徽章 + 弱化的时间 + 状态药丸 */}
      <div className="flex items-center gap-2">
        {avatar && (
          <img
            src={avatar}
            alt={quest.traderName}
            className="w-6 h-6 rounded-full object-cover border border-line shrink-0"
          />
        )}
        <span className="text-[14px] font-medium truncate">{quest.name}</span>
        {quest.traderName && (
          <span className="px-2 py-0.5 rounded text-[11px] border border-amber text-amber bg-amber-soft shrink-0">
            {quest.traderName.toUpperCase()}
          </span>
        )}
        <div className="ml-auto flex items-center gap-2 shrink-0">
          <div className="text-[10px] text-muted/60 leading-tight whitespace-nowrap">
            {quest.acceptedAt && <span>接取 {quest.acceptedAt}</span>}
            {quest.completedAt && <span> · 完成 {quest.completedAt}</span>}
            {quest.minLevel != null && <span> · 最低 Lv{quest.minLevel}</span>}
          </div>
          <span
            className={`px-2 py-0.5 rounded-full text-[11px] border shrink-0 ${
              completed
                ? 'bg-[#1b1f24] border-done text-muted'
                : 'bg-blue-soft border-blue text-blue'
            }`}
          >
            {completed ? '已完成' : '进行中'}
          </span>
        </div>
      </div>

      {/* 任务目标 */}
      {detail?.objectives?.length ? (
        <div className="mt-3 pt-3 border-t border-line">
          <ul className="space-y-1 text-[12px] text-[#c9d1d9]">
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
                <span className="truncate max-w-[110px] text-[12px]">
                  {it.name}
                </span>
                {it.count != null && it.count > 0 && (
                  <span className="text-amber shrink-0">×{it.count}</span>
                )}
              </span>
            ))}
            {items.length > 12 && (
              <span className="text-[12px] text-muted self-center">
                +{items.length - 12}
              </span>
            )}
          </div>
        </div>
      )}

      {/* 奖励 */}
      {detail?.rewards?.length ? (
        <div className="mt-3 pt-3 border-t border-line">
          <div className="text-[12px] text-[#c9d1d9]">
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
