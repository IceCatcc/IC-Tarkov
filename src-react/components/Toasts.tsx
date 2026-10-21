import { useEffect } from 'react'
import { useStore } from '../store'
import type { Toast, ToastKind } from '../types'

const BAR_COLOR: Record<ToastKind, string> = {
  accept: 'bg-[#58a6ff]', // 接取
  done: 'bg-[#2ea043]', // 完成
  map: 'bg-amber', // 进入地图
  boss: 'bg-[#f85149]', // 战局内 Boss 刷新
  info: 'bg-[#6b7682]',
}

function ToastItem({ toast }: { toast: Toast }) {
  const dismiss = useStore((s) => s.dismissToast)
  useEffect(() => {
    const timer = window.setTimeout(() => dismiss(toast.id), 3000)
    return () => window.clearTimeout(timer)
    // 仅按 id 建立/清理定时器，避免渲染重建导致计时被重置
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [toast.id])

  return (
    <div
      onClick={() => dismiss(toast.id)}
      className="pointer-events-auto flex items-stretch gap-0 min-w-[200px] max-w-[320px] rounded-lg border border-line bg-ink-800/95 shadow-xl backdrop-blur-sm overflow-hidden cursor-pointer animate-toast-in"
    >
      <span className={`w-1 shrink-0 ${BAR_COLOR[toast.kind] ?? BAR_COLOR.info}`} />
      <span className="px-3 py-2 text-[14px] text-[#e6edf3] leading-snug">{toast.text}</span>
    </div>
  )
}

/**
 * 全局通知容器：窗口底部居中堆叠显示，单条 3s 后自动关闭（点击可立即关闭）。
 * 顶部容易被标题栏 / 地图操作区挡住，所以贴底；移动端再抬高一个底部导航的高度。
 */
export function Toasts() {
  const toasts = useStore((s) => s.toasts)
  if (toasts.length === 0) return null
  return (
    <div className="fixed left-1/2 -translate-x-1/2 z-[1000] flex flex-col items-center gap-2 pointer-events-none bottom-4 max-md:bottom-[calc(var(--nav-h,0px)+env(safe-area-inset-bottom)+12px)]">
      {toasts.map((t) => (
        <ToastItem key={t.id} toast={t} />
      ))}
    </div>
  )
}
