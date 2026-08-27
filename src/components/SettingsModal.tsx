import { useState } from 'react'
import { open } from '@tauri-apps/plugin-dialog'
import { useStore } from '../store'
import { saveSettings, startWatching, getPlayerQuests, getActivity } from '../tauri'

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
      <label className="text-[12px] text-muted block mb-1">{label}</label>
      <div className="flex items-center gap-2">
        <div className="flex-1 min-w-0 bg-ink-700 border border-line rounded px-3 py-2 text-[12px] text-[#e6edf3] font-mono truncate">
          {value ? (
            value
          ) : (
            <span className="text-muted">未选择</span>
          )}
        </div>
        <button
          onClick={onPick}
          disabled={picking}
          className="px-3 py-2 rounded border border-line text-[12px] text-[#e6edf3] hover:bg-ink-600 shrink-0 disabled:opacity-50"
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
  const seedActivity = useStore((s) => s.seedActivity)

  const [logDir, setLogDir] = useState(settings.logDir)
  const [shotDir, setShotDir] = useState(settings.screenshotDir)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const onSave = async () => {
    if (!logDir.trim()) {
      setError('请先选择日志监控目录')
      return
    }
    setSaving(true)
    setError(null)
    try {
      const st = await saveSettings(logDir.trim(), shotDir.trim())
      setSettings(st)
      // 用新目录重启监控并重新加载数据
      await startWatching(st.logDir)
      seedPlayerQuests(await getPlayerQuests())
      seedActivity(await getActivity())
      closeSettings()
    } catch (e) {
      setError(String(e))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="w-[560px] bg-ink-800 border border-line rounded-xl p-5 shadow-2xl">
        <div className="flex items-center mb-4">
          <span className="text-[15px] font-medium">设置</span>
          <button
            onClick={closeSettings}
            className="ml-auto text-muted hover:text-[#e6edf3] text-[13px]"
          >
            ✕
          </button>
        </div>

        <div className="space-y-4">
          <DirField label="日志监控目录" value={logDir} onChange={setLogDir} />
          <DirField
            label="截图监控目录（地图功能预留）"
            value={shotDir}
            onChange={setShotDir}
          />

          {error && (
            <div className="text-[12px] text-red-400 border border-red-400/40 rounded px-3 py-2">
              {error}
            </div>
          )}

          <div className="flex justify-end gap-2 pt-1">
            <button
              onClick={closeSettings}
              className="px-4 py-1.5 rounded border border-line text-[12px] text-muted hover:text-[#e6edf3] hover:bg-ink-700"
            >
              取消
            </button>
            <button
              onClick={onSave}
              disabled={saving}
              className="px-4 py-1.5 rounded bg-amber text-black text-[12px] font-medium hover:opacity-90 disabled:opacity-50"
            >
              {saving ? '保存中…' : '保存'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
