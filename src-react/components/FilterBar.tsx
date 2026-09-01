import { useMemo } from 'react'
import { useStore } from '../store'

export function FilterBar() {
  const filter = useStore((s) => s.filter as 'all' | 'in_progress' | 'completed')
  const setFilter = useStore((s) => s.setFilter)
  const traderFilter = useStore((s) => s.traderFilter)
  const setTraderFilter = useStore((s) => s.setTraderFilter)
  const mapFilter = useStore((s) => s.mapFilter)
  const setMapFilter = useStore((s) => s.setMapFilter)
  const list = useStore((s) => s.playerQuests)
  const mapNames = useStore((s) => s.mapNames)

  const traders = Array.from(new Set(list.map((q) => q.traderName).filter(Boolean))).sort()
  // 地图选项：来自任务自带的地图 id（显示中文名）
  const maps = useMemo(() => {
    const set = new Set<string>()
    for (const q of list) for (const m of q.maps ?? []) if (m) set.add(m)
    return Array.from(set).sort((a, b) =>
      (mapNames[a] ?? a).localeCompare(mapNames[b] ?? b, 'zh'),
    )
  }, [list, mapNames])

  const counts = {
    in_progress: list.filter((q) => q.status === 'in_progress').length,
    completed: list.filter((q) => q.status === 'completed').length,
    all: list.length,
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
          className={`px-4 py-2 rounded-lg text-[16px] font-medium border ${
            filter === c.k
              ? 'bg-amber-soft border-amber text-amber'
              : 'bg-ink-800 border-line text-muted hover:text-[#e6edf3]'
          }`}
        >
          {c.label} {counts[c.k]}
        </button>
      ))}
      <select
        value={mapFilter}
        onChange={(e) => setMapFilter(e.target.value)}
        className="ml-auto bg-ink-800 border border-line text-[14px] rounded px-2 py-1.5 text-muted"
        title="按地图筛选任务"
      >
        <option value="">全部地图</option>
        {maps.map((m) => (
          <option key={m} value={m}>
            {mapNames[m] ?? m}
          </option>
        ))}
      </select>
      <select
        value={traderFilter ?? ''}
        onChange={(e) => setTraderFilter(e.target.value || null)}
        className="bg-ink-800 border border-line text-[14px] rounded px-2 py-1.5 text-muted"
        title="按商人筛选任务"
      >
        <option value="">全部商人</option>
        {traders.map((t) => (
          <option key={t} value={t}>
            {t}
          </option>
        ))}
      </select>
    </div>
  )
}
