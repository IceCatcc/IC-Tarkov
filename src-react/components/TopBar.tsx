import { useEffect, useState } from 'react'
import { listen } from '@tauri-apps/api/event'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { getVersion } from '@tauri-apps/api/app'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { useStore } from '../store'
import { isMobile } from '../platform'
import { getLanConnStatus, onLanStatus } from '../lan'
import { checkLatestRelease, isNewer, RELEASES_PAGE, type ReleaseInfo } from '../updater'
import { openUrl, getLanStatus } from '../tauri'
import { LanSyncModal } from './LanSyncModal'
import { LanConnectModal } from './LanConnectModal'

const win = getCurrentWindow()

const NAV_ITEMS: {
  key: 'monitor' | 'graph' | 'profile' | 'map' | 'collector'
  label: string
}[] = [
  { key: 'monitor', label: '监控' },
  { key: 'map', label: '地图' },
  { key: 'graph', label: '任务' },
  { key: 'collector', label: '收藏家' },
  { key: 'profile', label: '档案' },
]

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

export function TopBar({ onShowHelp }: { onShowHelp: () => void }) {
  const page = useStore((s) => s.page)
  const setPage = useStore((s) => s.setPage)
  const watcher = useStore((s) => s.watcher)
  const openSettings = useStore((s) => s.openSettings)
  const live = watcher.watching && !watcher.error
  const [version, setVersion] = useState<string>('')
  // 最新 release 信息（用于展示说明）；失败（断网等）时保持为 null，不做任何提示
  const [latest, setLatest] = useState<ReleaseInfo | null>(null)
  // 是否存在更新版本：仅此项为 true 时才在版本标签上显示绿点
  const [hasUpdate, setHasUpdate] = useState(false)
  const [releaseOpen, setReleaseOpen] = useState(false)
  const [lanOpen, setLanOpen] = useState(false)
  const [connectOpen, setConnectOpen] = useState(false)
  const [lanConn, setLanConn] = useState(getLanConnStatus())

  useEffect(() => onLanStatus(setLanConn), [])

  // 应用版本号（Tauri 运行时；开发环境取不到时静默留空）
  useEffect(() => {
    let disposed = false
    getVersion()
      .then((v) => {
        if (disposed) return null
        setVersion(v)
        // 用拿到的版本号比较，避免闭包读到旧的空值
        return checkLatestRelease().then((info) => {
          if (disposed || !info) return
          // 无论如何都保存最新 release，便于随时查看其说明
          setLatest(info)
          setHasUpdate(isNewer(info.version, v))
        })
      })
      .catch(() => {})
    return () => {
      disposed = true
    }
  }, [])

  const mobile = isMobile()
  // 电脑端：是否有手机端已连上本机的同步服务（顶部「连接」按钮据此显示「已连接」）
  const [pcConnected, setPcConnected] = useState(false)
  // 横屏检测：移动端横屏 + 地图页时隐藏顶部工具栏（logo/设置那条），全屏看图
  const [landscape, setLandscape] = useState(
    () => typeof window !== 'undefined' && window.matchMedia('(orientation: landscape)').matches,
  )
  useEffect(() => {
    const mq = window.matchMedia('(orientation: landscape)')
    const onChange = () => setLandscape(mq.matches)
    onChange()
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])
  const hideBar = mobile && landscape && page === 'map'

  // 电脑端连接状态：首次查询一次服务状态（服务可能在打开本窗口前就已启动），
  // 之后由后端 lan-client-connected / lan-client-disconnected 事件实时更新，不做轮询。
  useEffect(() => {
    if (mobile) return
    let disposed = false
    const offs: (() => void)[] = []
    getLanStatus()
      .then((s) => {
        if (!disposed) setPcConnected(s.connections > 0)
      })
      .catch(() => {})
    Promise.all([
      listen('lan-client-connected', () => setPcConnected(true)),
      // payload = 是否仍有客户端在线（单设备限制下被新连接顶掉时仍为 true）
      listen<boolean>('lan-client-disconnected', (e) => setPcConnected(e.payload === true)),
    ])
      .then((us) => {
        if (disposed) us.forEach((u) => u())
        else offs.push(...us)
      })
      .catch(() => {})
    return () => {
      disposed = true
      offs.forEach((u) => u())
    }
  }, [mobile])

  return (
    <>
      {!hideBar && (
      <header
        className="flex items-stretch bg-ink-800 border-b border-line shrink-0 select-none"
      >
        {/* 左侧：品牌 + 导航（空白处可拖动窗口） */}
        <div className="flex h-10 items-center gap-2 pl-3">
        <img src="/icons/icon.png" alt="" className="w-5 h-5 rounded shrink-0" />
        <span className="font-medium text-[15px]">IC Tarkov</span>
        {version && (
          <button
            onClick={() => setReleaseOpen(true)}
            title={
              hasUpdate
                ? `有新版本 v${latest?.version}，点击查看更新内容`
                : '查看最新版本信息'
            }
            className="flex items-center gap-1 text-[11px] text-muted px-1.5 py-[1px] rounded bg-ink-700 border border-line hover:text-[#e6edf3]"
          >
            v{version}
            {hasUpdate && <span className="w-1.5 h-1.5 rounded-full bg-ok" />}
          </button>
        )}
        {/* 导航：跟在版本号后面（移动端改为底部 Tab，见组件末尾） */}
        {!mobile && (
        <nav className="flex items-center gap-1 ml-2">
          {NAV_ITEMS.map((it) => (
            <button
              key={it.key}
              onClick={() => setPage(it.key)}
              className={`flex items-center gap-1.5 px-5 h-7 rounded text-[13px] leading-none transition-colors ${
                page === it.key
                  ? 'bg-amber/15 text-[#d4a174] border border-amber/60'
                  : 'text-muted hover:text-[#e6edf3] border border-transparent'
              }`}
            >
              {it.key === 'monitor' && (
                <span className={`w-1.5 h-1.5 rounded-full ${live ? 'bg-ok' : 'bg-red-500'}`} />
              )}
              {it.label}
            </button>
          ))}
        </nav>
        )}
      </div>

      {/* 中间：可拖动窗口的空白区域（仅桌面；移动端无窗口拖拽概念） */}
      {mobile ? (
        <div className="flex-1 self-stretch min-w-0" />
      ) : (
        <div data-tauri-drag-region className="flex-1 self-stretch min-w-0" />
      )}

      {/* 右侧：错误提示 + 设置 + 窗口控制 */}
      <div className="flex h-10 items-center gap-2 pr-2">
        {watcher.error && (
          <span className="text-[11px] text-red-400 truncate max-w-[180px]" title={watcher.error}>
            {watcher.error}
          </span>
        )}
        {/* 连接（做服务端）：仅桌面；手机端无意义。已连上手机时显示绿点「已连接」 */}
        {!mobile && (
          <button
            onClick={() => setLanOpen(true)}
            title={
              pcConnected
                ? '手机端已连接，点击管理连接（二维码 / 停止服务）'
                : '连接：手机扫码连接本机，实时同步任务与地图'
            }
            className={`flex items-center gap-1.5 px-2.5 py-1 rounded border text-[12px] transition-colors ${
              pcConnected
                ? 'border-ok/50 bg-ok/10 text-ok'
                : 'border-line hover:bg-ink-700 text-[#e6edf3]'
            }`}
          >
            {pcConnected && <span className="w-1.5 h-1.5 rounded-full bg-ok" />}
            {pcConnected ? '已连接' : '连接'}
          </button>
        )}
        {/* 连接（做客户端）：仅移动端；桌面无摄像头扫码场景。文本三态：连接/连接中/已连接 */}
        {mobile && (
          <button
            onClick={() => setConnectOpen(true)}
            title={
              lanConn === 'connected'
                ? '已连接电脑端，点击管理连接'
                : lanConn === 'connecting'
                  ? '正在连接电脑端…'
                  : '连接电脑端，实时跟随电脑'
            }
            className={`flex items-center gap-1.5 px-2.5 py-1 rounded border text-[12px] transition-colors ${
              lanConn === 'connected'
                ? 'border-ok/50 bg-ok/10 text-ok'
                : 'border-line hover:bg-ink-700 text-[#e6edf3]'
            }`}
          >
            {lanConn === 'connected' && <span className="w-1.5 h-1.5 rounded-full bg-ok" />}
            {lanConn === 'connected' ? '已连接' : lanConn === 'connecting' ? '连接中' : '连接'}
          </button>
        )}
        <button
          onClick={openSettings}
          title="设置"
          className="px-2.5 py-1 rounded border border-line text-[12px] hover:bg-ink-700 text-[#e6edf3]"
        >
          ⚙ 设置
        </button>
        <button
          onClick={onShowHelp}
          title="帮助 / 使用说明"
          className="px-1 text-[14px] text-muted hover:text-[#e6edf3] transition-colors"
        >
          ?
        </button>
      </div>

      {/* 窗口控制按钮（仅桌面） */}
      {!mobile && (
        <>
          <div className="w-px self-stretch bg-line mx-1" />
          <WinButton onClick={() => win.minimize()} label="─" title="最小化" />
          <WinButton onClick={() => win.toggleMaximize()} label="▢" title="最大化 / 还原" />
          <WinButton onClick={() => win.close()} label="✕" title="关闭" danger />
        </>
      )}
      </header>
      )}

      {/* 版本 / 更新内容 */}
      {releaseOpen && (
        <div
          className="fixed inset-0 z-[1500] flex items-center justify-center bg-black/60"
          onClick={() => setReleaseOpen(false)}
        >
          <div
            className="w-[520px] max-w-[calc(100vw-32px)] max-h-[70vh] flex flex-col rounded-2xl border border-line bg-ink-800 shadow-2xl overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="relative px-5 pt-5 pb-4 border-b border-line bg-gradient-to-b from-ink-700/60 to-transparent">
              <button
                onClick={() => setReleaseOpen(false)}
                className="absolute top-3 right-3 w-7 h-7 grid place-items-center rounded-md text-[15px] text-muted hover:text-[#e6edf3] hover:bg-ink-700"
                aria-label="关闭"
              >
                ✕
              </button>
              <div className="text-[17px] font-semibold text-[#e6edf3]">
                {hasUpdate
                  ? `发现新版本 v${latest?.version}`
                  : `当前版本 v${version || '—'}`}
              </div>
              <div className="mt-1 text-[13px] text-muted">
                {latest
                  ? hasUpdate
                    ? `当前版本 v${version || '—'} · 以下是 v${latest.version} 的更新内容`
                    : `已是最新版本 · 当前为 v${latest.version}`
                  : '暂无版本信息'}
              </div>
            </div>

            <div className="px-5 py-4 overflow-y-auto flex-1 min-h-0">
              {latest ? (
                latest.notes ? (
                  <div className="text-[13px] text-[#c9d1d9] leading-relaxed break-words release-notes">
                    <ReactMarkdown
                      remarkPlugins={[remarkGfm]}
                      components={{
                        a: ({ href, children }) => (
                          <a
                            href={href}
                            className="text-[#d4a174] hover:underline"
                            onClick={(e) => {
                              e.preventDefault()
                              if (href) openUrl(href)
                            }}
                          >
                            {children}
                          </a>
                        ),
                      }}
                    >
                      {latest.notes}
                    </ReactMarkdown>
                  </div>
                ) : (
                  <div className="text-[13px] text-muted leading-relaxed">
                    （该版本未提供更新说明）
                  </div>
                )
              ) : (
                <div className="text-[13px] text-muted leading-relaxed">
                  未能获取版本信息（可能未联网）。可前往 Releases 页面查看更新记录。
                </div>
              )}
            </div>

            <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-line">
              <button
                onClick={() => setReleaseOpen(false)}
                className="px-3 py-1.5 rounded border border-line text-[13px] text-muted hover:text-[#e6edf3] hover:bg-ink-700"
              >
                关闭
              </button>
              <button
                onClick={() => openUrl(latest?.url || RELEASES_PAGE)}
                className="px-3 py-1.5 rounded bg-amber text-black text-[13px] font-medium hover:opacity-90"
              >
                前往下载
              </button>
            </div>
          </div>
        </div>
      )}

      <LanSyncModal open={lanOpen} onClose={() => setLanOpen(false)} />
      <LanConnectModal open={connectOpen} onClose={() => setConnectOpen(false)} />

      {/* 移动端底部 Tab 导航 */}
      {mobile && (
        <nav
          className="fixed bottom-0 left-0 right-0 z-[1100] flex bg-ink-800 border-t border-line"
          style={{
            height: 'var(--nav-h)',
            paddingBottom: 'env(safe-area-inset-bottom)',
          }}
        >
          {NAV_ITEMS.map((it) => (
            <button
              key={it.key}
              onClick={() => setPage(it.key)}
              className={`flex-1 h-full flex items-center justify-center text-[13px] transition-colors ${
                page === it.key ? 'text-[#d4a174] bg-amber/10' : 'text-muted'
              }`}
            >
              {it.key === 'monitor' && (
                <span className={`w-1.5 h-1.5 rounded-full mr-1.5 ${live ? 'bg-ok' : 'bg-red-500'}`} />
              )}
              {it.label}
            </button>
          ))}
        </nav>
      )}
    </>
  )
}
