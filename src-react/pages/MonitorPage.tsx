import { useStore } from '../store'
import { FilterBar } from '../components/FilterBar'
import { QuestList } from '../components/QuestList'
import { ActivityFeed } from '../components/ActivityFeed'

export function MonitorPage() {
  const live = useStore((s) => s.watcher.watching && !s.watcher.error)

  return (
    <div className="h-full relative">
      <div className="h-full overflow-y-auto p-4 space-y-4">
        <div className="flex items-center gap-2">
          <h1 className="text-[17px] font-medium">监控</h1>
          <span className={`text-[13px] ${live ? 'text-ok' : 'text-muted'}`}>
            {live ? '实时识别中' : '未监控'}
          </span>
        </div>
        <FilterBar />
        <QuestList />
      </div>
      {/* 实时活动抽屉：浮动按钮展开，不挤压内容 */}
      <ActivityFeed />
    </div>
  )
}
