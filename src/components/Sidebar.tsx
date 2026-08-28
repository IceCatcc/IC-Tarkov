import { useRef, useState } from 'react'
import { useStore } from '../store'

const ITEMS = [
  { k: 'monitor' as const, label: '监控', icon: '◉' },
  { k: 'graph' as const, label: '任务图谱', icon: '✦' },
  { k: 'profile' as const, label: '角色管理', icon: '☗' },
  { k: 'map' as const, label: '地图', icon: '⛰' },
]

export function Sidebar() {
  const page = useStore((s) => s.page)
  const setPage = useStore((s) => s.setPage)
  const open = useStore((s) => s.sidebarOpen)
  const toggleSidebar = useStore((s) => s.toggleSidebar)

  // 折叠态：hover 浮动按钮时浮出快捷菜单
  const [flyout, setFlyout] = useState(false)
  const closeTimer = useRef<number | undefined>(undefined)

  const openFlyout = () => {
    if (open) return
    if (closeTimer.current) window.clearTimeout(closeTimer.current)
    setFlyout(true)
  }
  const scheduleClose = () => {
    if (closeTimer.current) window.clearTimeout(closeTimer.current)
    closeTimer.current = window.setTimeout(() => setFlyout(false), 180)
  }

  return (
    <>
      {/* 展开态：常规侧边栏（占据布局）；顶部留出与浮动按钮对齐的空间 */}
      {open && (
        <nav className="w-[120px] shrink-0 bg-ink-800 border-r border-line pt-[48px] pb-4 h-full">
          {ITEMS.map((it) => (
            <button
              key={it.k}
              onClick={() => setPage(it.k)}
              className={`w-full text-left px-4 py-2 text-[15px] ${
                page === it.k
                  ? 'text-[#e6edf3] border-l-2 border-amber bg-ink-700/40'
                  : 'text-muted hover:text-[#e6edf3]'
              }`}
            >
              {it.label}
            </button>
          ))}
        </nav>
      )}

      {/* 切换按钮：始终浮动固定在左上角，浮于页面内容之上。
          top = TopBar 40px + 工具栏内垂直居中偏移 8px（工具栏高 45px，按钮 28px） */}
      <div
        className="fixed top-[48px] left-2 z-[900]"
        onMouseEnter={openFlyout}
        onMouseLeave={scheduleClose}
      >
        <button
          onClick={toggleSidebar}
          title={open ? '收起侧边栏' : '展开侧边栏（悬停显示快捷切换）'}
          className="w-7 h-7 grid place-items-center rounded border border-line bg-ink-800 text-muted transition-colors hover:text-[#e6edf3] hover:bg-ink-700 shadow-md"
        >
          <span className="text-[15px] leading-none">{open ? '‹' : '›'}</span>
        </button>

        {/* 悬浮快捷菜单：折叠时可直接切换界面 */}
        {!open && flyout && (
          <nav className="absolute left-0 top-9 min-w-[130px] py-1.5 rounded-md bg-ink-800 border border-line shadow-xl">
            {ITEMS.map((it) => (
              <button
                key={it.k}
                onClick={() => {
                  setPage(it.k)
                  setFlyout(false)
                }}
                className={`w-full text-left px-3 py-1.5 text-[14.5px] flex items-center gap-2 ${
                  page === it.k
                    ? 'text-[#e6edf3] bg-ink-700/60'
                    : 'text-muted hover:text-[#e6edf3] hover:bg-ink-700/40'
                }`}
              >
                <span className="text-[13px] opacity-70 w-3 text-center">{it.icon}</span>
                {it.label}
              </button>
            ))}
          </nav>
        )}
      </div>
    </>
  )
}
