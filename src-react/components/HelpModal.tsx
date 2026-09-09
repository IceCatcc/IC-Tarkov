/**
 * 使用帮助（首次启动引导 + 设置页左下角「帮助」入口共用）。
 *
 * 首次启动时自动弹出并带「去设置」按钮；从设置页打开时不传 onGoSettings（已经在设置里）。
 * 「关于」入口已移到设置页左下角，本弹窗不再承载。
 */
export function HelpModal({
  open,
  onClose,
  onGoSettings,
  z = 1200,
}: {
  open: boolean
  onClose: () => void
  /** 传入才显示「去设置」（首次启动引导用） */
  onGoSettings?: () => void
  /** 层级：默认 1200；从设置页（z-2000）打开时需传更高值才不会被盖住 */
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
        className="w-[460px] max-w-[calc((100vw-32px)/var(--ui-scale,1))] rounded-2xl border border-line bg-ink-800 shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* 头部 */}
        <div className="relative px-5 pt-5 pb-4 border-b border-line bg-gradient-to-b from-ink-700/60 to-transparent text-center">
          <div className="text-[18px] font-semibold text-[#e6edf3]">使用帮助</div>
          <div className="mt-1 text-[13px] text-muted">请按以下步骤完成配置</div>
        </div>

        {/* 步骤 */}
        <div className="px-5 py-4 space-y-3 max-h-[calc(60dvh/var(--ui-scale,1))] overflow-y-auto">
          {[
            {
              t: '1. 配置日志目录',
              d: '在「设置」里配置日志目录，指向游戏根目录下的 Logs 目录。',
            },
            {
              t: '2. 配置截图目录',
              d: '配置截图目录，指向「文档\\Escape from Tarkov\\Screenshots\\」。若该目录不存在，请进入游戏后按 PrintScreen 键（默认）进行截图后再配置。',
            },
            {
              t: '3. 设置游戏档',
              d: '在「档案」页面设置当前游戏档的角色等级、商人好感与地图解锁情况。',
            },
          ].map((s) => (
            <div
              key={s.t}
              className="rounded-lg bg-ink-700/50 border border-line px-3 py-2.5"
            >
              <div className="text-[14px] font-medium text-[#e6edf3] mb-1">{s.t}</div>
              <div className="text-[13px] text-[#c9d1d9] leading-relaxed">{s.d}</div>
            </div>
          ))}
        </div>

        {/* 操作 */}
        <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-line">
          <button
            onClick={onClose}
            className="px-4 py-1.5 rounded border border-line text-[14px] text-muted hover:text-[#e6edf3] hover:bg-ink-700"
          >
            我知道了
          </button>
          {onGoSettings && (
            <button
              onClick={onGoSettings}
              className="px-4 py-1.5 rounded bg-amber text-black text-[14px] font-medium hover:opacity-90"
            >
              去设置
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
