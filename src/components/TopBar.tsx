import { getCurrentWindow } from '@tauri-apps/api/window'
import { useStore } from '../store'
import { startWatching, stopWatching } from '../tauri'

const win = getCurrentWindow()

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

export function TopBar() {
  const watcher = useStore((s) => s.watcher)
  const openSettings = useStore((s) => s.openSettings)
  const live = watcher.watching && !watcher.error

  const onToggle = () => {
    if (watcher.watching) stopWatching()
    else startWatching()
  }

  return (
    <header className="h-10 flex items-center gap-2 pl-3 bg-ink-800 border-b border-line shrink-0 select-none">
      {/* 左侧：应用状态（此区域可拖动窗口） */}
      <div
        data-tauri-drag-region
        className="flex-1 self-stretch flex items-center gap-3 min-w-0"
      >
        <img src="/icons/icon.png" alt="" className="w-5 h-5 rounded shrink-0" />
        <span className="font-medium text-[15px]">EFT Spy</span>
        <span className={`w-2 h-2 rounded-full ${live ? 'bg-ok' : 'bg-red-500'}`} />
        <span className={`text-[12px] ${live ? 'text-ok' : 'text-red-400'}`}>
          {live ? '监控中' : '已暂停'}
        </span>
        <span className="text-[11px] text-muted truncate max-w-[300px]">
          {watcher.logDir || '未设置日志目录'}
        </span>
        {watcher.error && (
          <span className="text-[11px] text-red-400 truncate max-w-[240px]">
            {watcher.error}
          </span>
        )}
        <div className="flex items-center gap-3 text-[11px] text-muted ml-auto pr-1">
          {watcher.sessions > 0 && <span>会话 {watcher.sessions}</span>}
          {watcher.lastScan && <span>扫描 {watcher.lastScan}</span>}
        </div>
      </div>

      {/* 右侧：控制按钮（不可拖动区域） */}
      <button
        onClick={onToggle}
        className="px-2.5 py-1 rounded border border-line text-[12px] hover:bg-ink-700 text-[#e6edf3]"
      >
        {watcher.watching ? '暂停' : '开始'}
      </button>
      <button
        onClick={openSettings}
        title="设置"
        className="px-2.5 py-1 rounded border border-line text-[12px] hover:bg-ink-700 text-[#e6edf3]"
      >
        ⚙ 设置
      </button>

      {/* 窗口控制按钮 */}
      <div className="w-px self-stretch bg-line mx-1" />
      <WinButton onClick={() => win.minimize()} label="─" title="最小化" />
      <WinButton onClick={() => win.toggleMaximize()} label="▢" title="最大化 / 还原" />
      <WinButton onClick={() => win.close()} label="✕" title="关闭" danger />
    </header>
  )
}
