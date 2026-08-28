import type { PlayerQuest } from '../types'
import { openUrl } from '../tauri'
import { useStore } from '../store'
import { traderImage } from '../traderImages'

export function QuestCard({ quest }: { quest: PlayerQuest }) {
  const completed = quest.status === 'completed'
  const avatar = traderImage(quest.traderId)
  const openWiki = useStore((s) => s.openWiki)

  return (
    <div className="bg-ink-800 border border-line rounded-xl p-4">
      <div className="flex items-start gap-3">
        <div className="flex-1 min-w-0">
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
              <span className="px-2 py-0.5 rounded text-[11px] border border-amber text-amber bg-amber-soft">
                {quest.traderName.toUpperCase()}
              </span>
            )}
          </div>
          <div className="mt-1 text-[11px] text-muted">
            {quest.acceptedAt && <span>接取 {quest.acceptedAt}</span>}
            {quest.completedAt && <span> · 完成 {quest.completedAt}</span>}
            {quest.minLevel != null && <span> · 最低 Lv{quest.minLevel}</span>}
          </div>
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

      <div className="mt-2 flex items-center justify-between">
        <span className="text-[11px] text-muted truncate font-mono">{quest.questId}</span>
        {quest.wiki && (
          <>
            <button
              onClick={() => openWiki(quest.wiki)}
              className="text-[11px] text-amber hover:underline shrink-0 ml-2"
            >
              查看资料
            </button>
            <button
              onClick={() => openUrl(quest.wiki)}
              className="text-[11px] text-muted hover:text-[#e6edf3] hover:underline shrink-0 ml-2"
              title="在系统浏览器打开"
            >
              ↗
            </button>
          </>
        )}
      </div>
    </div>
  )
}
