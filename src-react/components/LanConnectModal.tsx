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

        const SIZE = 480 // 解码采样边长：提升到 480 提升远距离小二维码识别率
        const CROP = 0.72 // 仅取中央 72% 区域解码（数字放大，配合下方预览缩放）
        let lastDecode = 0
        const loop = () => {
          if (stopped) return
          const canvas = boxRef.current
          const v = videoRef.current
          if (canvas && v && v.readyState >= 2 && v.videoWidth > 0) {
            // 仅取画面中央 CROP 比例的正方形区域（数字放大）
            const side = Math.min(v.videoWidth, v.videoHeight) * CROP
            const sx = (v.videoWidth - side) / 2
            const sy = (v.videoHeight - side) / 2
            canvas.width = SIZE
            canvas.height = SIZE
            const ctx = canvas.getContext('2d', { willReadFrequently: true })
            const now = performance.now()
            // 限频解码（~12fps），降低大图解码的性能开销
            if (ctx && now - lastDecode > 80) {
              lastDecode = now
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
      {/* 预览数字放大：缩放 1/CROP 使中央解码区域充满取景框，二维码在画面中更大、可远距扫码 */}
      <video
        ref={videoRef}
        playsInline
        muted
        className="absolute inset-0 h-full w-full object-cover"
        style={{ transform: `scale(${1 / 0.72})`, transformOrigin: 'center' }}
      />
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
  // pending：本次由用户（扫码/手动）发起的连接尝试进行中；用于区分「启动时自动重连」
  const [pending, setPending] = useState(false)
  const [entry, setEntry] = useState<'scan' | 'manual'>('scan')
  const pushToast = useStore((s) => s.pushToast)

  useEffect(() => {
    if (!open) {
      setPending(false)
      setEntry('scan')
      return
    }
    // 打开时重置：进入连接态会重新置位
    setPending(false)
    setEntry('scan')
    return onLanStatus(setStatus)
  }, [open])

  // 由用户发起的连接：成功（connected && pending）自动关闭窗口（lan.ts 已弹「已连接」）；
  // 失败（disconnected && pending）恢复相机/手动输入（失败提示已由 connectLan 在 auto:false 时弹出）。
  // 仅 pending 时响应，避免干扰「启动时自动重连」与「重开窗口查看已连接状态」。
  // 注意：必须在下方 if (!open) return null 之前声明（Hooks 不能出现在条件返回之后）。
  useEffect(() => {
    if (!open) return
    if (status === 'connected' && pending) {
      onClose()
    } else if (status === 'disconnected' && pending) {
      setPending(false)
      if (entry === 'scan') setScanMode(true)
      else setShowManual(true)
    }
  }, [open, status, pending, entry, onClose])

  if (!open) return null

  // 由用户（扫码或手动）发起一次连接尝试：进入 pending 态（暂停相机/显示连接中），
  // 用 auto:false 做单次尝试——成功由下方 effect 关窗，失败则恢复相机/手动输入，不无限重连。
  const startConnect = (c: ParsedConnect, fromScan: boolean) => {
    setEntry(fromScan ? 'scan' : 'manual')
    setScanMode(false)
    setShowManual(false)
    setPending(true)
    void connectLan(c, { auto: false })
  }

  // 从二维码内容解析并连接
  const acceptScan = (raw: string) => {
    const c = parseConnectUrl(raw)
    if (!c) {
      pushToast('二维码不是本应用的连接码', 'info')
      return
    }
    startConnect(c, true)
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
    startConnect({ hosts: hostList, port: p, token: token.trim() }, false)
  }

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
              if (pending) disconnectLan()
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

          {pending ? (
            /* 连接尝试中：暂停相机，显示连接中 */
            <div className="space-y-3">
              <div className="flex items-center justify-center gap-2 py-3 text-[14px] text-[#e6edf3]">
                <span className="w-4 h-4 rounded-full border-2 border-amber border-t-transparent animate-spin" />
                连接中…
              </div>
              <button
                onClick={() => {
                  disconnectLan()
                  setPending(false)
                  if (entry === 'scan') setScanMode(true)
                  else setShowManual(true)
                }}
                className="w-full py-2 rounded-lg border border-line text-[13px] text-muted hover:text-[#e6edf3] hover:bg-ink-700"
              >
                取消
              </button>
            </div>
          ) : status === 'connected' ? (
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
