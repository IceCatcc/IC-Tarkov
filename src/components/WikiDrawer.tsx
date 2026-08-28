import { useEffect, useState } from 'react'
import { useStore } from '../store'
import { openUrl } from '../tauri'

export function WikiDrawer() {
  const wikiUrl = useStore((s) => s.wikiUrl)
  const closeWiki = useStore((s) => s.closeWiki)
  // 挂载后下一帧再滑入，触发 CSS 过渡
  const [shown, setShown] = useState(false)

  useEffect(() => {
    if (wikiUrl) {
      const id = requestAnimationFrame(() => setShown(true))
      return () => cancelAnimationFrame(id)
    }
    setShown(false)
  }, [wikiUrl])

  if (!wikiUrl) return null

  return (
    <div className="fixed inset-0 z-[2000]" onKeyDown={(e) => e.key === 'Escape' && closeWiki()}>
      {/* 遮罩 */}
      <div
        className="absolute inset-0 bg-black/50 transition-opacity duration-200"
        style={{ opacity: shown ? 1 : 0 }}
        onClick={closeWiki}
      />
      {/* 右侧抽屉 */}
      <div
        className={`absolute right-0 top-0 h-full w-[62%] min-w-[560px] bg-ink-900 border-l border-line shadow-2xl flex flex-col transition-transform duration-250 ${
          shown ? 'translate-x-0' : 'translate-x-full'
        }`}
      >
        <div className="shrink-0 flex items-center gap-3 px-4 py-2.5 bg-ink-800 border-b border-line">
          <span className="text-[13px] font-medium">任务 Wiki</span>
          <button
            onClick={() => openUrl(wikiUrl)}
            className="ml-auto text-[12px] text-muted hover:text-[#e6edf3]"
            title="在系统浏览器中打开"
          >
            浏览器打开 ↗
          </button>
          <button
            onClick={closeWiki}
            className="text-[13px] text-muted hover:text-[#e6edf3]"
          >
            ✕
          </button>
        </div>
        <div className="flex-1 min-h-0 relative bg-[#0d1117]">
          <iframe
            src={wikiUrl}
            title="wiki"
            className="absolute inset-0 w-full h-full border-0"
            sandbox="allow-scripts allow-same-origin allow-popups allow-forms"
          />
          <div className="pointer-events-none absolute bottom-2 left-1/2 -translate-x-1/2 text-[11px] text-muted/70 bg-black/40 px-2 py-0.5 rounded">
            若页面空白说明站点禁止内嵌，请点右上「浏览器打开」
          </div>
        </div>
      </div>
    </div>
  )
}
