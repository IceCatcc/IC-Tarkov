import { useEffect, useState } from 'react'
import { useStore } from '../store'
import { isMobile } from '../platform'
import { getActivity } from '../tauri'
import type { ActivityItem } from '../types'

/**
 * 实时活动侧栏：
 * - 桌面端 / 移动端横屏：占布局空间（挤压内容区），按钮通过切换容器宽度实现显示/隐藏；
 * - 移动端竖屏：屏幕太窄，占位会把关闭按钮挤出屏外，改用浮动抽屉（覆盖内容 + 遮罩）。
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

  const mobile = isMobile()
  // 竖屏检测（matchMedia 响应式，旋转即时生效）
  const [portrait, setPortrait] = useState(
    () => typeof window !== 'undefined' && window.matchMedia('(orientation: portrait)').matches,
  )
  useEffect(() => {
    const mq = window.matchMedia('(orientation: portrait)')
    const onChange = () => setPortrait(mq.matches)
    onChange()
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])
  // 移动端竖屏：抽屉模式
  const drawer = mobile && portrait

  const content = (
    <>
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
    </>
  )

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

      {/* 移动端竖屏：居中弹窗（遮罩点击关闭） */}
      {open && drawer && (
        <div
          className="fixed inset-0 z-[1200] flex items-center justify-center bg-black/60 p-4"
          onClick={() => setOpen(false)}
        >
          <div
            className="w-[360px] max-w-full max-h-[calc(70dvh/var(--ui-scale,1))] flex flex-col rounded-xl border border-line bg-ink-800 shadow-2xl overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            {content}
          </div>
        </div>
      )}

      {/* 桌面 / 移动端横屏：占布局侧栏，宽度在 0 / 320px 间过渡 */}
      {!drawer && (
        <aside
          className={`shrink-0 h-full overflow-hidden transition-[width] duration-200 ease-out ${
            mobile ? 'pb-[var(--nav-h)]' : ''
          } ${open ? 'border-l border-line bg-ink-800' : ''}`}
          style={{ width: open ? 320 : 0 }}
          aria-hidden={!open}
        >
          <div className="w-[320px] h-full flex flex-col">{content}</div>
        </aside>
      )}
    </>
  )
}
