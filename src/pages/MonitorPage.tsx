import { useStore } from '../store'
import { SummaryCards } from '../components/SummaryCards'
import { FilterBar } from '../components/FilterBar'
import { QuestList } from '../components/QuestList'
import { ActivityFeed } from '../components/ActivityFeed'

export function MonitorPage() {
  const live = useStore((s) => s.watcher.watching && !s.watcher.error)

  return (
    <div className="h-full flex">
      <div className="flex-1 min-w-0 overflow-y-auto p-4 space-y-4">
        <div className="flex items-center gap-2">
          <h1 className="text-[15px] font-medium">监控</h1>
          <span className={`text-[11px] ${live ? 'text-ok' : 'text-muted'}`}>
            {live ? '实时识别中' : '未监控'}
          </span>
        </div>
        <SummaryCards />
        <FilterBar />
        <QuestList />
      </div>
      <ActivityFeed />
    </div>
  )
}
