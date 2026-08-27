import type { PlayerQuest } from '../types'
import { openUrl } from '../tauri'

export function QuestCard({ quest }: { quest: PlayerQuest }) {
  const completed = quest.status === 'completed'

  return (
    <div className="bg-ink-800 border border-line rounded-xl p-4">
      <div className="flex items-start gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
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
          <button
            onClick={() => openUrl(quest.wiki)}
            className="text-[11px] text-amber hover:underline shrink-0 ml-2"
          >
            打开 Wiki ↗
          </button>
        )}
      </div>
    </div>
  )
}
