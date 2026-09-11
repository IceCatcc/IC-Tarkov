import { useEffect, useState } from 'react'
import { useStore } from '../store'
import { QuestCard } from './QuestCard'

/** 每次渲染的任务数（与任务板一致），点击「加载更多」再追加一页 */
const PAGE = 60

export function QuestList() {
  const list = useStore((s) => s.playerQuests)
  const filter = useStore((s) => s.filter)
  const traderFilter = useStore((s) => s.traderFilter)
  const mapFilter = useStore((s) => s.mapFilter)
  // 关键字：在已选分类内按任务名过滤（不含商人）
  const search = useStore((s) => s.searchMonitor).trim().toLowerCase()
  // 分页：任务多时不再一次性铺开全部卡片
  const [limit, setLimit] = useState(PAGE)

  const filtered = list
    .filter((q) => (filter === 'all' ? true : q.status === filter))
    .filter((q) => (traderFilter ? q.traderName === traderFilter : true))
    .filter((q) => (search ? (q.name ?? '').toLowerCase().includes(search) : true))
    // 地图过滤：未知地图（maps 为空，多为刚接取尚未回刷的任务）保持显示，避免被隐藏
    .filter((q) =>
      mapFilter ? (q.maps ?? []).length === 0 || (q.maps ?? []).includes(mapFilter) : true,
    )
    .sort((a, b) => {
      if (a.status !== b.status) return a.status === 'in_progress' ? -1 : 1
      // 已完成：按完成时间倒序（最近完成的在最上面）；缺失完成时间时退化为接取时间
      if (a.status === 'completed') {
        const ta = a.completedAt ?? a.acceptedAt ?? ''
        const tb = b.completedAt ?? b.acceptedAt ?? ''
        return tb.localeCompare(ta)
      }
      return (b.acceptedAt ?? '').localeCompare(a.acceptedAt ?? '')
    })

  // 筛选条件或数据来源（切模式 / 新事件）变化时回到第一页
  useEffect(() => {
    setLimit(PAGE)
  }, [filter, traderFilter, search, mapFilter, list])

  if (filtered.length === 0) {
    return (
      <div className="text-[14px] text-muted py-10 text-center">
        暂无任务记录。开始监控后将自动识别接取 / 完成事件。
      </div>
    )
  }

  const shown = filtered.slice(0, limit)

  return (
    <div className="space-y-3">
      {shown.map((q) => (
        <QuestCard key={q.questId} quest={q} />
      ))}
      {filtered.length > limit && (
        <div className="flex justify-center py-3">
          <button
            onClick={() => setLimit((v) => v + PAGE)}
            className="px-4 py-1.5 rounded border border-line text-[14px] text-muted hover:text-[#e6edf3] hover:bg-ink-700"
          >
            加载更多（还有 {filtered.length - limit} 个）
          </button>
        </div>
      )}
    </div>
  )
}
