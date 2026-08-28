import { useStore } from '../store'
import { getActivity } from '../tauri'

export function ActivityFeed() {
  const activities = useStore((s) => s.activities)
  const historical = useStore((s) => s.historicalActivities)
  const historicalLoaded = useStore((s) => s.historicalLoaded)
  const setHistoricalActivity = useStore((s) => s.setHistoricalActivity)

  const color = (k: string) =>
    k === 'complete' ? 'text-ok' : k === 'accept' ? 'text-amber' : 'text-muted'

  // 历史活动若与实时活动重复（同一 类型+文本+时间戳）则不重复显示
  const liveKeys = new Set(activities.map((a) => `${a.kind}|${a.text}|${a.ts}`))
  const histShown = historical.filter((a) => !liveKeys.has(`${a.kind}|${a.text}|${a.ts}`))

  const onLoadMore = async () => {
    try {
      const list = await getActivity()
      setHistoricalActivity(list)
    } catch (e) {
      console.error('加载历史活动失败', e)
    }
  }

  return (
    <aside className="w-[220px] shrink-0 bg-ink-800 border-l border-line p-3 overflow-y-auto">
      <div className="text-[13px] font-medium mb-3">实时活动</div>
      <div className="space-y-2">
        {activities.length === 0 && !historicalLoaded && (
          <div className="text-[11px] text-muted">等待事件…</div>
        )}
        {activities.map((a) => (
          <div key={a.id} className="text-[11px] leading-relaxed break-words">
            <span className="text-muted">{a.ts} </span>
            <span className={color(a.kind)}>{a.text}</span>
          </div>
        ))}
      </div>

      {!historicalLoaded ? (
        <button
          onClick={onLoadMore}
          className="mt-3 w-full text-[11px] text-amber hover:underline"
        >
          加载更多
        </button>
      ) : histShown.length > 0 ? (
        <>
          <div className="mt-4 mb-2 text-[11px] text-muted border-t border-line pt-3">
            历史活动
          </div>
          <div className="space-y-2">
            {histShown.map((a) => (
              <div key={a.id} className="text-[11px] leading-relaxed break-words">
                <span className="text-muted">{a.ts} </span>
                <span className={color(a.kind)}>{a.text}</span>
              </div>
            ))}
          </div>
        </>
      ) : null}
    </aside>
  )
}
