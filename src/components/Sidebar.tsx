import { useStore } from '../store'

export function Sidebar() {
  const page = useStore((s) => s.page)
  const setPage = useStore((s) => s.setPage)
  const items: { k: 'monitor' | 'graph' | 'map'; label: string; badge?: string }[] = [
    { k: 'monitor', label: '监控' },
    { k: 'graph', label: '任务图谱' },
    { k: 'map', label: '地图', badge: '待开发' },
  ]

  return (
    <nav className="w-[120px] shrink-0 bg-ink-800 border-r border-line py-4">
      {items.map((it) => (
        <button
          key={it.k}
          onClick={() => setPage(it.k)}
          className={`w-full text-left px-4 py-2 text-[13px] ${
            page === it.k
              ? 'text-[#e6edf3] border-l-2 border-amber bg-ink-700/40'
              : 'text-muted hover:text-[#e6edf3]'
          }`}
        >
          {it.label}
          {it.badge && <span className="text-[10px] opacity-70 ml-1">{it.badge}</span>}
        </button>
      ))}
    </nav>
  )
}
