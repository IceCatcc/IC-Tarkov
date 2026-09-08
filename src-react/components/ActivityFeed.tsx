import { useState } from 'react'
import { useStore } from '../store'
import { isMobile } from '../platform'
import { getActivity } from '../tauri'
import type { ActivityItem } from '../types'

/**
 * 实时活动侧栏：占布局空间（挤压内容区），按钮通过切换容器宽度实现显示/隐藏。
 * 收起时为右上角浮动按钮（带未读事件数），展开后为右侧定宽栏。
 */
export function ActivityFeed() {
  const [open, setOpen] = useState(false)
  const activities = useStore((s) => s.activities)
  const historical = useStore((s) => s.historicalActivities)
  const historicalLoaded = useStore((s) => s.historicalLoaded)
  const setHistoricalActivity = useStore((s) => s.setHistoricalActivity)

  const color = (k: string) =>
    k === 'complete' ? 'text-ok' : k === 'accept' ? 'text-amber' : 'text-muted'

  // 历史活动若与实时活动重复（同类型 + 同任务）则不重复显示；
  // 后端文本（接取任务：X）与实时文本（接取 X · 商人）措辞不同，必须按任务 id 匹配
  const keyOf = (a: ActivityItem) => `${a.kind}|${a.questId ?? a.text}`
  const liveKeys = new Set(activities.map(keyOf))
  const histShown = historical.filter((a) => !liveKeys.has(keyOf(a)))

  const onLoadMore = async () => {
    try {
      const list = await getActivity()
      setHistoricalActivity(list)
    } catch (e) {
      console.error('加载历史活动失败', e)
    }
  }

  // 移动端需避开底部 Tab 栏（56px + 间距）
  const mobile = isMobile()

  return (
    <>
      {/* 收起时：右上角浮动按钮（弱化样式，与全局按钮统一） */}
      {!open && (
        <button
          onClick={() => setOpen(true)}
          className="absolute right-4 top-3 z-[900] flex items-center gap-1.5 px-3 py-1 rounded-full bg-ink-800 border border-line text-[13px] text-muted hover:text-[#e6edf3] hover:bg-ink-700 transition-colors"
          title="实时活动"
        >
          活动
          {activities.length > 0 && (
            <span className="min-w-4 text-[11px] text-amber leading-none">
              {activities.length}
            </span>
          )}
        </button>
      )}

      {/* 侧栏：宽度在 0 / 320px 间过渡，展开时挤占内容区 */}
      <aside
        className={`shrink-0 h-full overflow-hidden transition-[width] duration-200 ease-out ${
          mobile ? 'pb-[var(--nav-h)]' : ''
        } ${open ? 'border-l border-line bg-ink-800' : ''}`}
        style={{ width: open ? 320 : 0 }}
        aria-hidden={!open}
      >
        {/* 内容定宽，宽度过渡时文字不回流 */}
        <div className="w-[320px] h-full flex flex-col">
          <div className="flex items-center justify-between px-3 py-2.5 border-b border-line shrink-0">
            <span className="text-[15px] font-medium">实时活动</span>
            <button
              onClick={() => setOpen(false)}
              className="w-7 h-7 grid place-items-center rounded-md text-muted hover:text-[#e6edf3] hover:bg-ink-700"
              aria-label="收起"
            >
              ✕
            </button>
          </div>
          <div className="flex-1 min-h-0 overflow-y-auto p-3 space-y-2">
            {activities.length === 0 && !historicalLoaded && (
              <div className="text-[13px] text-muted">等待事件…</div>
            )}
            {activities.map((a) => (
              <div key={a.id} className="text-[13px] leading-relaxed break-words">
                <span className="text-muted">{a.ts} </span>
                <span className={color(a.kind)}>{a.text}</span>
              </div>
            ))}

            {!historicalLoaded ? (
              <button
                onClick={() => void onLoadMore()}
                className="mt-3 w-full text-[13px] text-amber hover:underline"
              >
                加载更多
              </button>
            ) : histShown.length > 0 ? (
              <>
                <div className="mt-4 mb-2 text-[13px] text-muted border-t border-line pt-3">
                  历史活动
                </div>
                {histShown.map((a) => (
                  <div key={a.id} className="text-[13px] leading-relaxed break-words">
                    <span className="text-muted">{a.ts} </span>
                    <span className={color(a.kind)}>{a.text}</span>
                  </div>
                ))}
              </>
            ) : null}
          </div>
        </div>
      </aside>
    </>
  )
}
