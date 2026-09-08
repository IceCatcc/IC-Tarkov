import { useEffect, useState } from 'react'
import { listen } from '@tauri-apps/api/event'
import * as QRCode from 'qrcode'
import {
  startLanSync,
  stopLanSync,
  getConnectInfo,
  type ConnectInfo,
} from '../tauri'

/** 电脑端「连接」页：扫码让手机连接（仅限一台），实时跟随电脑端任务/地图。 */
export function LanSyncModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [info, setInfo] = useState<ConnectInfo | null>(null)
  const [qr, setQr] = useState<string>('')
  const [err, setErr] = useState<string>('')

  const refresh = () => {
    getConnectInfo()
      .then(setInfo)
      .catch((e) => setErr(String(e)))
  }

  useEffect(() => {
    if (!open) return
    setErr('')
    startLanSync()
      .then(refresh)
      .catch((e) => setErr(String(e)))
    const timer = window.setInterval(refresh, 2000)
    // 注意：关闭界面不停服务——服务保持运行，手机端连接才能持续；
    // 需要停止时用界面里的「停止服务」按钮显式关闭
    return () => {
      window.clearInterval(timer)
    }
  }, [open])

  useEffect(() => {
    if (!info) return
    const url = `ictarkov://connect?hosts=${info.hosts.join(',')}&port=${info.port}`
    QRCode.toDataURL(url)
      .then(setQr)
      .catch(() => setQr(''))
  }, [info])

  // 手机端连上后自动关闭本窗口：服务端在连接建立时发 lan-client-connected 事件。
  // 服务保持运行，手机端连接不会因此断开。
  useEffect(() => {
    if (!open) return
    let disposed = false
    let off: (() => void) | undefined
    listen('lan-client-connected', () => onClose())
      .then((u) => {
        if (disposed) u()
        else off = u
      })
      .catch(() => {})
    return () => {
      disposed = true
      off?.()
    }
  }, [open, onClose])

  if (!open) return null

  return (
    <div
      className="fixed inset-0 z-[1500] flex items-center justify-center bg-black/60"
      onClick={onClose}
    >
      <div
        className="w-[460px] max-w-[calc(100vw-32px)] max-h-[82vh] flex flex-col rounded-2xl border border-line bg-ink-800 shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="relative px-5 pt-5 pb-4 border-b border-line">
          <button
            onClick={onClose}
            className="absolute top-3 right-3 w-7 h-7 grid place-items-center rounded-md text-[15px] text-muted hover:text-[#e6edf3] hover:bg-ink-700"
            aria-label="关闭"
          >
            ✕
          </button>
          <div className="text-[17px] font-semibold text-[#e6edf3]">连接</div>
          <div className="mt-1 text-[13px] text-muted">
            手机端 App 扫码即可连接（仅限一台设备），实时跟随本机的任务 / 地图 / 模式变化。
          </div>
        </div>

        <div className="px-5 py-4 overflow-y-auto flex-1 min-h-0 flex flex-col items-center gap-4">
          {err && (
            <div className="text-[12px] text-red-400 text-center">启动失败：{err}</div>
          )}

          {qr ? (
            <img src={qr} alt="连接二维码" className="w-48 h-48 rounded-lg bg-white p-2" />
          ) : (
            <div className="w-48 h-48 rounded-lg bg-ink-700 grid place-items-center text-[12px] text-muted">
              生成二维码中…
            </div>
          )}

          <div className="w-full text-[12px] text-muted space-y-1">
            <div className="flex justify-between gap-2">
              <span className="shrink-0">端口</span>
              <span className="text-[#e6edf3] break-all">{info?.port ?? '—'}</span>
            </div>
            <div>
              <div className="mb-1">可连接地址：</div>
              <ul className="space-y-0.5">
                {info?.hosts.map((h) => (
                  <li key={h} className="text-[#e6edf3] break-all">
                    {h}:{info.port}
                  </li>
                ))}
                {(info?.hosts.length ?? 0) === 0 && (
                  <li className="text-muted">未检测到非回环网卡地址</li>
                )}
              </ul>
            </div>
          </div>

          <div className="text-[11px] text-muted/80 text-center leading-relaxed">
            二维码内容含本机所有网卡 IP，手机会逐个尝试连接。防火墙可能拦截端口
            {info?.port ? ` ${info.port}` : ''}，首次使用请允许通过。
          </div>
        </div>

        <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-line">
          <button
            onClick={() => {
              stopLanSync().catch(() => {})
              onClose()
            }}
            className="px-3 py-1.5 rounded border border-[#5c2b2b] text-[13px] text-red-400 hover:bg-[#1a1214]"
            title="停止同步服务，断开手机端"
          >
            停止服务
          </button>
          <button
            onClick={onClose}
            className="px-3 py-1.5 rounded border border-line text-[13px] text-muted hover:text-[#e6edf3] hover:bg-ink-700"
            title="仅关闭窗口，服务保持运行，手机端连接不断开"
          >
            关闭
          </button>
        </div>
      </div>
    </div>
  )
}
