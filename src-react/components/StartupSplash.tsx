import { useEffect, useState } from 'react'
import type { BootStep } from '../boot'
import { isMobile, isWeb } from '../platform'
import { WinControls } from './WinControls'

/**
 * 启动遮罩：展示「读取中 xx」步骤时间线。
 * 已完成的步骤打勾，当前步骤转圈；后端步骤与前端步骤共用同一条时间线。
 * `visible` 转为 false 时淡出，淡出期间保持挂载避免闪烁。
 *
 * 遮罩盖在最上层，界面尚未渲染出顶部栏，因此遮罩自己带一条标题栏
 * （品牌 + 拖动区 + 窗口控制按钮，复用 WinControls），启动期间窗口依旧可拖可关。
 */
export function StartupSplash({
  steps,
  error,
  visible,
}: {
  steps: BootStep[]
  error: string | null
  visible: boolean
}) {
  const [mounted, setMounted] = useState(visible)
  useEffect(() => {
    if (visible) {
      setMounted(true)
      return
    }
    const t = window.setTimeout(() => setMounted(false), 300)
    return () => window.clearTimeout(t)
  }, [visible])
  if (!mounted) return null

  const list: BootStep[] = steps.length > 0 ? steps : [{ step: 'boot', label: '正在启动…' }]
  const active = visible ? list.length - 1 : -1

  return (
    <div
      className={`fixed inset-0 z-[3000] bg-ink-900 flex flex-col items-center justify-center gap-7 transition-opacity duration-300 pointer-events-none ${
        visible ? 'opacity-100' : 'opacity-0'
      }`}
    >
      {/* 标题栏（仅 Tauri 桌面端）：遮罩盖住顶部栏期间仍可拖动窗口 / 最小化 / 关闭 */}
      {!isMobile() && !isWeb() && (
        <div
          data-tauri-drag-region
          className={`absolute inset-x-0 top-0 flex h-10 items-stretch bg-ink-800 border-b border-line shrink-0 select-none ${
            visible ? 'pointer-events-auto' : ''
          }`}
        >
          <div className="flex items-center gap-2 pl-3 shrink-0">
            <img src="/icons/icon.png" alt="" className="w-5 h-5 rounded shrink-0" />
            <span className="font-medium text-[15px]">IC Tarkov</span>
          </div>
          <div data-tauri-drag-region className="flex-1 self-stretch min-w-0" />
          <WinControls />
        </div>
      )}

      {/* 标题栏以下区域拦截事件，避免误触看不见的界面 */}
      <div
        className={`absolute inset-x-0 bottom-0 top-10 ${visible ? 'pointer-events-auto' : ''}`}
      />
      <div className="flex flex-col items-center gap-3">
        <img src="/icons/icon.png" alt="" className="w-16 h-16 rounded-2xl" />
        <div className="text-center">
          <div className="text-[18px] font-medium tracking-wide">IC Tarkov</div>
          <div className="mt-0.5 text-[12px] text-muted">逃离塔科夫 · 任务与地图助手</div>
        </div>
      </div>

      {/* 进度条：步骤总数未知，用往复滑动的条表示「进行中」 */}
      <div className="h-[3px] w-[260px] max-w-[70vw] overflow-hidden rounded-full bg-ink-700">
        <div className="boot-bar h-full w-1/3 rounded-full bg-blue" />
      </div>

      <div className="w-[320px] max-w-[82vw] space-y-1.5">
        {list.map((s, i) => (
          <div key={s.step} className="flex items-center gap-2 text-[13px]">
            {i === active ? (
              <span className="h-3.5 w-3.5 shrink-0 animate-spin rounded-full border-[1.6px] border-blue border-t-transparent" />
            ) : (
              <svg
                viewBox="0 0 16 16"
                className="h-3.5 w-3.5 shrink-0 text-ok"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
              >
                <path d="M3 8.5 6.2 11.7 13 5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            )}
            <span className={i === active ? '' : 'text-muted'}>{s.label}</span>
          </div>
        ))}
      </div>

      {error && (
        <div className="w-[320px] max-w-[82vw] text-[12px] leading-relaxed text-amber">
          游戏数据读取失败，界面将以空数据启动：{error}
        </div>
      )}
    </div>
  )
}
