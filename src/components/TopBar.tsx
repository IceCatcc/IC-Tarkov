import { useStore } from '../store'
import { startWatching, stopWatching } from '../tauri'

export function TopBar() {
  const watcher = useStore((s) => s.watcher)
  const openSettings = useStore((s) => s.openSettings)
  const live = watcher.watching && !watcher.error

  const onToggle = () => {
    if (watcher.watching) stopWatching()
    else startWatching()
  }

  return (
    <header className="h-10 flex items-center gap-3 px-4 bg-ink-800 border-b border-line shrink-0">
      <span className={`w-2 h-2 rounded-full ${live ? 'bg-ok' : 'bg-red-500'}`} />
      <span className="font-medium text-[15px]">EFT Spy</span>
      <span className={`text-[12px] ${live ? 'text-ok' : 'text-red-400'}`}>
        {live ? '监控中' : '已暂停'}
      </span>
      <span className="text-[11px] text-muted truncate max-w-[300px]">
        {watcher.logDir || '未设置日志目录'}
      </span>
      {watcher.error && (
        <span className="text-[11px] text-red-400 truncate max-w-[240px]">{watcher.error}</span>
      )}
      <div className="ml-auto flex items-center gap-3 text-[11px] text-muted">
        {watcher.sessions > 0 && <span>监听会话 {watcher.sessions}</span>}
        {watcher.lastScan && <span>上次扫描 {watcher.lastScan}</span>}
        <button
          onClick={onToggle}
          className="px-2 py-1 rounded border border-line text-[12px] hover:bg-ink-700 text-[#e6edf3]"
        >
          {watcher.watching ? '暂停' : '开始'}
        </button>
        <button
          onClick={openSettings}
          title="设置"
          className="px-2 py-1 rounded border border-line text-[12px] hover:bg-ink-700 text-[#e6edf3]"
        >
          ⚙ 设置
        </button>
      </div>
    </header>
  )
}
