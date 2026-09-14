import type { PlayerQuest } from '../types'
import { useStore, useQuestDetail, dedupeItems } from '../store'
import { ObjectiveChecklist } from './ObjectiveChecklist'
import { traderImage } from '../traderImages'
import { traderDisplayName } from '../traderMeta'

/**
 * hideStatus：隐藏状态药丸（如地图浮窗里只列进行中任务，状态无信息量）；
 * tracked / onToggleTrack：传入后标题前显示「罗盘」跟踪按钮（地图浮窗用）
 */
export function QuestCard({
  quest,
  hideStatus,
  tracked,
  onToggleTrack,
}: {
  quest: PlayerQuest
  hideStatus?: boolean
  tracked?: boolean
  onToggleTrack?: () => void
}) {
  const completed = quest.status === 'completed'
  const failed = quest.status === 'failed'
  const avatar = traderImage(quest.traderId)
  // 商人统一展示中文名
  const traderLabel = traderDisplayName(quest.traderId, quest.traderName)
  const openWiki = useStore((s) => s.openWiki)
  const wikiUrlFor = useStore((s) => s.wikiUrlFor)
  const manualSetStatus = useStore((s) => s.manualSetStatus)
  const detail = useQuestDetail(quest.questId)
  // 按设置里的 Wiki 站点生成链接（后端带的是默认站点地址，仅作兜底）
  const url = wikiUrlFor(quest.questId)

  // 所需物品（跨目标去重聚合，与任务图谱详情一致）
  const items = dedupeItems(
    (detail?.objectives ?? []).flatMap((o) => o.items ?? []),
  )

  return (
    <div
      className={`bg-ink-800 border border-line rounded-xl p-4 ${
        url ? 'cursor-pointer hover:border-amber/60' : ''
      }`}
      onClick={() => url && openWiki(url)}
      title={url ? '点击查看资料' : undefined}
    >
      {/* 第一行：跟踪罗盘 + 头像 + 任务名（优先显示，加粗加大）+ 状态药丸 */}
      <div className="flex items-center gap-2 min-w-0">
        {/* 跟踪开关：与地图上的玩家朝向标记同款图标，放在最左（地图浮窗用）。
            跟踪中=正常显示，已取消跟踪=整体变浅 */}
        {onToggleTrack && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation()
              onToggleTrack()
            }}
            title={
              tracked
                ? '正在地图上跟踪该任务的目标（点击取消跟踪）'
                : '已取消跟踪（点击重新跟踪）'
            }
            className={`shrink-0 w-6 h-6 grid place-items-center rounded transition-opacity hover:bg-amber/10 ${
              tracked ? 'opacity-100' : 'opacity-35'
            }`}
          >
            {/* 与地图上「任务目标」标记同一个图标文件 */}
            <img
              src="/maps/interactive/quest_objective.png"
              alt=""
              className="w-5 h-5 object-contain"
            />
          </button>
        )}
        {avatar && (
          <img
            src={avatar}
            alt={traderLabel}
            className="w-6 h-6 rounded-full object-cover border border-line shrink-0"
          />
        )}
        <span className="text-[18px] font-semibold truncate min-w-0">{quest.name}</span>
        <span className="ml-auto flex items-center gap-1.5 shrink-0">
          {!hideStatus && (
            <span
              className={`px-2 py-0.5 rounded-full text-[13px] border ${
                completed
                  ? 'bg-[#1b1f24] border-done text-muted'
                  : failed
                    ? 'bg-[#2b1416] border-[#f85149]/70 text-[#f85149]'
                    : 'bg-blue-soft border-blue text-blue'
              }`}
              title={failed ? '互斥任务已提交，本任务已失败' : undefined}
            >
              {completed ? '已完成' : failed ? '已失败' : '进行中'}
            </span>
          )}
          {/* 手动改状态：进行中 → 手动完成；已完成 → 手动重置为未接取（排最右） */}
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation()
              void manualSetStatus(quest.questId, completed ? 'reset' : 'complete')
            }}
            title={completed ? '重置为未接取（清除接取与完成记录）' : '手动标记该任务为已完成'}
            className={`text-[12px] hover:underline shrink-0 transition-colors ${
              completed ? 'text-muted hover:text-[#e6edf3]' : 'text-[#2ea043] hover:text-[#3fb950]'
            }`}
          >
            {completed ? '手动重置' : '手动完成'}
          </button>
        </span>
      </div>

      {/* 第二行：时间 / 最低等级（商人由首行头像体现） */}
      <div className="mt-1 flex items-center gap-2 text-[12px] text-muted flex-wrap">
        {quest.acceptedAt && <span className="text-muted/60">接取 {quest.acceptedAt}</span>}
        {quest.completedAt && <span className="text-muted/60">完成 {quest.completedAt}</span>}
        {quest.minLevel != null && <span className="text-muted/60">最低 Lv{quest.minLevel}</span>}
      </div>

      {/* 任务目标（可逐个勾选完成） */}
      {detail?.objectives?.length ? (
        <div className="mt-3 pt-3 border-t border-line">
          <ObjectiveChecklist questId={quest.questId} objectives={detail.objectives} />
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
