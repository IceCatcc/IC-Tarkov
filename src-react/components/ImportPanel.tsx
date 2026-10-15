import { useRef, useState } from 'react'
import {
  importDataFiles,
  type ImportOutcome,
  type ModeImportStat,
} from '../api/web-account'
import { QUEST_MODE_LABEL } from '../types'

const MODE_ORDER: ModeImportStat['mode'][] = ['pvp', 'pvps', 'pve']

/** 导入结果的逐模式摘要 */
function OutcomeView({ outcome }: { outcome: ImportOutcome }) {
  const byMode = new Map(outcome.modes.map((m) => [m.mode, m]))
  return (
    <div className="space-y-3">
      <div className="text-[13px] text-ok">
        导入完成（{outcome.replace ? '覆盖' : '补充'}）：{outcome.filesUsed.join('、')}
      </div>
      <div className="rounded border border-line overflow-hidden">
        <table className="w-full text-[12px]">
          <thead className="bg-ink-700 text-muted">
            <tr>
              <th className="text-left px-2.5 py-1.5 font-normal">模式</th>
              <th className="text-right px-2.5 py-1.5 font-normal">任务</th>
              <th className="text-right px-2.5 py-1.5 font-normal">已完成</th>
              <th className="text-right px-2.5 py-1.5 font-normal">目标打勾</th>
              <th className="text-right px-2.5 py-1.5 font-normal">收藏</th>
              <th className="text-right px-2.5 py-1.5 font-normal">活动</th>
            </tr>
          </thead>
          <tbody>
            {MODE_ORDER.map((mode) => {
              const s = byMode.get(mode)
              return (
                <tr key={mode} className="border-t border-line">
                  <td className="px-2.5 py-1.5">{QUEST_MODE_LABEL[mode]}</td>
                  <td className="px-2.5 py-1.5 text-right">{s?.quests ?? '—'}</td>
                  <td className="px-2.5 py-1.5 text-right">{s?.completed ?? '—'}</td>
                  <td className="px-2.5 py-1.5 text-right">{s?.objectives ?? '—'}</td>
                  <td className="px-2.5 py-1.5 text-right">{s?.collected ?? '—'}</td>
                  <td className="px-2.5 py-1.5 text-right">{s?.activities ?? '—'}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      {outcome.settingsImported && (
        <div className="text-[12px] text-muted">已一并导入界面偏好（筛选 / 图标显隐 / 缩放等）。</div>
      )}
      {outcome.warnings.length > 0 && (
        <div className="text-[12px] text-amber space-y-1">
          {outcome.warnings.map((w, i) => (
            <div key={i}>· {w}</div>
          ))}
        </div>
      )}
    </div>
  )
}

export function ImportPanel({
  onImported,
  onSkip,
}: {
  onImported?: (o: ImportOutcome) => void
  /** 传了才显示「跳过」按钮（首次登录引导用） */
  onSkip?: () => void
}) {
  const [files, setFiles] = useState<File[]>([])
  const [replace, setReplace] = useState(true)
  const [busy, setBusy] = useState(false)
  const [ratio, setRatio] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [outcome, setOutcome] = useState<ImportOutcome | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)

  const pick = (list: FileList | null) => {
    if (!list) return
    setFiles(Array.from(list))
    setOutcome(null)
    setError(null)
  }

  const doImport = async () => {
    if (files.length === 0 || busy) return
    setBusy(true)
    setRatio(0)
    setError(null)
    try {
      const out = await importDataFiles(files, replace, setRatio)
      setOutcome(out)
      onImported?.(out)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-4">
      <div className="text-[13px] text-muted leading-relaxed">
        支持桌面端「设置 → 导出数据」生成的 <code className="text-[#d4a174]">ic-tarkov-data.zip</code>，
        也可以直接选单个 <code className="text-[#d4a174]">quest_state.*.json</code> /
        <code className="text-[#d4a174]">collected.*.json</code> / <code className="text-[#d4a174]">settings.json</code>。
        三种模式（PVP / PVPS / PVE）会按文件各自的模式归位。
      </div>

      <div
        className="rounded-lg border border-dashed border-line bg-ink-700/40 px-4 py-5 text-center cursor-pointer hover:border-amber/60"
        onClick={() => inputRef.current?.click()}
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault()
          pick(e.dataTransfer.files)
        }}
      >
        <input
          ref={inputRef}
          type="file"
          multiple
          accept=".json,.zip,application/json,application/zip"
          className="hidden"
          onChange={(e) => pick(e.target.files)}
        />
        {files.length === 0 ? (
          <div className="text-[13px] text-muted">点击选择文件，或把文件拖到这里</div>
        ) : (
          <div className="text-[13px] text-[#e6edf3] space-y-0.5">
            {files.map((f) => (
              <div key={f.name}>
                {f.name}
                <span className="text-muted ml-1.5">({Math.max(1, Math.round(f.size / 1024))} KB)</span>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="flex items-center gap-4 text-[13px]">
        <label className="flex items-center gap-1.5 cursor-pointer">
          <input
            type="radio"
            checked={replace}
            onChange={() => setReplace(true)}
            className="accent-[#d4a174]"
          />
          覆盖导入
          <span className="text-muted text-[12px]">（先清空，与桌面端保持一致）</span>
        </label>
        <label className="flex items-center gap-1.5 cursor-pointer">
          <input
            type="radio"
            checked={!replace}
            onChange={() => setReplace(false)}
            className="accent-[#d4a174]"
          />
          补充导入
          <span className="text-muted text-[12px]">（只增不删）</span>
        </label>
      </div>

      {busy && (
        <div className="h-1.5 rounded bg-ink-700 overflow-hidden">
          <div className="h-full bg-amber transition-all" style={{ width: `${Math.round(ratio * 100)}%` }} />
        </div>
      )}
      {error && <div className="text-[13px] text-red-400">{error}</div>}
      {outcome && <OutcomeView outcome={outcome} />}

      <div className="flex items-center justify-end gap-2">
        {onSkip && (
          <button
            onClick={onSkip}
            className="px-3 py-1.5 rounded border border-line text-[13px] text-muted hover:text-[#e6edf3] hover:bg-ink-700"
          >
            先不导入
          </button>
        )}
        <button
          onClick={() => void doImport()}
          disabled={files.length === 0 || busy}
          className="px-3 py-1.5 rounded bg-amber text-black text-[13px] font-medium hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {busy ? '导入中…' : '开始导入'}
        </button>
      </div>
    </div>
  )
}
