import { useEffect, useState } from 'react'
import { getVersion } from '@tauri-apps/api/app'
import { openUrl } from '../tauri'

// GitHub 仓库地址
const GITHUB_URL = 'https://github.com/IceCatcc/IC-Tarkov'

// 在系统默认浏览器中打开外链（复用后端 open_url 命令，避免 webview 内打开）
function ExtLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a
      className="text-[#d4a174] hover:underline"
      href={href}
      onClick={(e) => {
        e.preventDefault()
        openUrl(href)
      }}
    >
      {children}
    </a>
  )
}

// 关于弹窗：应用信息、数据来源、致谢与开源仓库
export default function AboutModal({ onClose }: { onClose: () => void }) {
  const [appVersion, setAppVersion] = useState('')

  useEffect(() => {
    getVersion()
      .then(setAppVersion)
      .catch(() => {})
  }, [])

  return (
    <div
      className="fixed inset-0 z-[1300] flex items-center justify-center bg-black/60"
      onClick={onClose}
    >
      <div
        className="w-[440px] max-w-[calc(100vw-32px)] rounded-2xl border border-line bg-ink-800 shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* 头部：图标 + 标题 + 版本 */}
        <div className="relative px-5 pt-6 pb-5 flex flex-col items-center text-center border-b border-line bg-gradient-to-b from-ink-700/60 to-transparent">
          <button
            onClick={onClose}
            className="absolute top-3 right-3 w-7 h-7 flex items-center justify-center rounded-md text-[15px] text-muted hover:text-[#e6edf3] hover:bg-ink-700"
            aria-label="关闭"
          >
            ✕
          </button>
          <img
            src="/icons/icon.png"
            alt=""
            className="w-14 h-14 rounded-xl shadow-lg ring-1 ring-line mb-3"
          />
          <div className="text-[18px] font-semibold text-[#e6edf3]">IC Tarkov</div>
          <div className="mt-1 flex items-center gap-2">
            {appVersion && (
              <span className="text-[11px] text-muted px-2 py-[1px] rounded-full bg-ink-700 border border-line">
                v{appVersion}
              </span>
            )}
            <span className="text-[11px] text-muted">逃离塔科夫 任务与地图助手</span>
          </div>
        </div>

        {/* 内容 */}
        <div className="px-5 py-4 text-[14px] text-[#c9d1d9] leading-relaxed space-y-3">
          <div className="rounded-lg bg-ink-700/50 border border-line px-3 py-2.5">
            <div className="text-[12px] uppercase tracking-wide text-muted mb-1">
              数据来源
            </div>
            <div>
              游戏数据（任务、地图、物品、商人、本地化等）均来自{' '}
              <ExtLink href="https://tarkov.dev">tarkov.dev</ExtLink>{' '}
              提供的开放接口；
              <p>
              中文Wiki使用{' '}
                <ExtLink href="https://www.eftarkov.com/">eftarkov.com</ExtLink>
                ，特此致谢。
              </p>
            </div>
          </div>

          <div className="rounded-lg bg-ink-700/50 border border-line px-3 py-2.5">
            <div className="text-[12px] uppercase tracking-wide text-muted mb-1">
              项目参考
            </div>
            <div>
              本项目的设计与数据解析参考了{' '}
              <ExtLink href="https://tarkov.dev">tarkov.dev</ExtLink>{' '}
              的社区成果，向其贡献者致谢。
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="rounded-lg bg-ink-700/50 border border-line px-3 py-2.5">
              <div className="text-[12px] uppercase tracking-wide text-muted mb-1">
                开发者
              </div>
              <div>
                icecat · 主页{' '}
                <ExtLink href="https://icecat.cc">icecat.cc</ExtLink>
              </div>
            </div>
            <div className="rounded-lg bg-ink-700/50 border border-line px-3 py-2.5">
              <div className="text-[12px] uppercase tracking-wide text-muted mb-1">
                开源仓库
              </div>
              <div>
                {GITHUB_URL ? (
                  <ExtLink href={GITHUB_URL}>GitHub</ExtLink>
                ) : (
                  <span className="text-muted">即将上线</span>
                )}
              </div>
            </div>
          </div>

          <div className="border-t border-line pt-3 text-[13px] text-muted">
            本项目在开发过程中深度使用 AI 编程（特此说明）。
          </div>
        </div>
      </div>
    </div>
  )
}
