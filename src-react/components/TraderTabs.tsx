import { useStore } from '../store'
import { traderImage } from '../traderImages'
import { TRADER_ZH, traderDisplayName } from '../traderMeta'

/**
 * 监控页左侧商人筛选：竖排 tab 样式的按钮列。
 * 第一项为「全部」，其后是当前任务列表中出现的各商人头像；
 * 点击即设置 traderFilter，右侧任务列表随之过滤。
 */
export function TraderTabs() {
  const list = useStore((s) => s.playerQuests)
  const traderFilter = useStore((s) => s.traderFilter)
  const setTraderFilter = useStore((s) => s.setTraderFilter)

  // traderName -> traderId（任务数据自带的映射；traderFilter 匹配的是 traderName）
  const traderIdByName = new Map<string, string>()
  for (const q of list) {
    if (q.traderName && q.traderId && !traderIdByName.has(q.traderName)) {
      traderIdByName.set(q.traderName, q.traderId)
    }
  }
  const traders = Array.from(new Set(list.map((q) => q.traderName).filter(Boolean))).sort()

  return (
    <nav className="shrink-0 w-[72px] h-full overflow-y-auto flex flex-col items-stretch gap-1.5 py-2 px-1.5 border-r border-line bg-ink-900">
      {/* 全部 */}
      <button
        onClick={() => setTraderFilter(null)}
        title="全部商人"
        className={`flex flex-col items-center gap-1 py-1.5 rounded-lg border transition-colors ${
          traderFilter == null
            ? 'bg-amber-soft border-amber'
            : 'border-transparent hover:bg-ink-800'
        }`}
      >
        <span
          className={`w-10 h-10 rounded-full flex items-center justify-center border ${
            traderFilter == null ? 'border-amber text-amber' : 'border-line text-muted'
          }`}
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden>
            <rect x="3.5" y="3.5" width="7" height="7" rx="1.5" stroke="currentColor" strokeWidth="1.8" />
            <rect x="13.5" y="3.5" width="7" height="7" rx="1.5" stroke="currentColor" strokeWidth="1.8" />
            <rect x="3.5" y="13.5" width="7" height="7" rx="1.5" stroke="currentColor" strokeWidth="1.8" />
            <rect x="13.5" y="13.5" width="7" height="7" rx="1.5" stroke="currentColor" strokeWidth="1.8" />
          </svg>
        </span>
        <span className={`text-[11px] leading-none ${traderFilter == null ? 'text-amber font-medium' : 'text-muted'}`}>
          全部
        </span>
      </button>
      {/* 各商人头像 */}
      {traders.map((t) => {
        const tid = traderIdByName.get(t) ?? ''
        const avatar = traderImage(tid)
        const zh = TRADER_ZH[tid]
        const label = zh ?? t
        const active = traderFilter === t
        return (
          <button
            key={t}
            onClick={() => setTraderFilter(active ? null : t)}
            title={traderDisplayName(tid, t)}
            className={`flex flex-col items-center gap-1 py-1.5 rounded-lg border transition-colors ${
              active ? 'bg-amber-soft border-amber' : 'border-transparent hover:bg-ink-800'
            }`}
          >
            {avatar ? (
              <img
                src={avatar}
                alt=""
                className={`w-10 h-10 rounded-full object-cover border ${
                  active ? 'border-amber' : 'border-line'
                }`}
              />
            ) : (
              <span
                className={`w-10 h-10 rounded-full flex items-center justify-center border text-[15px] ${
                  active ? 'border-amber text-amber bg-ink-800' : 'border-line text-muted bg-ink-800'
                }`}
              >
                {label.slice(0, 1)}
              </span>
            )}
            <span
              className={`max-w-full truncate text-[11px] leading-none ${
                active ? 'text-amber font-medium' : 'text-muted'
              }`}
            >
              {label}
            </span>
          </button>
        )
      })}
    </nav>
  )
}
