import { useStore } from '../store'

export function ActivityFeed() {
  const activities = useStore((s) => s.activities)
  const color = (k: string) =>
    k === 'complete' ? 'text-ok' : k === 'accept' ? 'text-amber' : 'text-muted'

  return (
    <aside className="w-[220px] shrink-0 bg-ink-800 border-l border-line p-3 overflow-y-auto">
      <div className="text-[13px] font-medium mb-3">实时活动</div>
      <div className="space-y-2">
        {activities.length === 0 && (
          <div className="text-[11px] text-muted">等待事件…</div>
        )}
        {activities.map((a) => (
          <div key={a.id} className="text-[11px] leading-relaxed break-words">
            <span className="text-muted">{a.ts} </span>
            <span className={color(a.kind)}>{a.text}</span>
          </div>
        ))}
      </div>
    </aside>
  )
}
