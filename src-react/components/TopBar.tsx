import { useEffect, useState } from 'react'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { getVersion } from '@tauri-apps/api/app'
import { useStore } from '../store'

const win = getCurrentWindow()

const NAV_ITEMS: { key: 'monitor' | 'graph' | 'profile' | 'map'; label: string }[] = [
  { key: 'monitor', label: '监控' },
  { key: 'map', label: '地图' },
  { key: 'graph', label: '任务' },
  { key: 'profile', label: '档案' },
]

function WinButton({
  onClick,
  label,
  danger,
  title,
}: {
  onClick: () => void
  label: string
  danger?: boolean
  title: string
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      className={`h-full w-12 grid place-items-center text-[13px] text-muted transition-colors ${
        danger ? 'hover:bg-[#e81123] hover:text-white' : 'hover:bg-ink-600 hover:text-[#e6edf3]'
      }`}
    >
      {label}
    </button>
  )
}

export function TopBar({ onShowHelp }: { onShowHelp: () => void }) {
  const page = useStore((s) => s.page)
  const setPage = useStore((s) => s.setPage)
  const watcher = useStore((s) => s.watcher)
  const openSettings = useStore((s) => s.openSettings)
  const live = watcher.watching && !watcher.error
  const [version, setVersion] = useState<string>('')

  // 应用版本号（Tauri 运行时；开发环境取不到时静默留空）
  useEffect(() => {
    getVersion()
      .then(setVersion)
      .catch(() => {})
  }, [])

  return (
    <header className="h-10 flex items-stretch bg-ink-800 border-b border-line shrink-0 select-none">
      {/* 左侧：品牌 + 导航（空白处可拖动窗口） */}
      <div className="flex items-center gap-2 pl-3">
        <img src="/icons/icon.png" alt="" className="w-5 h-5 rounded shrink-0" />
        <span className="font-medium text-[15px]">IC Tarkov</span>
        {version && (
          <span className="text-[11px] text-muted px-1.5 py-[1px] rounded bg-ink-700 border border-line">
            v{version}
          </span>
        )}
        {/* 导航：跟在版本号后面 */}
        <nav className="flex items-center gap-1 ml-2">
          {NAV_ITEMS.map((it) => (
            <button
              key={it.key}
              onClick={() => setPage(it.key)}
              className={`flex items-center gap-1.5 px-5 h-7 rounded text-[13px] leading-none transition-colors ${
                page === it.key
                  ? 'bg-amber/15 text-[#d4a174] border border-amber/60'
                  : 'text-muted hover:text-[#e6edf3] border border-transparent'
              }`}
            >
              {it.key === 'monitor' && (
                <span className={`w-1.5 h-1.5 rounded-full ${live ? 'bg-ok' : 'bg-red-500'}`} />
              )}
              {it.label}
            </button>
          ))}
        </nav>
      </div>

      {/* 中间：可拖动窗口的空白区域 */}
      <div data-tauri-drag-region className="flex-1 self-stretch min-w-0" />

      {/* 右侧：错误提示 + 设置 + 窗口控制 */}
      <div className="flex items-center gap-2 pr-2">
        {watcher.error && (
          <span className="text-[11px] text-red-400 truncate max-w-[180px]" title={watcher.error}>
            {watcher.error}
          </span>
        )}
        <button
          onClick={openSettings}
          title="设置"
          className="px-2.5 py-1 rounded border border-line text-[12px] hover:bg-ink-700 text-[#e6edf3]"
        >
          ⚙ 设置
        </button>
        <button
          onClick={onShowHelp}
          title="帮助 / 使用说明"
          className="px-1 text-[14px] text-muted hover:text-[#e6edf3] transition-colors"
        >
          ?
        </button>
      </div>

      {/* 窗口控制按钮 */}
      <div className="w-px self-stretch bg-line mx-1" />
      <WinButton onClick={() => win.minimize()} label="─" title="最小化" />
      <WinButton onClick={() => win.toggleMaximize()} label="▢" title="最大化 / 还原" />
      <WinButton onClick={() => win.close()} label="✕" title="关闭" danger />
    </header>
  )
}
