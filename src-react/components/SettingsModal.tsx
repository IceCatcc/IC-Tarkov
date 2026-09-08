import { useCallback, useEffect, useState } from 'react'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { open, save } from '@tauri-apps/plugin-dialog'
import { readFile } from '@tauri-apps/plugin-fs'
import { useStore } from '../store'
import { isMobile } from '../platform'
import {
  saveSettings,
  startWatching,
  getPlayerQuests,
  resetAndRescan,
  exportData,
  importData,
  importDataBytes,
  openDataDir,
  getDataStatus,
  refreshGameData,
  getDataLocation,
  setDataLocation,
  getSettings,
  type DataLocation,
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
  const [dataLoc, setDataLoc] = useState<DataLocation | null>(null)
  // 用户点选的目标位置（null = 跟随当前生效位置）
  const [selLoc, setSelLoc] = useState<DataLocation['kind'] | null>(null)
  const [migrating, setMigrating] = useState(false)
  const [rescanMenu, setRescanMenu] = useState(false)
  // 移动端关闭监控相关 UI（游戏在 PC，无日志/截图源）
  const mobile = isMobile()

  // 设置项分组视觉：标题(白亮加粗) / 选项(主色) / 说明(灰小字) 三级层级
  const TITLE_CLS = 'text-[14px] font-semibold text-[#e6edf3]'
  const DESC_CLS = 'text-[13px] text-muted leading-relaxed'

  const LOC_OPTIONS: { kind: DataLocation['kind']; name: string; desc: string }[] = [
    {
      kind: 'appdata',
      name: '系统目录（AppData）',
      desc: '数据放在系统用户数据目录，卸载或更换程序位置不丢数据',
    },
    {
      kind: 'portable',
      name: '程序目录',
      desc: '数据放在程序安装目录旁的 data 里，整包拷贝即可带走',
    },
  ]

  useEffect(() => {
    getDataLocation()
      .then(setDataLoc)
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
        // 成功后由下方「最近更新」时间行接管展示；仅失败时保留原因提示
        setSyncMsg(e.payload.ok ? null : e.payload.message)
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
    if (!mobile && !logDir.trim()) {
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
      // 用新目录重启监控并重新加载任务（历史活动默认不读取）；移动端不启动监控
      if (!mobile) {
        await startWatching(st.logDir)
        seedPlayerQuests(await getPlayerQuests())
      }
      closeSettings()
    } catch (e) {
      setError(String(e))
    } finally {
      setSaving(false)
    }
  }

  const onRescan = async (mode: 'cover' | 'merge') => {
    setBusy('rescan')
    setError(null)
    setFeedback(null)
    try {
      await resetAndRescan(mode)
      clearHistorical()
      seedPlayerQuests(await getPlayerQuests())
      setFeedback(
        mode === 'merge'
          ? '已补充重扫：本地日志缺失的进度已并入当前数据'
          : '已覆盖重扫：已重置到日志真值（手动改动已丢弃）',
      )
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

  const onMigrateLoc = async () => {
    if (!dataLoc || !selLoc || selLoc === dataLoc.kind) return
    setMigrating(true)
    setError(null)
    setFeedback(null)
    try {
      const info = await setDataLocation(selLoc)
      setDataLoc(info)
      setSelLoc(null)
      setFeedback(
        info.kind === 'portable'
          ? '数据已迁移到程序目录，设置与缓存均已一并搬走'
          : '数据已迁移到系统目录（AppData），设置与缓存均已一并搬走',
      )
    } catch (e) {
      setError(String(e))
    } finally {
      setMigrating(false)
    }
  }

  const onExport = async () => {
    setBusy('export')
    setError(null)
    setFeedback(null)
    try {
      if (isMobile()) {
        // 移动端无「保存文件」对话框：直接导出到数据目录并回显路径
        const saved = await exportData()
        setFeedback(`已导出：${saved}`)
      } else {
        // 注意：保存对话框必须用 plugin-dialog 的 save()，open({ save }) 是 v1 写法不生效
        const p = await save({
          title: '导出数据（zip 压缩包）',
          defaultPath: 'ic-tarkov-data.zip',
          filters: [{ name: 'ZIP', extensions: ['zip'] }],
        })
        if (typeof p === 'string') {
          await exportData(p)
          setFeedback('数据已导出为压缩包')
        }
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
        filters: [
          { name: '数据包（zip）', extensions: ['zip'] },
          { name: '旧版 JSON', extensions: ['json'] },
        ],
      })
      if (typeof p === 'string') {
        // 移动端对话框返回 content://（Android）/ file://（iOS）URI，std::fs 打不开，
        // 用 plugin-fs 读取字节后由 import_data_bytes 导入；桌面端直接按路径导入。
        if (mobile) {
          const bytes = await readFile(p)
          await importDataBytes(bytes)
        } else {
          await importData(p)
        }
        clearHistorical()
        seedPlayerQuests(await getPlayerQuests())
        // 导入的 settings.json（含档案/UI 偏好）覆盖了本地，需重新拉取并应用
        const st = await getSettings()
        setSettings(st)
        if (st.uiPrefs && Object.keys(st.uiPrefs).length > 0) {
          useStore.getState().applyUiPrefs(st.uiPrefs)
        }
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
      <div className="w-[560px] max-h-[90vh] flex flex-col bg-ink-800 border border-line rounded-xl p-5 shadow-2xl">
        <div className="flex items-center mb-4 shrink-0">
          <span className="text-[17px] font-medium">设置</span>
          <button
            onClick={closeSettings}
            className="ml-auto text-muted hover:text-[#e6edf3] text-[15px]"
          >
            ✕
          </button>
        </div>

        <div className="space-y-4 overflow-y-auto pr-1 flex-1 min-h-0">
          {/* 监控目录（移动端关闭监控相关 UI，整块隐藏） */}
          {!mobile && (
          <div>
            <div className={`${TITLE_CLS} mb-2`}>监控目录</div>
            <DirField label="日志监控目录" value={logDir} onChange={setLogDir} />
            <DirField
              label="截图监控目录（地图页玩家定位）"
              value={shotDir}
              onChange={setShotDir}
            />
            <label className="flex items-center gap-3 cursor-pointer select-none pt-1">
              <input
                type="checkbox"
                checked={deleteShots}
                onChange={(e) => setDeleteShots(e.target.checked)}
                className="w-4 h-4 accent-amber"
              />
              <span className="text-[15px] text-[#e6edf3]">读取坐标后删除截图</span>
            </label>
          </div>
          )}

          {/* 界面缩放 */}
          <div className="border-t border-line pt-4">
            <div className={`${TITLE_CLS} mb-2`}>界面缩放</div>
            <div className="flex items-center gap-2 flex-wrap">
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
            </div>
          </div>

          {error && (
            <div className="text-[14px] text-red-400 border border-red-400/40 rounded px-3 py-2">
              {error}
            </div>
          )}

          {/* 游戏数据（tarkov.dev） */}
          <div className="border-t border-line pt-4">
            <div className={`${TITLE_CLS} mb-2`}>游戏数据（tarkov.dev）</div>
            <div className="flex items-center gap-2">
              <button
                onClick={onUpdateData}
                disabled={syncing}
                className="px-3 py-1.5 rounded border border-line text-[14px] text-[#e6edf3] hover:bg-ink-700 disabled:opacity-50"
              >
                {syncing ? '更新中…' : '更新数据'}
              </button>
              <span className={DESC_CLS}>
                {dataStatus
                  ? `${dataStatus.questCount} 个任务 / ${dataStatus.mapCount} 张地图`
                  : '读取中…'}
              </span>
            </div>
            {/* 更新中显示进度；失败显示原因；其他时候（含更新完成后）显示最近更新时间 */}
            {syncing ? (
              <div className="mt-2 text-[12px] text-muted/80">{syncMsg ?? '正在更新…'}</div>
            ) : syncMsg ? (
              <div className="mt-2 text-[12px] text-red-400">{syncMsg}</div>
            ) : dataStatus?.updatedAt ? (
              <div className="mt-2 text-[12px] text-muted/80">
                最近更新：{fmtTime(dataStatus.updatedAt)}
              </div>
            ) : null}
            {dataStatus && !dataStatus.cached && (
              <div className="text-[14px] text-amber mt-2">
                缓存为空或不完整：请点击上方「更新数据」联网获取（首次使用需联网）。
              </div>
            )}
          </div>

          {/* 数据管理 */}
          <div className="border-t border-line pt-4">
            <div className={`${TITLE_CLS} mb-2`}>数据管理</div>
            <div className="flex flex-wrap gap-2">
              {!mobile && (
              <button
                onClick={() => setRescanMenu(true)}
                disabled={busy !== null}
                className="px-3 py-1.5 rounded border border-line text-[14px] text-[#e6edf3] hover:bg-ink-700 disabled:opacity-50"
              >
                {busy === 'rescan' ? '读取中…' : '重新读取日志'}
              </button>
              )}
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
              {!mobile && (
                <button
                  onClick={onOpenDataDir}
                  className="px-3 py-1.5 rounded border border-line text-[14px] text-[#e6edf3] hover:bg-ink-700"
                  title="打开持久化文件所在目录（settings.json / quest_state.json）"
                >
                  打开数据目录
                </button>
              )}
            </div>
            {feedback && (
              <div className="text-[14px] text-ok mt-2">{feedback}</div>
            )}
            {!mobile && dataLoc && (
              <div className="border-t border-line pt-3 mt-3">
                <div className={`${TITLE_CLS} mb-1.5`}>数据目录位置</div>
                <div className="space-y-1.5">
                  {LOC_OPTIONS.map((o) => {
                    const active = (selLoc ?? dataLoc.kind) === o.kind
                    return (
                      <button
                        key={o.kind}
                        type="button"
                        onClick={() => setSelLoc(o.kind)}
                        disabled={migrating}
                        className={`w-full text-left flex items-start gap-2.5 px-3 py-2 rounded border transition-colors disabled:opacity-60 ${
                          active
                            ? 'border-amber bg-ink-700'
                            : 'border-line hover:bg-ink-700'
                        }`}
                      >
                        <input
                          type="radio"
                          readOnly
                          checked={active}
                          className="w-4 h-4 mt-0.5 accent-amber pointer-events-none"
                        />
                        <span className="min-w-0 flex-1">
                          <span className="block text-[14px] text-[#e6edf3]">
                            {o.name}
                          </span>
                          <span className="block text-[13px] text-muted mt-0.5">
                            {o.desc}
                          </span>
                        </span>
                      </button>
                    )
                  })}
                </div>
                <div className="mt-2 flex items-center gap-2">
                  <button
                    onClick={onMigrateLoc}
                    disabled={
                      !selLoc || selLoc === dataLoc.kind || migrating
                    }
                    className="px-3 py-1.5 rounded bg-amber text-black text-[14px] font-medium hover:opacity-90 disabled:opacity-40"
                  >
                    {migrating ? '迁移中…' : '迁移'}
                  </button>
                </div>
                <div className={`${DESC_CLS} mt-1.5`}>
                  启动时自动定位：程序目录 data 优先，无数据再找 AppData；两边都没有数据时自动在程序目录创建。目标位置已有另一份数据时会拒绝迁移。
                </div>
              </div>
            )}
          </div>
        </div>

        <div className="flex justify-end items-center gap-2 pt-3 mt-3 border-t border-line shrink-0">
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

      {rescanMenu && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
          onClick={() => setRescanMenu(false)}
        >
          <div
            className="w-[320px] rounded-lg border border-line bg-ink-800 p-4 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="text-[15px] font-semibold text-[#e6edf3] mb-1">重新读取日志</div>
            <div className={`${DESC_CLS} mb-4`}>请选择重扫方式：</div>
            <div className="flex flex-col gap-2">
              <button
                onClick={() => {
                  setRescanMenu(false)
                  onRescan('cover')
                }}
                className="px-3 py-2 rounded border border-line text-left text-[14px] text-[#e6edf3] hover:bg-ink-700"
              >
                覆盖重扫：重置到日志真值
              </button>
              <button
                onClick={() => {
                  setRescanMenu(false)
                  onRescan('merge')
                }}
                className="px-3 py-2 rounded border border-line text-left text-[14px] text-[#e6edf3] hover:bg-ink-700"
              >
                补充重扫：并入本地日志缺失进度
              </button>
              <button
                onClick={() => setRescanMenu(false)}
                className="px-3 py-2 rounded text-[13px] text-muted hover:text-[#e6edf3]"
              >
                取消
              </button>
            </div>
          </div>
        </div>
      )}

    </div>
  )
}
