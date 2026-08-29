import { useState } from 'react'
import { open } from '@tauri-apps/plugin-dialog'
import { useStore } from '../store'
import {
  saveSettings,
  startWatching,
  getPlayerQuests,
  resetAndRescan,
  exportData,
  importData,
  openDataDir,
} from '../tauri'

async function pickDirectory(current: string): Promise<string | null> {
  const selected = await open({
    directory: true,
    multiple: false,
    title: '选择目录',
    defaultPath: current || undefined,
  })
  return typeof selected === 'string' ? selected : null
}

function DirField({
  label,
  value,
  onChange,
}: {
  label: string
  value: string
  onChange: (v: string) => void
}) {
  const [picking, setPicking] = useState(false)

  const onPick = async () => {
    setPicking(true)
    try {
      const dir = await pickDirectory(value)
      if (dir) onChange(dir)
    } catch (e) {
      console.error('选择目录失败', e)
    } finally {
      setPicking(false)
    }
  }

  return (
    <div>
      <label className="text-[14px] text-muted block mb-1">{label}</label>
      <div className="flex items-center gap-2">
        <div className="flex-1 min-w-0 bg-ink-700 border border-line rounded px-3 py-2 text-[14px] text-[#e6edf3] font-mono truncate">
          {value ? (
            value
          ) : (
            <span className="text-muted">未选择</span>
          )}
        </div>
        <button
          onClick={onPick}
          disabled={picking}
          className="px-3 py-2 rounded border border-line text-[14px] text-[#e6edf3] hover:bg-ink-600 shrink-0 disabled:opacity-50"
        >
          {picking ? '打开中…' : '选择目录…'}
        </button>
      </div>
    </div>
  )
}

export default function SettingsModal() {
  const settings = useStore((s) => s.settings)
  const setSettings = useStore((s) => s.setSettings)
  const closeSettings = useStore((s) => s.closeSettings)
  const seedPlayerQuests = useStore((s) => s.seedPlayerQuests)
  const clearHistorical = useStore((s) => s.clearHistorical)

  const [logDir, setLogDir] = useState(settings.logDir)
  const [shotDir, setShotDir] = useState(settings.screenshotDir)
  const [deleteShots, setDeleteShots] = useState(settings.deleteScreenshots)
  const [saving, setSaving] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [feedback, setFeedback] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const onSave = async () => {
    if (!logDir.trim()) {
      setError('请先选择日志监控目录')
      return
    }
    setSaving(true)
    setError(null)
    try {
      // 不传 profile：后端按现有设置合并，避免覆盖「角色管理」页的数据
      const st = await saveSettings(
        logDir.trim(),
        shotDir.trim(),
        deleteShots,
      )
      setSettings(st)
      // 用新目录重启监控并重新加载任务（历史活动默认不读取）
      await startWatching(st.logDir)
      seedPlayerQuests(await getPlayerQuests())
      closeSettings()
    } catch (e) {
      setError(String(e))
    } finally {
      setSaving(false)
    }
  }

  const onRescan = async () => {
    setBusy('rescan')
    setError(null)
    setFeedback(null)
    try {
      await resetAndRescan()
      clearHistorical()
      seedPlayerQuests(await getPlayerQuests())
      setFeedback('已清空并重新读取日志')
    } catch (e) {
      setError(String(e))
    } finally {
      setBusy(null)
    }
  }

  const onOpenDataDir = async () => {
    setError(null)
    try {
      await openDataDir()
    } catch (e) {
      setError(String(e))
    }
  }

  const onExport = async () => {
    setBusy('export')
    setError(null)
    setFeedback(null)
    try {
      const p = await open({
        save: true,
        title: '导出数据',
        defaultPath: 'quest_state.json',
      })
      if (typeof p === 'string') {
        await exportData(p)
        setFeedback('数据已导出')
      }
    } catch (e) {
      setError(String(e))
    } finally {
      setBusy(null)
    }
  }

  const onImport = async () => {
    setBusy('import')
    setError(null)
    setFeedback(null)
    try {
      const p = await open({
        multiple: false,
        title: '导入数据',
        filters: [{ name: 'JSON', extensions: ['json'] }],
      })
      if (typeof p === 'string') {
        await importData(p)
        clearHistorical()
        seedPlayerQuests(await getPlayerQuests())
        setFeedback('数据已导入')
      }
    } catch (e) {
      setError(String(e))
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="fixed inset-0 z-[2000] flex items-center justify-center bg-black/60">
      <div className="w-[560px] bg-ink-800 border border-line rounded-xl p-5 shadow-2xl">
        <div className="flex items-center mb-4">
          <span className="text-[17px] font-medium">设置</span>
          <button
            onClick={closeSettings}
            className="ml-auto text-muted hover:text-[#e6edf3] text-[15px]"
          >
            ✕
          </button>
        </div>

        <div className="space-y-4">
          <DirField label="日志监控目录" value={logDir} onChange={setLogDir} />
          <DirField
            label="截图监控目录（地图页玩家定位）"
            value={shotDir}
            onChange={setShotDir}
          />

          <label className="flex items-center gap-3 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={deleteShots}
              onChange={(e) => setDeleteShots(e.target.checked)}
              className="w-4 h-4 accent-amber"
            />
            <span className="text-[15px] text-[#e6edf3]">
              读取坐标后删除截图
              <span className="block text-[13px] text-muted">
                关闭后截图会保留在目录中（可能重复定位到同一张）
              </span>
            </span>
          </label>

          {error && (
            <div className="text-[14px] text-red-400 border border-red-400/40 rounded px-3 py-2">
              {error}
            </div>
          )}

          {/* 数据管理 */}
          <div className="border-t border-line pt-4">
            <div className="text-[14px] text-muted mb-2">数据管理</div>
            <div className="flex flex-wrap gap-2">
              <button
                onClick={onRescan}
                disabled={busy !== null}
                className="px-3 py-1.5 rounded border border-line text-[14px] text-[#e6edf3] hover:bg-ink-700 disabled:opacity-50"
              >
                {busy === 'rescan' ? '读取中…' : '重新读取日志'}
              </button>
              <button
                onClick={onExport}
                disabled={busy !== null}
                className="px-3 py-1.5 rounded border border-line text-[14px] text-[#e6edf3] hover:bg-ink-700 disabled:opacity-50"
              >
                {busy === 'export' ? '导出中…' : '导出数据'}
              </button>
              <button
                onClick={onImport}
                disabled={busy !== null}
                className="px-3 py-1.5 rounded border border-line text-[14px] text-[#e6edf3] hover:bg-ink-700 disabled:opacity-50"
              >
                {busy === 'import' ? '导入中…' : '导入数据'}
              </button>
              <button
                onClick={onOpenDataDir}
                className="px-3 py-1.5 rounded border border-line text-[14px] text-[#e6edf3] hover:bg-ink-700"
                title="打开持久化文件所在目录（settings.json / quest_state.json）"
              >
                打开数据目录
              </button>
            </div>
            <div className="text-[13px] text-muted mt-2">
              重新读取日志：清空任务持久化文件，从零全量扫描日志重新生成。
              导出 / 导入：备份或恢复任务进度与扫描记录（quest_state.json）。
              打开数据目录：查看持久化配置与任务进度文件。
            </div>
            {feedback && (
              <div className="text-[14px] text-ok mt-2">{feedback}</div>
            )}
          </div>

          <div className="flex justify-end gap-2 pt-1">
            <button
              onClick={closeSettings}
              className="px-4 py-1.5 rounded border border-line text-[14px] text-muted hover:text-[#e6edf3] hover:bg-ink-700"
            >
              取消
            </button>
            <button
              onClick={onSave}
              disabled={saving}
              className="px-4 py-1.5 rounded bg-amber text-black text-[14px] font-medium hover:opacity-90 disabled:opacity-50"
            >
              {saving ? '保存中…' : '保存'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
