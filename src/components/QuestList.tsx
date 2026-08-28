import { useStore } from '../store'
import { QuestCard } from './QuestCard'

export function QuestList() {
  const list = useStore((s) => s.playerQuests)
  const filter = useStore((s) => s.filter)
  const traderFilter = useStore((s) => s.traderFilter)

  const filtered = list
    .filter((q) => (filter === 'all' ? true : q.status === filter))
    .filter((q) => (traderFilter ? q.traderName === traderFilter : true))
    .sort((a, b) => {
      if (a.status !== b.status) return a.status === 'in_progress' ? -1 : 1
      return (b.acceptedAt ?? '').localeCompare(a.acceptedAt ?? '')
    })

  if (filtered.length === 0) {
    return (
      <div className="text-[14px] text-muted py-10 text-center">
        暂无任务记录。开始监控后将自动识别接取 / 完成事件。
      </div>
    )
  }

  return (
    <div className="space-y-3">
      {filtered.map((q) => (
        <QuestCard key={q.questId} quest={q} />
      ))}
    </div>
  )
}
