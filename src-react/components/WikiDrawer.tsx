import { useEffect, useState } from 'react'
import { useStore } from '../store'
import { isMobile } from '../platform'
import { openUrl } from '../tauri'

export function WikiDrawer() {
  const wikiUrl = useStore((s) => s.wikiUrl)
  const closeWiki = useStore((s) => s.closeWiki)
  // 挂载后下一帧再滑入，触发 CSS 过渡
  const [shown, setShown] = useState(false)
  const mobile = isMobile()

  useEffect(() => {
    if (wikiUrl) {
      const id = requestAnimationFrame(() => setShown(true))
      return () => cancelAnimationFrame(id)
    }
    setShown(false)
  }, [wikiUrl])

  // 移动端：系统返回键关闭抽屉（history 守卫：打开时压入一条记录，
  // 返回键触发 popstate → 关闭抽屉；用 ✕/遮罩关闭时弹掉该守卫记录）
  useEffect(() => {
    if (!mobile || !wikiUrl) return
    history.pushState({ wikiDrawer: true }, '')
    const onPop = () => closeWiki()
    window.addEventListener('popstate', onPop)
    return () => {
      window.removeEventListener('popstate', onPop)
      if (history.state?.wikiDrawer) history.back()
    }
  }, [mobile, wikiUrl])

  if (!wikiUrl) return null

  return (
    <div
      className="fixed inset-0 z-[2000]"
      onKeyDown={(e) => e.key === 'Escape' && closeWiki()}
      // 阻止 mousedown 冒泡：wiki 打开期间，点外部（遮罩/抽屉内）只关闭 wiki，
      // 不触发地图页等底层的「点外部关闭浮窗」逻辑
      onMouseDown={(e) => e.stopPropagation()}
    >
      {/* 遮罩 */}
      <div
        className="absolute inset-0 bg-black/50 transition-opacity duration-200"
        style={{ opacity: shown ? 1 : 0 }}
        onClick={closeWiki}
      />
      {/* 抽屉：桌面/横屏为右侧 62%；移动端竖屏全屏 */}
      <div
        className={`absolute bg-ink-900 shadow-2xl flex flex-col transition-transform duration-250 ${
          mobile
            ? `inset-0 w-full border-t border-line ${shown ? 'translate-y-0' : 'translate-y-full'}`
            : `right-0 top-0 h-full w-[62%] min-w-[560px] border-l border-line ${
                shown ? 'translate-x-0' : 'translate-x-full'
              }`
        }`}
      >
        <div className="shrink-0 flex items-center gap-3 px-4 py-2.5 bg-ink-800 border-b border-line">
          <span className="text-[15px] font-medium">任务 Wiki</span>
          <button
            onClick={() => openUrl(wikiUrl)}
            className="ml-auto text-[14px] text-muted hover:text-[#e6edf3]"
            title="在系统浏览器中打开"
          >
            浏览器打开 ↗
          </button>
          <button
            onClick={closeWiki}
            className="text-[15px] text-muted hover:text-[#e6edf3]"
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
        </div>
      </div>
    </div>
  )
}
