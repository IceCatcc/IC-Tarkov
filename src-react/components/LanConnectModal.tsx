import { useEffect, useState } from 'react'
import { useStore } from '../store'
import { isMobile } from '../platform'
import { scanQr } from '../tauri'
import {
  connectLan,
  disconnectLan,
  getLanConnStatus,
  onLanStatus,
  parseConnectUrl,
  type LanConnStatus,
  type ParsedConnect,
} from '../lan'

/**
 * 手机端连接视图。
 * - 移动端：主入口是「扫码连接」（调用摄像头识别电脑端二维码），手动输入仅作兜底。
 * - 电脑端入口已在 TopBar 按平台隐藏，此弹窗实际只在移动端触达。
 */
export function LanConnectModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [hosts, setHosts] = useState('')
  const [port, setPort] = useState('9527')
  const [token, setToken] = useState('')
  const [status, setStatus] = useState<LanConnStatus>(getLanConnStatus())
  const [scanning, setScanning] = useState(false)
  const [showManual, setShowManual] = useState(false)
  const pushToast = useStore((s) => s.pushToast)

  useEffect(() => {
    if (!open) return
    return onLanStatus(setStatus)
  }, [open])

  if (!open) return null

  const doConnect = (c: ParsedConnect) => {
    void connectLan(c, { auto: true })
  }

  // 扫码：识别电脑端二维码内容 ictarkov://connect?hosts=...&port=...&token=...
  const doScan = async () => {
    setScanning(true)
    try {
      const text = await scanQr()
      if (!text) {
        pushToast('未识别到二维码或相机不可用', 'info')
        return
      }
      const c = parseConnectUrl(text)
      if (!c) {
        pushToast('二维码不是本应用的连接码', 'info')
        return
      }
      doConnect(c)
    } finally {
      setScanning(false)
    }
  }

  const doManualConnect = () => {
    const hostList = hosts
      .split(',')
      .map((x) => x.trim())
      .filter(Boolean)
    const p = Number(port)
    if (!hostList.length || !p || !token.trim()) {
      pushToast('请填写 IP、端口与配对码', 'info')
      return
    }
    doConnect({ hosts: hostList, port: p, token: token.trim() })
  }

  const connected = status === 'connected'

  const statusText =
    status === 'connected' ? '已连接' : status === 'connecting' ? '连接中…' : '未连接'
  const statusDot =
    status === 'connected' ? 'bg-ok' : status === 'connecting' ? 'bg-amber' : 'bg-red-500'

  return (
    <div
      className="fixed inset-0 z-[1500] flex items-center justify-center bg-black/60"
      onClick={onClose}
    >
      <div
        className="w-[440px] max-w-[calc(100vw-32px)] rounded-2xl border border-line bg-ink-800 shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* 头部 */}
        <div className="relative px-5 pt-5 pb-4 border-b border-line bg-gradient-to-b from-ink-700/60 to-transparent">
          <button
            onClick={onClose}
            className="absolute top-3 right-3 w-7 h-7 grid place-items-center rounded-md text-[15px] text-muted hover:text-[#e6edf3] hover:bg-ink-700"
            aria-label="关闭"
          >
            ✕
          </button>
          <div className="text-[17px] font-semibold text-[#e6edf3]">连接到电脑端</div>
          <div className="mt-1 text-[13px] text-muted">
            扫描电脑端「局域网同步」里的二维码
          </div>
        </div>

        <div className="px-5 py-4 space-y-3">
          {/* 状态 */}
          <div className="flex items-center gap-2 text-[13px] text-muted">
            <span className={`w-2 h-2 rounded-full ${statusDot}`} />
            连接状态：{statusText}
          </div>

          {/* 扫码主入口（移动端） */}
          {isMobile() && (
            <button
              onClick={() => void doScan()}
              disabled={scanning}
              className="w-full py-3 rounded-lg bg-amber text-black text-[15px] font-medium hover:opacity-90 disabled:opacity-50"
            >
              {scanning ? '正在打开相机…' : '扫码连接'}
            </button>
          )}

          {/* 手动输入兜底 */}
          {showManual ? (
            <div className="space-y-3">
              <div>
                <label className="text-[13px] text-[#c9d1d9]">电脑端 IP（多个用逗号分隔）</label>
                <input
                  value={hosts}
                  onChange={(e) => setHosts(e.target.value)}
                  placeholder="192.168.1.5"
                  className="mt-1 w-full px-3 py-2 rounded-lg bg-ink-900 border border-line text-[13px] text-[#e6edf3] outline-none focus:border-amber/60"
                />
              </div>
              <div className="flex gap-3">
                <div className="flex-1">
                  <label className="text-[13px] text-[#c9d1d9]">端口</label>
                  <input
                    value={port}
                    onChange={(e) => setPort(e.target.value)}
                    inputMode="numeric"
                    className="mt-1 w-full px-3 py-2 rounded-lg bg-ink-900 border border-line text-[13px] text-[#e6edf3] outline-none focus:border-amber/60"
                  />
                </div>
                <div className="flex-1">
                  <label className="text-[13px] text-[#c9d1d9]">配对码</label>
                  <input
                    value={token}
                    onChange={(e) => setToken(e.target.value)}
                    placeholder="电脑端显示的一串字符"
                    className="mt-1 w-full px-3 py-2 rounded-lg bg-ink-900 border border-line text-[13px] text-[#e6edf3] outline-none focus:border-amber/60"
                  />
                </div>
              </div>
              <button
                onClick={doManualConnect}
                className="w-full py-2 rounded-lg border border-line text-[13px] text-[#e6edf3] hover:bg-ink-700"
              >
                连接
              </button>
            </div>
          ) : (
            <button
              onClick={() => setShowManual(true)}
              className="w-full text-[13px] text-muted hover:text-[#e6edf3]"
            >
              扫码不可用？手动输入连接信息
            </button>
          )}
        </div>

        {/* 操作 */}
        <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-line">
          {connected && (
            <button
              onClick={() => disconnectLan()}
              className="px-3 py-1.5 rounded border border-line text-[13px] text-muted hover:text-[#e6edf3] hover:bg-ink-700"
            >
              断开连接
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
