import { closeWindow, minimizeWindow, toggleMaximizeWindow } from '../api/shell'

/**
 * 无边框窗口的 3 个控制按钮（最小化 / 最大化 / 关闭），带头部分隔线。
 * 顶部栏与启动遮罩共用：启动期间界面还没渲染出来，遮罩自己要提供窗口操作入口。
 */

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

export function WinControls() {
  return (
    <>
      <div className="w-px self-stretch bg-line mx-1" />
      <WinButton onClick={() => void minimizeWindow()} label="─" title="最小化" />
      <WinButton onClick={() => void toggleMaximizeWindow()} label="▢" title="最大化 / 还原" />
      <WinButton onClick={() => void closeWindow()} label="✕" title="关闭" danger />
    </>
  )
}
