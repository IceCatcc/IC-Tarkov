import { useEffect, useState } from 'react'
import { useStore } from '../store'
import { isMobile } from '../platform'
import { openUrl } from '../tauri'

export function WikiDrawer() {
  const wikiUrl = useStore((s) => s.wikiUrl)
  const closeWiki = useStore((s) => s.closeWiki)
  // 桌面端宽度可拖动调整（存 uiPrefs，跨启动保留）；移动端竖屏全屏，不参与
  const wikiWidth = useStore((s) => s.wikiWidth)
  const setWikiWidth = useStore((s) => s.setWikiWidth)
  const [resizing, setResizing] = useState(false)
  // 挂载后下一帧再滑入，触发 CSS 过渡
  const [shown, setShown] = useState(false)
  const mobile = isMobile()

  // 拖动左边缘调整宽度：按指针到屏幕右侧的距离换算占比
  useEffect(() => {
    if (!resizing) return
    const onMove = (e: PointerEvent) => {
      const pct = ((window.innerWidth - e.clientX) / window.innerWidth) * 100
      setWikiWidth(pct)
    }
    const stop = () => setResizing(false)
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', stop)
    window.addEventListener('pointercancel', stop)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', stop)
      window.removeEventListener('pointercancel', stop)
    }
  }, [resizing, setWikiWidth])

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
      {/* 抽屉：桌面为右侧可拖动宽度（默认 62%）；移动端竖屏全屏 */}
      <div
        className={`absolute bg-ink-900 shadow-2xl flex flex-col transition-transform duration-250 ${
          mobile
            ? `inset-0 w-full border-t border-line ${shown ? 'translate-y-0' : 'translate-y-full'}`
            : `right-0 top-0 h-full min-w-[320px] border-l border-line ${
                shown ? 'translate-x-0' : 'translate-x-full'
              }`
        }`}
        style={mobile ? undefined : { width: `${wikiWidth}%` }}
      >
        {/* 拖动改宽度的手柄（仅桌面）：iframe 会吞掉指针事件，故拖动期间另加遮挡层 */}
        {!mobile && (
          <div
            onPointerDown={(e) => {
              e.preventDefault()
              setResizing(true)
            }}
            title="拖动调整宽度"
            className="absolute left-0 top-0 h-full w-2 -translate-x-1/2 z-40 cursor-col-resize group"
          >
            <div
              className={`h-full w-full transition-colors ${
                resizing ? 'bg-amber/70' : 'bg-transparent group-hover:bg-amber/50'
              }`}
            />
          </div>
        )}
        {resizing && <div className="absolute inset-0 z-50 cursor-col-resize" />}
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
