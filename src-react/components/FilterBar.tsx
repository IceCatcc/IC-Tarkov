import { useMemo } from 'react'
import { useStore } from '../store'

export function FilterBar() {
  const filter = useStore((s) => s.filter as 'all' | 'in_progress' | 'completed')
  const setFilter = useStore((s) => s.setFilter)
  // 任务关键字：在已选分类（进行中 / 已完成 / 全部）内再过滤
  const search = useStore((s) => s.searchMonitor)
  const setSearch = useStore((s) => s.setSearchMonitor)
  const mapFilter = useStore((s) => s.mapFilter)
  const setMapFilter = useStore((s) => s.setMapFilter)
  const traderFilter = useStore((s) => s.traderFilter)
  const list = useStore((s) => s.playerQuests)
  const mapNames = useStore((s) => s.mapNames)

  // 地图选项：来自任务自带的地图 id（显示中文名）
  const maps = useMemo(() => {
    const set = new Set<string>()
    for (const q of list) for (const m of q.maps ?? []) if (m) set.add(m)
    return Array.from(set).sort((a, b) =>
      (mapNames[a] ?? a).localeCompare(mapNames[b] ?? b, 'zh'),
    )
  }, [list, mapNames])

  // 分类计数：先按商人 tab 过滤（与右侧任务列表口径一致），再按状态统计
  const counted = traderFilter ? list.filter((q) => q.traderName === traderFilter) : list
  const counts = {
    in_progress: counted.filter((q) => q.status === 'in_progress').length,
    completed: counted.filter((q) => q.status === 'completed').length,
    all: counted.length,
  }

  const chips = [
    { k: 'in_progress', label: '进行中' },
    { k: 'completed', label: '已完成' },
    { k: 'all', label: '全部' },
  ] as const

  return (
    <div className="flex items-center gap-2 flex-wrap">
      {chips.map((c) => (
        <button
          key={c.k}
          onClick={() => setFilter(c.k)}
          className={`rounded-lg font-medium border px-2.5 py-1 text-[13px] sm:px-4 sm:py-2 sm:text-[16px] ${
            filter === c.k
              ? 'bg-amber-soft border-amber text-amber'
              : 'bg-ink-800 border-line text-muted hover:text-[#e6edf3]'
          }`}
        >
          {c.label} {counts[c.k]}
        </button>
      ))}
      <input
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        placeholder="搜索任务名"
        title="在当前分类内按任务名过滤"
        className="ml-auto bg-ink-800 border border-line text-[14px] rounded px-2 py-1.5 text-[#e6edf3] placeholder:text-muted/70 w-[180px]"
      />
      <select
        value={mapFilter}
        onChange={(e) => setMapFilter(e.target.value)}
        className="bg-ink-800 border border-line text-[14px] rounded px-2 py-1.5 text-muted"
        title="按地图筛选任务"
      >
        <option value="">全部地图</option>
        {maps.map((m) => (
          <option key={m} value={m}>
            {mapNames[m] ?? m}
          </option>
        ))}
      </select>
    </div>
  )
}
