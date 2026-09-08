import { useEffect, useState } from 'react'
import { useStore } from '../store'
import { getLanConnStatus, onLanStatus, type LanConnStatus } from '../lan'
import { TraderTabs } from '../components/TraderTabs'
import { FilterBar } from '../components/FilterBar'
import { QuestList } from '../components/QuestList'
import { ActivityFeed } from '../components/ActivityFeed'

export function MonitorPage() {
  const watcher = useStore((s) => s.watcher)
  const [lanConn, setLanConn] = useState<LanConnStatus>(getLanConnStatus())
  useEffect(() => onLanStatus(setLanConn), [])

  // 本机监控（桌面端）；手机端已连接电脑时，watcher 为 WS 同步来的电脑端真实状态
  const localLive = watcher.watching && !watcher.error
  const connected = lanConn === 'connected'
  const live = connected ? watcher.watching && !watcher.error : localLive

  const statusText = connected
    ? watcher.watching
      ? '电脑端监控中'
      : '电脑端未监控'
    : localLive
      ? '实时识别中'
      : '未监控'

  return (
    <div className="h-full relative flex">
      {/* 左侧商人筛选 tab 列（全部 + 各商人头像） */}
      <TraderTabs />
      {/* 右侧内容：筛选栏 + 任务列表（随左侧选中商人过滤） */}
      <div className="flex-1 min-w-0 h-full overflow-y-auto p-4 space-y-4">
        <div className="flex items-center gap-2">
          <h1 className="text-[17px] font-medium">监控</h1>
          <span className={`text-[13px] flex items-center gap-1.5 ${live ? 'text-ok' : 'text-muted'}`}>
            <span className={`w-1.5 h-1.5 rounded-full ${live ? 'bg-ok' : 'bg-red-500'}`} />
            {statusText}
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
