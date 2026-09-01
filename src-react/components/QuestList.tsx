import { useStore } from '../store'
import { QuestCard } from './QuestCard'

export function QuestList() {
  const list = useStore((s) => s.playerQuests)
  const filter = useStore((s) => s.filter)
  const traderFilter = useStore((s) => s.traderFilter)
  const mapFilter = useStore((s) => s.mapFilter)

  const filtered = list
    .filter((q) => (filter === 'all' ? true : q.status === filter))
    .filter((q) => (traderFilter ? q.traderName === traderFilter : true))
    // 地图过滤：未知地图（maps 为空，多为刚接取尚未回刷的任务）保持显示，避免被隐藏
    .filter((q) =>
      mapFilter ? (q.maps ?? []).length === 0 || (q.maps ?? []).includes(mapFilter) : true,
    )
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
