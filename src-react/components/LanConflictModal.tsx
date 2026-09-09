import { Fragment, useEffect, useState } from 'react'
import { listen } from '@tauri-apps/api/event'
import { resolveLanConflict, type SyncSummary } from '../tauri'
import { useStore } from '../store'

interface ConflictPayload {
  local: SyncSummary
  remote: SyncSummary
}

/**
 * 电脑端：手机端连上后若两端数据不一致，让用户选择以哪一端数据为准。
 * 由后端 `lan-sync-conflict` 事件驱动；选择结果经 `resolve_lan_conflict` 下发。
 */
export function LanConflictModal() {
  const [data, setData] = useState<ConflictPayload | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let disposed = false
    let off: (() => void) | undefined
    listen<ConflictPayload>('lan-sync-conflict', (e) => {
      setBusy(false)
      setData(e.payload)
    })
      .then((u) => {
        if (disposed) u()
        else off = u
      })
      .catch(() => {})
    return () => {
      disposed = true
      off?.()
    }
  }, [])

  if (!data) return null

  const choose = async (side: 'local' | 'remote' | 'skip') => {
    setBusy(true)
    try {
      await resolveLanConflict(side)
      setData(null)
    } catch (e) {
      useStore.getState().pushToast('同步失败：' + String(e), 'info')
    } finally {
      setBusy(false)
    }
  }

  const rows: { label: string; get: (s: SyncSummary) => number }[] = [
    { label: '进行中的任务', get: (s) => Math.max(0, s.questCount - s.completedCount) },
    { label: '已完成的任务', get: (s) => s.completedCount },
    { label: '收藏家已收集', get: (s) => s.collectedCount },
    { label: '手动解锁任务', get: (s) => s.unlockedCount },
    { label: '角色等级', get: (s) => s.level },
  ]

  return (
    <div className="fixed inset-0 z-[1600] flex items-center justify-center bg-black/60">
      <div className="w-[480px] max-w-[calc(100vw-32px)] max-h-[82vh] flex flex-col rounded-2xl border border-line bg-ink-800 shadow-2xl overflow-hidden">
        <div className="px-5 pt-5 pb-4 border-b border-line">
          <div className="text-[17px] font-semibold text-[#e6edf3]">
            手机端与本机数据不一致
          </div>
          <div className="mt-1 text-[13px] text-muted">
            请选择以哪一端的数据为准，另一端会被覆盖。
          </div>
        </div>

        <div className="px-5 py-4 overflow-y-auto flex-1 min-h-0">
          <div className="grid grid-cols-[1fr_88px_88px] gap-x-3 gap-y-2 text-[13px] items-center">
            <div className="text-muted">数据项</div>
            <div className="text-right text-muted">本机</div>
            <div className="text-right text-muted">手机端</div>
            {rows.map((r) => (
              <Fragment key={r.label}>
                <div className="text-muted">{r.label}</div>
                <div className="text-right text-[#e6edf3]">{r.get(data.local)}</div>
                <div className="text-right text-[#e6edf3]">{r.get(data.remote)}</div>
              </Fragment>
            ))}
          </div>
          <div className="mt-4 text-[11px] text-muted/80 leading-relaxed">
            两侧数值完全相同即代表数据一致，任选其一即可；无法判断时建议保留数据量更大的一端。
          </div>
        </div>

        <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-line flex-wrap">
          <button
            disabled={busy}
            onClick={() => void choose('skip')}
            className="px-3 py-1.5 rounded border border-line text-[13px] text-muted hover:text-[#e6edf3] hover:bg-ink-700 disabled:opacity-50"
            title="两端都保持原样，本次不同步"
          >
            暂不同步
          </button>
          <button
            disabled={busy}
            onClick={() => void choose('remote')}
            className="px-3 py-1.5 rounded border border-line text-[13px] text-muted hover:text-[#e6edf3] hover:bg-ink-700 disabled:opacity-50"
            title="用手机端数据覆盖本机数据"
          >
            用手机端数据
          </button>
          <button
            disabled={busy}
            onClick={() => void choose('local')}
            className="px-3 py-1.5 rounded bg-amber text-black text-[13px] font-medium hover:opacity-90 disabled:opacity-50"
            title="用本机数据覆盖手机端数据"
          >
            用电脑端数据
          </button>
        </div>
      </div>
    </div>
  )
}
