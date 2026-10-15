import { ImportPanel } from './ImportPanel'

/**
 * 「导入数据」弹窗：把桌面端已有的进度迁到当前账号。
 * 层级高于设置窗口（z-[2000]），从设置页打开时也不会被盖住。
 */
export function ImportDataModal({
  open,
  onClose,
  z = 2100,
}: {
  open: boolean
  onClose: () => void
  z?: number
}) {
  if (!open) return null
  return (
    <div
      className="fixed inset-0 flex items-center justify-center bg-black/60"
      style={{ zIndex: z }}
      onClick={onClose}
    >
      <div
        className="w-[560px] max-w-[calc((100vw-32px)/var(--ui-scale,1))] max-h-[calc(80dvh/var(--ui-scale,1))] flex flex-col rounded-2xl border border-line bg-ink-800 shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="relative px-5 pt-5 pb-4 border-b border-line bg-gradient-to-b from-ink-700/60 to-transparent">
          <button
            onClick={onClose}
            className="absolute top-3 right-3 w-7 h-7 grid place-items-center rounded-md text-[15px] text-muted hover:text-[#e6edf3] hover:bg-ink-700"
            aria-label="关闭"
          >
            ✕
          </button>
          <div className="text-[17px] font-semibold text-[#e6edf3]">导入本地数据</div>
          <div className="mt-1 text-[13px] text-muted">
            把桌面端已记录的任务进度、收藏与界面偏好同步到当前账号
          </div>
        </div>
        <div className="px-5 py-4 overflow-y-auto flex-1 min-h-0">
          <ImportPanel />
        </div>
      </div>
    </div>
  )
}
