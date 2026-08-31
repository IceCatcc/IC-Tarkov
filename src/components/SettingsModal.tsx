import { useCallback, useEffect, useState } from 'react'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { open } from '@tauri-apps/plugin-dialog'
import { getVersion } from '@tauri-apps/api/app'
import { useStore } from '../store'
import {
  saveSettings,
  startWatching,
  getPlayerQuests,
  resetAndRescan,
  exportData,
  importData,
  openDataDir,
  getDataStatus,
  refreshGameData,
} from '../tauri'
import type { DataStatus, DataSyncProgress, DataSyncReport } from '../types'

const fmtTime = (epochSecs: number): string => {
  if (!epochSecs) return '从未更新'
  const d = new Date(epochSecs * 1000)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

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
  const uiScale = useStore((s) => s.uiScale)
  const setUiScale = useStore((s) => s.setUiScale)

  const [logDir, setLogDir] = useState(settings.logDir)
  const [shotDir, setShotDir] = useState(settings.screenshotDir)
  const [deleteShots, setDeleteShots] = useState(settings.deleteScreenshots)
  const [saving, setSaving] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [feedback, setFeedback] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [aboutOpen, setAboutOpen] = useState(false)
  const [appVersion, setAppVersion] = useState('')

  useEffect(() => {
    getVersion()
      .then(setAppVersion)
      .catch(() => {})
  }, [])

  /* ---------- 游戏数据（tarkov.dev 原始 API JSON 缓存） ---------- */
  const [dataStatus, setDataStatus] = useState<DataStatus | null>(null)
  const [syncMsg, setSyncMsg] = useState<string | null>(null)
  const [syncing, setSyncing] = useState(false)

  const loadDataStatus = useCallback(() => {
    getDataStatus()
      .then((s) => {
        setDataStatus(s)
        setSyncing(s.syncing)
      })
      .catch(() => {})
  }, [])

  useEffect(() => {
    loadDataStatus()
    const offs: UnlistenFn[] = []
    let disposed = false
    const track = (p: Promise<UnlistenFn>) => {
      p.then((f) => {
        if (disposed) f()
        else offs.push(f)
      }).catch(() => {})
    }
    track(
      listen<DataSyncProgress>('data-sync-progress', (e) => {
        const p = e.payload
        setSyncing(p.running)
        setSyncMsg(p.running ? `正在更新：${p.label}（${p.done + 1}/${p.total}）` : null)
      }),
    )
    track(
      listen<DataSyncReport>('data-synced', (e) => {
        setSyncing(false)
        setSyncMsg(e.payload.message)
        loadDataStatus()
      }),
    )
    // 后端重建完派生索引后刷新计数
    track(listen('data-reloaded', () => loadDataStatus()))
    return () => {
      disposed = true
      offs.forEach((f) => f())
    }
  }, [loadDataStatus])

  const onUpdateData = async () => {
    setError(null)
    setFeedback(null)
    setSyncMsg(null)
    setSyncing(true)
    try {
      await refreshGameData(true)
    } catch (e) {
      setSyncing(false)
      setError(String(e))
    }
  }

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

          {/* 界面缩放（类显示器缩放） */}
          <div>
            <label className="text-[14px] text-muted block mb-1">界面缩放</label>
            <div className="flex items-center gap-2">
              {[1, 1.25, 1.5, 2].map((v) => (
                <button
                  key={v}
                  onClick={() => setUiScale(v)}
                  className={`px-3 py-1.5 rounded border text-[14px] ${
                    uiScale === v
                      ? 'border-amber bg-ink-700 text-[#e6edf3]'
                      : 'border-line text-muted hover:text-[#e6edf3] hover:bg-ink-700'
                  }`}
                >
                  {v}x
                </button>
              ))}
              <span className="text-[13px] text-muted ml-1">等效显示器缩放，立即生效并持久化</span>
            </div>
          </div>

          {error && (
            <div className="text-[14px] text-red-400 border border-red-400/40 rounded px-3 py-2">
              {error}
            </div>
          )}

          {/* 游戏数据（tarkov.dev） */}
          <div className="border-t border-line pt-4">
            <div className="text-[14px] text-muted mb-2">游戏数据（tarkov.dev）</div>
            <div className="flex items-center gap-2">
              <button
                onClick={onUpdateData}
                disabled={syncing}
                className="px-3 py-1.5 rounded border border-line text-[14px] text-[#e6edf3] hover:bg-ink-700 disabled:opacity-50"
              >
                {syncing ? '更新中…' : '更新数据'}
              </button>
              <span className="text-[13px] text-muted">
                {dataStatus
                  ? `${fmtTime(dataStatus.updatedAt)} · ${dataStatus.questCount} 个任务 / ${dataStatus.mapCount} 张地图`
                  : '读取中…'}
              </span>
            </div>
            {syncMsg && <div className="text-[13px] text-muted mt-2">{syncMsg}</div>}
            <div className="text-[13px] text-muted mt-2">
              数据直接来自 json.tarkov.dev 的原始接口，缓存于应用数据目录；
              更新会重新拉取全部端点并重建任务索引与地图数据，版本更新或赛季重置后点一次即可。
              {dataStatus && !dataStatus.cached && ' 当前缓存不完整，需联网更新。'}
            </div>
          </div>

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

          <div className="flex justify-between items-center gap-2 pt-1">
            <button
              onClick={() => setAboutOpen(true)}
              className="px-3 py-1.5 rounded border border-line text-[14px] text-muted hover:text-[#e6edf3] hover:bg-ink-700"
            >
              关于
            </button>
            <div className="flex gap-2">
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

      {aboutOpen && (
        <div
          className="fixed inset-0 z-[1100] flex items-center justify-center bg-black/60"
          onClick={() => setAboutOpen(false)}
        >
          <div
            className="w-[440px] max-w-[calc(100vw-32px)] rounded-2xl border border-line bg-ink-800 shadow-2xl overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            {/* 头部：图标 + 标题 + 版本 */}
            <div className="relative px-5 pt-6 pb-5 flex flex-col items-center text-center border-b border-line bg-gradient-to-b from-ink-700/60 to-transparent">
              <button
                onClick={() => setAboutOpen(false)}
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
                  全部游戏数据（任务、地图、物品、商人、本地化等）均来自{' '}
                  <a
                    className="text-[#d4a174] hover:underline"
                    href="https://tarkov.dev"
                    target="_blank"
                    rel="noreferrer"
                  >
                    tarkov.dev
                  </a>{' '}
                  提供的开放接口。
                </div>
              </div>

              <div className="rounded-lg bg-ink-700/50 border border-line px-3 py-2.5">
                <div className="text-[12px] uppercase tracking-wide text-muted mb-1">
                  项目参考
                </div>
                <div>
                  本项目的设计与数据解析参考了{' '}
                  <a
                    className="text-[#d4a174] hover:underline"
                    href="https://tarkov.dev"
                    target="_blank"
                    rel="noreferrer"
                  >
                    tarkov.dev
                  </a>{' '}
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
                    <a
                      className="text-[#d4a174] hover:underline"
                      href="https://icecat.cc"
                      target="_blank"
                      rel="noreferrer"
                    >
                      icecat.cc
                    </a>
                  </div>
                </div>
                <div className="rounded-lg bg-ink-700/50 border border-line px-3 py-2.5">
                  <div className="text-[12px] uppercase tracking-wide text-muted mb-1">
                    开源仓库
                  </div>
                  <div>
                    {GITHUB_URL ? (
                      <a
                        className="text-[#d4a174] hover:underline"
                        href={GITHUB_URL}
                        target="_blank"
                        rel="noreferrer"
                      >
                        GitHub
                      </a>
                    ) : (
                      <span className="text-muted">即将上线</span>
                    )}
                  </div>
                </div>
              </div>

              <div className="border-t border-line pt-3 text-[13px] text-muted">
                本项目在开发过程中深度使用 AI 辅助编程（代码生成、重构与调试）。
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// GitHub 仓库地址（预留：上线后填入真实链接即可启用「GitHub」入口）
const GITHUB_URL = ''
