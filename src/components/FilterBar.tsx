import { useStore } from '../store'

export function FilterBar() {
  const filter = useStore((s) => s.filter as 'all' | 'in_progress' | 'completed')
  const setFilter = useStore((s) => s.setFilter)
  const traderFilter = useStore((s) => s.traderFilter)
  const setTraderFilter = useStore((s) => s.setTraderFilter)
  const list = useStore((s) => s.playerQuests)

  const traders = Array.from(new Set(list.map((q) => q.traderName).filter(Boolean))).sort()

  const chips = [
    { k: 'all', label: '全部' },
    { k: 'in_progress', label: '进行中' },
    { k: 'completed', label: '已完成' },
  ] as const

  return (
    <div className="flex items-center gap-2">
      {chips.map((c) => (
        <button
          key={c.k}
          onClick={() => setFilter(c.k)}
          className={`px-3 py-1 rounded-full text-[14px] border ${
            filter === c.k
              ? 'bg-amber-soft border-amber text-amber'
              : 'bg-ink-800 border-line text-muted'
          }`}
        >
          {c.label}
        </button>
      ))}
      <select
        value={traderFilter ?? ''}
        onChange={(e) => setTraderFilter(e.target.value || null)}
        className="ml-auto bg-ink-800 border border-line text-[14px] rounded px-2 py-1 text-muted"
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
