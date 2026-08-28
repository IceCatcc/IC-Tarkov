import { useStore } from '../store'

export function SummaryCards() {
  const list = useStore((s) => s.playerQuests)
  const inProgress = list.filter((q) => q.status === 'in_progress').length
  const completed = list.filter((q) => q.status === 'completed').length
  const total = list.length

  const cards = [
    { label: '进行中', value: inProgress, accent: 'text-blue', ring: 'border-blue/40' },
    { label: '已完成', value: completed, accent: 'text-ok', ring: 'border-ok/40' },
    { label: '总任务', value: total, accent: 'text-[#e6edf3]', ring: 'border-line' },
  ]

  return (
    <div className="grid grid-cols-3 gap-3">
      {cards.map((c) => (
        <div
          key={c.label}
          className={`bg-ink-800 border ${c.ring} rounded-lg p-3`}
        >
          <div className="text-[14px] text-muted">{c.label}</div>
          <div className={`text-[28px] font-medium ${c.accent}`}>{c.value}</div>
        </div>
      ))}
    </div>
  )
}
