import { useEffect, useRef, useState } from 'react'
import jsQR from 'jsqr'
import { useStore } from '../store'
import { isMobile } from '../platform'
import { ensureCameraPermission, scanQr } from '../tauri'
import {
  connectLan,
  disconnectLan,
  getLanConnStatus,
  onLanStatus,
  parseConnectUrl,
  type LanConnStatus,
  type ParsedConnect,
} from '../lan'

/** 解析成功的连接动作 */
type ConnectFn = (c: ParsedConnect) => void

/**
 * 页面内取景框扫码：WebView getUserMedia + jsQR，只取中央正方形区域识别。
 * 相机不可用（权限被拒/WebView 不支持）时通过 onError 回退原生全屏扫码。
 */
function QrScanner({
  onResult,
  onError,
}: {
  onResult: (text: string) => void
  onError: (msg: string) => void
}) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const boxRef = useRef<HTMLCanvasElement>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const rafRef = useRef(0)

  useEffect(() => {
    let stopped = false
    const cleanup = () => {
      stopped = true
      cancelAnimationFrame(rafRef.current)
      streamRef.current?.getTracks().forEach((t) => t.stop())
      streamRef.current = null
    }

    ;(async () => {
      try {
        if (!navigator.mediaDevices?.getUserMedia) {
          throw new Error('WebView 不支持相机采集')
        }
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'environment' },
        })
        if (stopped) {
          stream.getTracks().forEach((t) => t.stop())
          return
        }
        streamRef.current = stream
        const video = videoRef.current
        if (!video) return
        video.srcObject = stream
        await video.play().catch(() => {})

        const SIZE = 260 // 解码采样边长（性能与识别率的平衡）
        const loop = () => {
          if (stopped) return
          const canvas = boxRef.current
          const v = videoRef.current
          if (canvas && v && v.readyState >= 2 && v.videoWidth > 0) {
            // 只取视频画面中央的正方形区域
            const side = Math.min(v.videoWidth, v.videoHeight)
            const sx = (v.videoWidth - side) / 2
            const sy = (v.videoHeight - side) / 2
            canvas.width = SIZE
            canvas.height = SIZE
            const ctx = canvas.getContext('2d', { willReadFrequently: true })
            if (ctx) {
              ctx.drawImage(v, sx, sy, side, side, 0, 0, SIZE, SIZE)
              const img = ctx.getImageData(0, 0, SIZE, SIZE)
              const code = jsQR(img.data, SIZE, SIZE)
              if (code?.data) {
                cleanup()
                onResult(code.data)
                return
              }
            }
          }
          rafRef.current = requestAnimationFrame(loop)
        }
        rafRef.current = requestAnimationFrame(loop)
      } catch (e) {
        cleanup()
        onError(String((e as Error)?.message ?? e))
      }
    })()

    return cleanup
  }, [onResult, onError])

  return (
    <div className="relative mx-auto aspect-square w-full max-w-[300px] overflow-hidden rounded-xl bg-black">
      <video ref={videoRef} playsInline muted className="absolute inset-0 h-full w-full object-cover" />
      {/* 中央取景框：四角标记 */}
      <div className="pointer-events-none absolute inset-0 grid place-items-center">
        <div className="relative h-[62%] w-[62%]">
          {['left-0 top-0 border-l-2 border-t-2', 'right-0 top-0 border-r-2 border-t-2', 'left-0 bottom-0 border-l-2 border-b-2', 'right-0 bottom-0 border-r-2 border-b-2'].map(
            (cls) => (
              <span key={cls} className={`absolute h-6 w-6 border-amber ${cls}`} />
            ),
          )}
        </div>
      </div>
      {/* 解码采样画布（不可见） */}
      <canvas ref={boxRef} className="hidden" />
    </div>
  )
}

/**
 * 手机端连接视图。
 * - 移动端：主入口是「扫码连接」（页面内取景框识别电脑端二维码），手动输入仅作兜底。
 * - 电脑端入口已在 TopBar 按平台隐藏，此弹窗实际只在移动端触达。
 */
export function LanConnectModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [hosts, setHosts] = useState('')
  const [port, setPort] = useState('9527')
  const [token, setToken] = useState('')
  const [status, setStatus] = useState<LanConnStatus>(getLanConnStatus())
  const [scanning, setScanning] = useState(false)
  const [scanMode, setScanMode] = useState(false)
  const [showManual, setShowManual] = useState(false)
  const pushToast = useStore((s) => s.pushToast)

  useEffect(() => {
    if (!open) return
    return onLanStatus(setStatus)
  }, [open])

  if (!open) return null

  const doConnect = (c: ParsedConnect) => {
    setScanMode(false)
    void connectLan(c, { auto: true })
  }

  // 从二维码内容解析并连接
  const acceptScan = (raw: string) => {
    const c = parseConnectUrl(raw)
    if (!c) {
      pushToast('二维码不是本应用的连接码', 'info')
      return
    }
    doConnect(c)
  }

  // 打开页面内取景框扫码；相机不可用时回退原生全屏扫码
  const doScan = async () => {
    setScanning(true)
    await ensureCameraPermission()
    setScanning(false)
    setScanMode(true)
  }

  const onScannerError = (msg: string) => {
    setScanMode(false)
    pushToast(`页面相机不可用（${msg}），改用系统扫码`, 'info')
    void (async () => {
      setScanning(true)
      const { text, error } = await scanQr()
      setScanning(false)
      if (!text) {
        pushToast(error ? `扫码失败：${error}` : '未识别到二维码', 'info')
        return
      }
      acceptScan(text)
    })()
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
            onClick={() => {
              setScanMode(false)
              onClose()
            }}
            className="absolute top-3 right-3 w-7 h-7 grid place-items-center rounded-md text-[15px] text-muted hover:text-[#e6edf3] hover:bg-ink-700"
            aria-label="关闭"
          >
            ✕
          </button>
          <div className="text-[17px] font-semibold text-[#e6edf3]">连接到电脑端</div>
          <div className="mt-1 text-[13px] text-muted">
            {scanMode ? '对准电脑端「同步」里的二维码' : '扫描电脑端「同步」里的二维码'}
          </div>
        </div>

        <div className="px-5 py-4 space-y-3">
          {/* 状态 */}
          <div className="flex items-center gap-2 text-[13px] text-muted">
            <span className={`w-2 h-2 rounded-full ${statusDot}`} />
            连接状态：{statusText}
          </div>

          {connected ? (
            /* 已连接：只显示连接状态与断开入口，再次打开不再出现扫码/输入界面 */
            <div className="space-y-3">
              <div className="rounded-lg border border-ok/40 bg-ok/10 px-3 py-3 text-[13px] text-[#e6edf3]">
                已连接到电脑端，正在实时同步任务与地图数据
              </div>
              <button
                onClick={() => disconnectLan()}
                className="w-full py-2 rounded-lg border border-line text-[13px] text-muted hover:text-[#e6edf3] hover:bg-ink-700"
              >
                断开连接
              </button>
            </div>
          ) : scanMode ? (
            <>
              <QrScanner onResult={acceptScan} onError={onScannerError} />
              <button
                onClick={() => setScanMode(false)}
                className="w-full py-2 rounded-lg border border-line text-[13px] text-muted hover:text-[#e6edf3] hover:bg-ink-700"
              >
                取消扫码
              </button>
            </>
          ) : (
            <>
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
            </>
          )}
        </div>

        {/* 操作（断开入口已并入已连接面板） */}
        <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-line" />
      </div>
    </div>
  )
}
