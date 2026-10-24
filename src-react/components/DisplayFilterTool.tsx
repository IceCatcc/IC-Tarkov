import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import {
  applyDisplayFilter,
  getAutoAdmin,
  getDisplayFilter,
  isElevated,
  listDisplays,
  relaunchAsAdmin,
  resetDisplayFilter,
  saveDisplayFilter,
  setAutoAdmin,
} from '../tauri'
import { listenEvent } from '../api/shell'
import { isMobile, isWeb } from '../platform'
import type {
  DisplayFilterChangedPayload,
  DisplayFilterParams,
  DisplayFilterState,
  DisplayHotkey,
  DisplayInfo,
} from '../types'

/** 线性表：不改变画面 */
const IDENTITY: DisplayFilterParams = {
  brightness: 1,
  contrast: 1,
  gammaR: 1,
  gammaG: 1,
  gammaB: 1,
}

type ParamKey = keyof DisplayFilterParams

interface SliderDef {
  key: ParamKey
  label: string
  min: number
  max: number
  /** 通道色：滑块轨道 / 圆点 / 数值框统一取这个色 */
  accent: string
  desc: string
}

const SLIDERS: SliderDef[] = [
  { key: 'brightness', label: '亮度', min: 0.3, max: 2.5, accent: '#ef9f27', desc: '整条曲线线性缩放' },
  { key: 'contrast', label: '对比度', min: 0.2, max: 3, accent: '#58a6ff', desc: '围绕中灰拉伸明暗差' },
  { key: 'gammaR', label: 'Gamma R', min: 0.2, max: 6, accent: '#f85149', desc: '红色通道中间调' },
  { key: 'gammaG', label: 'Gamma G', min: 0.2, max: 6, accent: '#3fb950', desc: '绿色通道中间调' },
  { key: 'gammaB', label: 'Gamma B', min: 0.2, max: 6, accent: '#4493f8', desc: '蓝色通道中间调' },
]

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))
const round2 = (v: number) => Math.round(v * 100) / 100

/** 与线性表的偏离量（0 表示未改变画面） */
function deviation(p: DisplayFilterParams): number {
  return (
    Math.abs(p.brightness - 1) +
    Math.abs(p.contrast - 1) +
    Math.abs(p.gammaR - 1) +
    Math.abs(p.gammaG - 1) +
    Math.abs(p.gammaB - 1)
  )
}

/** 方案摘要：三通道一致时只报一个 Gamma */
function presetHint(p: DisplayFilterParams): string {
  const sameGamma =
    Math.abs(p.gammaR - p.gammaG) < 0.005 && Math.abs(p.gammaG - p.gammaB) < 0.005
  if (sameGamma) return `Γ ${p.gammaR.toFixed(2)} · 对比 ${p.contrast.toFixed(2)}`
  return `RGB ${p.gammaR.toFixed(2)}/${p.gammaG.toFixed(2)}/${p.gammaB.toFixed(2)}`
}

/** 具名按键（小键盘 / 标点的显示文本与 VK 码） */
const NAMED_KEYS: Record<string, { vk: number; label: string }> = {
  Numpad0: { vk: 0x60, label: 'Numpad0' },
  Numpad1: { vk: 0x61, label: 'Numpad1' },
  Numpad2: { vk: 0x62, label: 'Numpad2' },
  Numpad3: { vk: 0x63, label: 'Numpad3' },
  Numpad4: { vk: 0x64, label: 'Numpad4' },
  Numpad5: { vk: 0x65, label: 'Numpad5' },
  Numpad6: { vk: 0x66, label: 'Numpad6' },
  Numpad7: { vk: 0x67, label: 'Numpad7' },
  Numpad8: { vk: 0x68, label: 'Numpad8' },
  Numpad9: { vk: 0x69, label: 'Numpad9' },
  NumpadMultiply: { vk: 0x6a, label: 'Numpad*' },
  NumpadAdd: { vk: 0x6b, label: 'Numpad+' },
  NumpadSubtract: { vk: 0x6d, label: 'Numpad-' },
  NumpadDecimal: { vk: 0x6e, label: 'Numpad.' },
  NumpadDivide: { vk: 0x6f, label: 'Numpad/' },
  Space: { vk: 0x20, label: 'Space' },
  Tab: { vk: 0x09, label: 'Tab' },
  Enter: { vk: 0x0d, label: 'Enter' },
  Insert: { vk: 0x2d, label: 'Insert' },
  Home: { vk: 0x24, label: 'Home' },
  End: { vk: 0x23, label: 'End' },
  PageUp: { vk: 0x21, label: 'PgUp' },
  PageDown: { vk: 0x22, label: 'PgDn' },
  ArrowUp: { vk: 0x26, label: '↑' },
  ArrowDown: { vk: 0x28, label: '↓' },
  ArrowLeft: { vk: 0x25, label: '←' },
  ArrowRight: { vk: 0x27, label: '→' },
  Backquote: { vk: 0xc0, label: '`' },
  Minus: { vk: 0xbd, label: '-' },
  Equal: { vk: 0xbb, label: '=' },
  BracketLeft: { vk: 0xdb, label: '[' },
  BracketRight: { vk: 0xdd, label: ']' },
  Backslash: { vk: 0xdc, label: '\\' },
  Semicolon: { vk: 0xba, label: ';' },
  Quote: { vk: 0xde, label: "'" },
  Comma: { vk: 0xbc, label: ',' },
  Period: { vk: 0xbe, label: '.' },
  Slash: { vk: 0xbf, label: '/' },
}

/** `KeyboardEvent.code` → Windows 虚拟键码 + 显示文本（只覆盖常用键） */
function codeToKey(code: string): { vk: number; label: string } | null {
  const named = NAMED_KEYS[code]
  if (named) return named
  const fn = /^F([1-9]|1[0-9]|2[0-4])$/.exec(code)
  if (fn) return { vk: 0x70 + Number(fn[1]) - 1, label: `F${fn[1]}` }
  const digit = /^Digit([0-9])$/.exec(code)
  if (digit) return { vk: 0x30 + Number(digit[1]), label: digit[1] }
  const letter = /^Key([A-Z])$/.exec(code)
  if (letter) return { vk: 0x41 + (letter[1].charCodeAt(0) - 65), label: letter[1] }
  return null
}

/** 键盘事件 → 快捷键（纯修饰键返回 null，让界面继续等待真正的按键） */
function eventToHotkey(e: KeyboardEvent): DisplayHotkey | null {
  if (/^(Control|Alt|Shift|Meta)(Left|Right)?$/.test(e.code)) return null
  const key = codeToKey(e.code)
  if (!key) return null
  const { ctrlKey: ctrl, altKey: alt, shiftKey: shift } = e
  const label = `${ctrl ? 'Ctrl+' : ''}${alt ? 'Alt+' : ''}${shift ? 'Shift+' : ''}${key.label}`
  return { vk: key.vk, ctrl, alt, shift, label }
}

/** 两个快捷键是否是同一组合 */
function sameHotkey(a: DisplayHotkey, b: DisplayHotkey): boolean {
  return a.vk === b.vk && a.ctrl === b.ctrl && a.alt === b.alt && a.shift === b.shift
}

/**
 * 显示器滤镜：通过后端下发显卡 gamma 查找表（`SetDeviceGammaRamp`）改变整块显示器的
 * 亮度 / 对比度 / RGB Gamma。改的是显示设备而不是画面内容，所以全屏游戏里同样有效。
 * 逐帧下发没有必要，滑块拖动防抖 90ms 合并；参数同时落盘，重启后自动复现。
 */
export function DisplayFilterTool() {
  // 浏览器端没有本机显示设备，手机端不编译 gamma 模块：都不发命令，直接给提示
  const unsupported = isWeb() || isMobile()
  const [displays, setDisplays] = useState<DisplayInfo[]>([])
  const [filter, setFilter] = useState<DisplayFilterState | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [params, setParams] = useState<DisplayFilterParams>(IDENTITY)
  const [presetName, setPresetName] = useState('')
  /** 当前参数来自哪套方案（套用 / 快捷键命中 / 同名另存后置位）：该行的按钮变成「保存」 */
  const [appliedPreset, setAppliedPreset] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [status, setStatus] = useState<{ kind: 'ok' | 'warn' | 'err'; text: string } | null>(null)
  /** 正在等待用户按键绑定的方案名 */
  const [capturing, setCapturing] = useState<string | null>(null)
  const [elevated, setElevated] = useState(false)
  /** 「始终以管理员身份启动」是否已写入注册表（下次启动生效，与本次是否提权无关） */
  const [autoAdmin, setAutoAdminState] = useState(false)

  // 变更很快（拖滑块），状态同时写 ref 供防抖回调读到最新值
  const filterRef = useRef<DisplayFilterState | null>(null)
  const paramsRef = useRef<DisplayFilterParams>(IDENTITY)
  const selectedIdRef = useRef<string | null>(null)
  const applyTimer = useRef<number>()
  const saveTimer = useRef<number>()

  const commitFilter = useCallback((next: DisplayFilterState) => {
    filterRef.current = next
    setFilter(next)
  }, [])

  const setParamsAll = useCallback((next: DisplayFilterParams) => {
    paramsRef.current = next
    setParams(next)
  }, [])

  useEffect(() => {
    if (unsupported) {
      setLoading(false)
      return
    }
    let alive = true
    Promise.all([listDisplays(), getDisplayFilter(), isElevated(), getAutoAdmin()])
      .then(([ds, st, admin, auto]) => {
        if (!alive) return
        setDisplays(ds)
        setElevated(admin)
        setAutoAdminState(auto)
        commitFilter(st)
        // 优先恢复上次选中的显示器；没有记录（首次打开 / 设备已拔掉）时退回主显示器
        const first =
          ds.find((d) => d.id === st.selected) ?? ds.find((d) => d.primary) ?? ds[0] ?? null
        if (first) {
          setSelectedId(first.id)
          setParamsAll(st.displays[first.id] ?? IDENTITY)
          if (st.selected !== first.id) {
            // 选中项要落盘：快捷键只作用于它，没有记录时会退回主显示器
            const next = { ...st, selected: first.id }
            commitFilter(next)
            saveDisplayFilter(next).catch(() => {})
          }
        }
      })
      .catch((e) => {
        if (alive) setError(String(e))
      })
      .finally(() => {
        if (alive) setLoading(false)
      })
    return () => {
      alive = false
    }
  }, [unsupported, commitFilter, setParamsAll])

  // 离开页面不是「撤销」：gamma 表属于显示设备，切走 / 开游戏时保持生效
  useEffect(
    () => () => {
      if (applyTimer.current) window.clearTimeout(applyTimer.current)
      if (saveTimer.current) window.clearTimeout(saveTimer.current)
    },
    [],
  )

  const enabled = filter?.enabled ?? false
  const lockedRgb = filter?.lockedRgb ?? true
  const selected = displays.find((d) => d.id === selectedId) ?? null
  const hotkeyCount = useMemo(
    () => (filter?.presets ?? []).filter((p) => p.hotkey && p.hotkey.vk > 0).length,
    [filter],
  )

  // 只有总开关打开时，存档里的参数才算「正在生效」
  const appliedCount = useMemo(
    () =>
      enabled
        ? Object.values(filter?.displays ?? {}).filter((p) => deviation(p) > 0.004).length
        : 0,
    [filter, enabled],
  )

  /** 提交参数：更新本地状态 → 防抖落盘 → 防抖下发到指定显示器 */
  const pushParams = useCallback(
    (next: DisplayFilterParams, ids: string[]) => {
      setParamsAll(next)
      const cur = filterRef.current
      if (!cur || ids.length === 0) return
      const displaysMap = { ...cur.displays }
      for (const id of ids) displaysMap[id] = next
      const nextState: DisplayFilterState = { ...cur, displays: displaysMap }
      commitFilter(nextState)

      if (saveTimer.current) window.clearTimeout(saveTimer.current)
      saveTimer.current = window.setTimeout(() => {
        saveDisplayFilter(nextState).catch(() => {})
      }, 600)

      if (!nextState.enabled) return
      if (applyTimer.current) window.clearTimeout(applyTimer.current)
      applyTimer.current = window.setTimeout(() => {
        Promise.all(
          ids.map((id) =>
            applyDisplayFilter(id, next, nextState.selected ?? null).then(
              () => null,
              (e) => String(e),
            ),
          ),
        ).then((errs) => {
          const err = errs.find((e) => e)
          if (err) setStatus({ kind: 'err', text: err })
          else setStatus({ kind: 'ok', text: '已应用' })
        })
      }, 90)
    },
    [commitFilter, setParamsAll],
  )

  /**
   * 取消挂起的「落盘 / 下发」。
   * 重置类操作必须先在前面调它：否则刚拖滑块排队的 600ms 落盘会在还原之后写回旧参数，
   * 下次启动又会把滤镜复现出来。
   */
  const cancelTimers = () => {
    if (applyTimer.current) window.clearTimeout(applyTimer.current)
    if (saveTimer.current) window.clearTimeout(saveTimer.current)
    applyTimer.current = undefined
    saveTimer.current = undefined
  }

  const selectDisplay = (id: string) => {
    setSelectedId(id)
    const cur = filterRef.current
    setParamsAll(cur?.displays[id] ?? IDENTITY)
    // 换了显示器，当前参数不再来自刚才套用的方案：收起「保存」，避免误写回
    setAppliedPreset(null)
    setStatus(null)
    // 选中项落盘：所有修改（含快捷键触发的）都只作用于这一台
    if (cur && cur.selected !== id) {
      const next = { ...cur, selected: id }
      commitFilter(next)
      saveDisplayFilter(next).catch(() => {})
    }
  }

  useEffect(() => {
    selectedIdRef.current = selectedId
  }, [selectedId])

  /** 绑定 / 解除某方案的全局快捷键（落盘会触发后端重新注册） */
  const bindHotkey = useCallback(
    (name: string, hk: DisplayHotkey | null) => {
      const cur = filterRef.current
      if (!cur) return
      const presets = cur.presets.map((p) => {
        if (p.name === name) return { ...p, hotkey: hk }
        // 同一组合只留一个绑定：否则注册时后一个会顶掉前一个，静默失效
        if (hk && p.hotkey && sameHotkey(p.hotkey, hk)) return { ...p, hotkey: null }
        return p
      })
      const nextState: DisplayFilterState = { ...cur, presets }
      commitFilter(nextState)
      saveDisplayFilter(nextState)
        .then(() =>
          setStatus(
            hk
              ? { kind: 'ok', text: `「${name}」绑定 ${hk.label}` }
              : { kind: 'warn', text: `「${name}」已解除快捷键` },
          ),
        )
        .catch((e) => setStatus({ kind: 'err', text: String(e) }))
    },
    [commitFilter],
  )

  // 按键捕获：Esc 取消、Delete/Backspace 解除、其余组合键直接绑定
  useEffect(() => {
    if (!capturing) return
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault()
      e.stopPropagation()
      if (e.code === 'Escape') {
        setCapturing(null)
        return
      }
      if (e.code === 'Delete' || e.code === 'Backspace') {
        bindHotkey(capturing, null)
        setCapturing(null)
        return
      }
      const hk = eventToHotkey(e)
      if (!hk) return // 只按住修饰键，继续等
      bindHotkey(capturing, hk)
      setCapturing(null)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [capturing, bindHotkey])

  // 后端命中快捷键后会把新状态推过来（方案已应用到所有显示器），界面跟着刷新
  useEffect(() => {
    if (unsupported) return
    let cancelled = false
    let off: (() => void) | null = null
    listenEvent<DisplayFilterChangedPayload>('display-filter-changed', (p) => {
      commitFilter(p.state)
      const id = selectedIdRef.current
      setParamsAll(id ? p.state.displays[id] ?? IDENTITY : IDENTITY)
      // 快捷键命中等同于一次「套用」：该方案的按钮切成「保存」
      if (p.preset) setAppliedPreset(p.preset)
      setStatus({
        kind: 'ok',
        text: p.preset
          ? `已通过快捷键把「${p.preset}」应用到 ${
              p.display ? p.display.replace('\\\\.\\', '') : '当前显示器'
            }`
          : '已通过快捷键应用方案',
      })
    }).then((f) => {
      if (cancelled) f()
      else off = f
    })
    return () => {
      cancelled = true
      if (off) off()
    }
  }, [unsupported, commitFilter, setParamsAll])

  const elevate = async () => {
    try {
      setStatus({ kind: 'warn', text: '正在以管理员身份重启…' })
      await relaunchAsAdmin()
    } catch (e) {
      setStatus({ kind: 'err', text: String(e) })
    }
  }

  /** 写 / 删注册表里的 exe 兼容性标记（`HKCU`，不需要提权，也不改 exe 文件） */
  const toggleAutoAdmin = async () => {
    const next = !autoAdmin
    try {
      const applied = await setAutoAdmin(next)
      setAutoAdminState(applied)
      setStatus({
        kind: 'ok',
        text: applied
          ? '已设置：以后启动会弹 UAC 以管理员身份运行（本次不受影响）'
          : '已取消：以后启动不再自动请求管理员权限',
      })
    } catch (e) {
      setStatus({ kind: 'err', text: String(e) })
    }
  }

  const onParam = (def: SliderDef, raw: number) => {
    const v = clamp(round2(raw), def.min, def.max)
    let next = { ...paramsRef.current, [def.key]: v }
    if (lockedRgb && def.key !== 'brightness' && def.key !== 'contrast') {
      next = { ...next, gammaR: v, gammaG: v, gammaB: v }
    }
    pushParams(next, selectedId ? [selectedId] : [])
  }

  const toggleLock = () => {
    const cur = filterRef.current
    if (!cur) return
    const nextState = { ...cur, lockedRgb: !cur.lockedRgb }
    commitFilter(nextState)
    saveDisplayFilter(nextState).catch(() => {})
  }

  const toggleEnabled = async () => {
    const cur = filterRef.current
    if (!cur) return
    cancelTimers()
    const nextState: DisplayFilterState = { ...cur, enabled: !cur.enabled }
    commitFilter(nextState)
    try {
      await saveDisplayFilter(nextState)
      if (!nextState.enabled) {
        await resetDisplayFilter()
        commitFilter({ ...nextState, displays: {} })
        setStatus({ kind: 'warn', text: '滤镜已关闭，所有显示器已还原' })
        return
      }
      let ok = 0
      let firstErr: string | null = null
      for (const d of displays) {
        const p =
          nextState.displays[d.id] ?? (d.id === selectedId ? paramsRef.current : IDENTITY)
        try {
          await applyDisplayFilter(d.id, p)
          ok += 1
        } catch (e) {
          firstErr = String(e)
        }
      }
      if (firstErr) setStatus({ kind: 'err', text: firstErr })
      else setStatus({ kind: 'ok', text: `滤镜已启用（${ok} 台显示器）` })
    } catch (e) {
      setStatus({ kind: 'err', text: String(e) })
    }
  }

  const resetCurrent = async () => {
    if (!selectedId) return
    cancelTimers()
    try {
      await resetDisplayFilter(selectedId)
      const cur = filterRef.current
      if (cur) {
        const displaysMap = { ...cur.displays }
        delete displaysMap[selectedId]
        commitFilter({ ...cur, displays: displaysMap })
      }
      setParamsAll(IDENTITY)
      setStatus({ kind: 'warn', text: '当前显示器已还原' })
    } catch (e) {
      setStatus({ kind: 'err', text: String(e) })
    }
  }

  const resetAll = async () => {
    cancelTimers()
    try {
      await resetDisplayFilter()
      const cur = filterRef.current
      if (cur) commitFilter({ ...cur, displays: {} })
      setParamsAll(IDENTITY)
      setStatus({ kind: 'warn', text: '所有显示器已还原' })
    } catch (e) {
      setStatus({ kind: 'err', text: String(e) })
    }
  }

  /**
   * 把当前的参数写回某个已有方案（保留它的快捷键与位置）。
   *
   * 与「另存」区分：这里改的就是这套方案本身，用于「套用后微调再存回」的场景。
   */
  const updatePreset = (name: string) => {
    const cur = filterRef.current
    if (!cur) return
    const exist = cur.presets.some((p) => p.name === name)
    if (!exist) {
      setStatus({ kind: 'err', text: `方案「${name}」不存在，可能已被删除` })
      return
    }
    const presets = cur.presets.map((p) =>
      p.name === name ? { ...p, params: { ...paramsRef.current } } : p,
    )
    const nextState: DisplayFilterState = { ...cur, presets }
    commitFilter(nextState)
    saveDisplayFilter(nextState)
      .then(() => setStatus({ kind: 'ok', text: `方案「${name}」已更新为当前参数` }))
      .catch((e) => setStatus({ kind: 'err', text: String(e) }))
  }

  /** 套用方案：把参数推到当前显示器，并把「套用」按钮切成「保存」（见 appliedPreset） */
  const applyPreset = (name: string, params: DisplayFilterParams) => {
    pushParams({ ...params }, selectedId ? [selectedId] : [])
    setAppliedPreset(name)
    setStatus({ kind: 'ok', text: `已套用「${name}」，可继续微调后点「保存」写回该方案` })
  }

  /** 另存为新方案（同名则覆盖，等于改名前的「保存当前参数」） */
  const savePreset = () => {
    const name = presetName.trim()
    const cur = filterRef.current
    if (!name || !cur) return
    const overwrite = cur.presets.some((p) => p.name === name)
    const presets = [
      ...cur.presets.filter((p) => p.name !== name),
      { name, params: { ...paramsRef.current } },
    ]
    const nextState = { ...cur, presets }
    commitFilter(nextState)
    saveDisplayFilter(nextState).catch(() => {})
    setPresetName('')
    if (overwrite) setAppliedPreset(name)
    setStatus({
      kind: 'ok',
      text: overwrite ? `已覆盖同名方案「${name}」` : `已另存为「${name}」`,
    })
  }

  const removePreset = (name: string) => {
    const cur = filterRef.current
    if (!cur) return
    const nextState = { ...cur, presets: cur.presets.filter((p) => p.name !== name) }
    commitFilter(nextState)
    saveDisplayFilter(nextState).catch(() => {})
    if (appliedPreset === name) setAppliedPreset(null)
  }

  if (unsupported) {
    return (
      <Notice
        title="显示器滤镜需要 Windows 桌面客户端"
        text="这个工具经由系统接口改写本机显卡的 gamma 输出，浏览器与手机端都访问不到显示设备，请在 Windows 客户端里使用。"
      />
    )
  }

  if (loading) {
    return <div className="text-[13px] text-muted py-8">正在读取显示器…</div>
  }

  if (error) {
    return <Notice title="读取显示器失败" text={error} tone="err" />
  }

  if (!displays.length) {
    return (
      <Notice
        title="未检测到可调的显示器"
        text="远程桌面 / 部分虚拟显示器不暴露显卡 gamma 控制。请在接有物理显示器的电脑上使用。"
      />
    )
  }

  return (
    <div className="mx-auto w-full max-w-[920px] space-y-3 pb-6">
      {/* 总开关与整体状态 */}
      <div className="relative overflow-hidden rounded-xl border border-line/80 bg-gradient-to-br from-[#1b2231] via-[#161b22] to-[#12161d]">
        <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-amber/60 to-transparent" />
        <div className="flex items-center gap-3 px-4 py-3">
          <span
            className={`shrink-0 grid place-items-center w-10 h-10 rounded-lg border transition-colors ${
              enabled
                ? 'border-amber/40 bg-amber/10 text-[#d4a174] shadow-[0_0_16px_-6px_rgba(239,159,39,.8)]'
                : 'border-line bg-ink-700/50 text-muted'
            }`}
          >
            <svg viewBox="0 0 24 24" className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth="1.6">
              <rect x="2.5" y="4" width="19" height="12.5" rx="1.8" />
              <path d="M9 20h6M12 16.5V20" strokeLinecap="round" />
            </svg>
          </span>
          <div className="min-w-0">
            <div className="text-[14px] text-[#e6edf3]">显示器滤镜</div>
            <div className="mt-0.5 text-[11px] leading-snug text-muted/80">
              改写显卡 gamma 查找表 · 全屏游戏同样生效 · 不改游戏文件
            </div>
          </div>
          <div className="ml-auto shrink-0 flex items-center gap-3">
            <div className="text-right">
              <div
                className={`text-[11px] ${enabled ? 'text-[#3fb950]' : 'text-muted/70'}`}
              >
                {enabled ? `已启用 · ${appliedCount} 台生效` : '已关闭'}
              </div>
              <div className="text-[10px] text-muted/50">{displays.length} 台显示器在线</div>
            </div>
            <Switch checked={enabled} onChange={toggleEnabled} />
          </div>
        </div>
      </div>

      {/* 总开关关闭时收起全部设置，只留上方开关与一句说明 */}
      {!enabled ? (
        <div className="rounded-xl border border-dashed border-line/80 bg-ink-800/40 px-4 py-10 text-center">
          <div className="text-[13px] text-[#e6edf3]">滤镜已关闭</div>
          <div className="mx-auto mt-1 max-w-[420px] text-[12px] leading-relaxed text-muted/70">
            显示器已还原为系统默认。打开上方开关后即可调节参数、套用方案与绑定快捷键。
          </div>
        </div>
      ) : (
        <>
          {/* 显示器选择 */}
          <Section title="显示器" hint={selected ? '点击切换要调整的屏幕' : undefined} icon={<IconScreen />}>
            <div className="grid gap-2 p-3 [grid-template-columns:repeat(auto-fill,minmax(230px,1fr))]">
              {displays.map((d) => {
                const active = d.id === selectedId
                const p = filter?.displays[d.id]
                const on = enabled && !!p && deviation(p) > 0.004
                return (
                  <button
                    key={d.id}
                    onClick={() => selectDisplay(d.id)}
                    className={`group relative overflow-hidden rounded-lg border px-3 py-2.5 text-left transition-all ${
                      active
                        ? 'border-amber/70 bg-amber/[0.07] shadow-[0_0_0_1px_rgba(239,159,39,.22),0_10px_24px_-16px_rgba(239,159,39,.9)]'
                        : 'border-line/80 bg-ink-800/60 hover:border-line hover:bg-ink-700/50'
                    }`}
                  >
                    <div className="flex items-start gap-2">
                      <svg
                        viewBox="0 0 24 24"
                        className={`shrink-0 w-4 h-4 mt-0.5 ${active ? 'text-[#d4a174]' : 'text-muted/70'}`}
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.7"
                      >
                        <rect x="2.5" y="4.5" width="19" height="12" rx="1.6" />
                        <path d="M9.5 20h5M12 16.5V20" strokeLinecap="round" />
                      </svg>
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center gap-1.5">
                          <span className="truncate text-[12.5px] text-[#e6edf3]">{d.name || '未知输出'}</span>
                          {d.primary && (
                            <span className="shrink-0 rounded border border-amber/40 bg-amber/10 px-1 py-px text-[9px] text-[#d4a174]">
                              主
                            </span>
                          )}
                        </span>
                        <span className="mt-0.5 block truncate text-[10.5px] text-muted/70">
                          {d.monitor || d.id}
                        </span>
                        <span className="mt-1 flex items-center gap-2 text-[10.5px]">
                          <span className="font-mono text-muted/60">{d.id.replace('\\\\.\\', '')}</span>
                          {d.width > 0 && (
                            <span className="text-muted/50">
                              {d.width}×{d.height}
                            </span>
                          )}
                          {on && (
                            <span className="ml-auto flex items-center gap-1 text-[#3fb950]">
                              <span className="h-1.5 w-1.5 rounded-full bg-[#3fb950] shadow-[0_0_6px_#3fb950]" />
                              生效
                            </span>
                          )}
                        </span>
                      </span>
                    </div>
                  </button>
                )
              })}
            </div>

            {/* 显示器级操作：只针对选中的显示器（不再有「应用到所有」这种批量操作） */}
            <div className="flex flex-wrap items-center gap-2 border-t border-line/50 bg-[#0f141b]/40 px-3 py-2">
              <ActionButton onClick={resetCurrent} tone="plain">
                重置当前显示器
              </ActionButton>
              <ActionButton onClick={resetAll} tone="danger">
                重置所有显示器
              </ActionButton>
              <span className="ml-auto hidden text-[11px] text-muted/50 sm:inline">
                参数与快捷键都只作用于选中的屏幕
              </span>
            </div>
          </Section>

          {/* 调节参数 */}
          <Section
            title="调节参数"
            hint={selected ? selected.id.replace('\\\\.\\', '') : undefined}
            icon={<IconSliders />}
            right={
              <button
                onClick={() => pushParams(IDENTITY, selectedId ? [selectedId] : [])}
                className="rounded border border-line/80 px-2 py-1 text-[11px] text-muted hover:border-amber/50 hover:text-[#d4a174]"
              >
                重置
              </button>
            }
          >
            <div className="divide-y divide-line/40">
              {SLIDERS.map((def) => {
                const value = params[def.key]
                const pct = ((value - def.min) / (def.max - def.min)) * 100
                const dimmed = lockedRgb && (def.key === 'gammaG' || def.key === 'gammaB')
                return (
                  <div
                    key={def.key}
                    className={`flex items-center gap-3 px-3.5 py-2.5 ${dimmed ? 'opacity-45' : ''}`}
                  >
                    <span className="flex w-[86px] shrink-0 items-center gap-2">
                      <span
                        className="h-1.5 w-1.5 rounded-full"
                        style={{ background: def.accent, boxShadow: `0 0 6px ${def.accent}` }}
                      />
                      <span className="text-[12px] text-muted" title={def.desc}>
                        {def.label}
                      </span>
                    </span>
                    <input
                      type="range"
                      min={def.min}
                      max={def.max}
                      step={0.01}
                      value={value}
                      onChange={(e) => onParam(def, Number(e.target.value))}
                      className="df-range flex-1"
                      style={
                        {
                          '--df-accent': def.accent,
                          '--df-fill': `${clamp(pct, 0, 100)}%`,
                        } as CSSProperties
                      }
                    />
                    <ValueBox
                      value={value}
                      min={def.min}
                      max={def.max}
                      accent={def.accent}
                      onCommit={(v) => onParam(def, v)}
                    />
                  </div>
                )
              })}
            </div>
            <div className="flex items-center gap-3 border-t border-line/50 bg-[#0f141b]/40 px-3.5 py-2">
              <label className="flex cursor-pointer select-none items-center gap-2 text-[11.5px] text-muted">
                <input type="checkbox" checked={lockedRgb} onChange={toggleLock} className="accent-amber" />
                锁定 RGB 通道
                <span className="text-muted/50">（三个 Gamma 一起动，避免偏色）</span>
              </label>
            </div>
          </Section>

          {/* 配置方案 + 全局快捷键 */}
          <Section
            title="配置方案与快捷键"
            hint="套用后该行变「保存」可写回微调 · 点按键框绑定快捷键"
            icon={<IconPreset />}
          >
            <div className="divide-y divide-line/40">
              {(filter?.presets ?? []).map((p) => {
                const capturingThis = capturing === p.name
                const bound = !!p.hotkey && p.hotkey.vk > 0
                return (
                  <div
                    key={p.name}
                    className={`flex items-center gap-2 px-3 py-2 transition-colors ${
                      capturingThis ? 'bg-amber/[0.06]' : 'hover:bg-white/[0.02]'
                    }`}
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[12.5px] text-[#e6edf3]">{p.name}</span>
                      <span className="block truncate text-[10.5px] text-muted/60">
                        {presetHint(p.params)}
                      </span>
                    </span>
                    <button
                      onClick={() => setCapturing(capturingThis ? null : p.name)}
                      title="点击后按下组合键绑定；Delete 解除绑定"
                      className={`h-6 shrink-0 rounded border px-1.5 text-[11px] tabular-nums transition-colors ${
                        capturingThis
                          ? 'animate-pulse border-amber/70 bg-amber/15 text-[#e8b071]'
                          : bound
                            ? 'border-amber/40 bg-amber/[0.08] font-mono text-[#d4a174] hover:bg-amber/20'
                            : 'border-dashed border-line text-muted/50 hover:border-amber/50 hover:text-[#d4a174]'
                      }`}
                    >
                      {capturingThis ? '按键…' : bound ? p.hotkey?.label : '未绑定'}
                    </button>
                    {appliedPreset === p.name ? (
                      <button
                        onClick={() => updatePreset(p.name)}
                        title="把当前参数写回这套方案（快捷键绑定保持不变）"
                        className="h-6 shrink-0 rounded border border-amber/45 bg-amber/10 px-2 text-[11px] text-[#d4a174] transition-colors hover:bg-amber/20"
                      >
                        保存
                      </button>
                    ) : (
                      <button
                        onClick={() => applyPreset(p.name, p.params)}
                        title="把该方案套用到当前显示器，之后可微调并点「保存」写回"
                        className="h-6 shrink-0 rounded border border-line/80 px-2 text-[11px] text-muted transition-colors hover:border-amber/50 hover:text-[#d4a174]"
                      >
                        套用
                      </button>
                    )}
                    <button
                      onClick={() => removePreset(p.name)}
                      title="删除方案"
                      className="h-6 w-6 shrink-0 rounded text-[12px] text-muted/40 hover:bg-[#f85149]/10 hover:text-[#f85149]"
                    >
                      ×
                    </button>
                  </div>
                )
              })}
              {(filter?.presets ?? []).length === 0 && (
                <div className="px-3 py-2 text-[11.5px] text-muted/60">
                  还没有方案：调好参数后，在下面输入名称并「另存当前参数」。
                </div>
              )}
            </div>

            <div className="space-y-2 border-t border-line/50 p-3">
              <div className="flex items-center gap-2">
                <input
                  value={presetName}
                  onChange={(e) => setPresetName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') savePreset()
                  }}
                  placeholder="方案名称，如「夜图 · 亮度+60」"
                  className="h-8 min-w-0 flex-1 rounded-md border border-line/80 bg-[#0d1117] px-2.5 text-[12px] text-[#e6edf3] outline-none placeholder:text-muted/40 focus:border-amber/60"
                />
                <button
                  onClick={savePreset}
                  disabled={!presetName.trim()}
                  title="以新名称另存一套方案；同名会覆盖。要改已有方案请点该行的「套用」再「保存」"
                  className="h-8 shrink-0 rounded-md border border-amber/40 bg-amber/10 px-3 text-[12px] text-[#d4a174] transition-colors hover:bg-amber/20 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  另存当前参数
                </button>
              </div>

              {/* 「始终以管理员身份启动」：写注册表里的 exe 兼容性标记，下次启动生效 */}
              <div className="flex items-start gap-2 rounded-lg border border-line/60 bg-ink-800/50 px-2.5 py-2">
                <div className="min-w-0 flex-1">
                  <div className="text-[12px] text-[#e6edf3]">始终以管理员身份启动</div>
                  <div className="mt-0.5 text-[10.5px] leading-relaxed text-muted/70">
                    等同于右键程序 → 属性 → 兼容性 → 勾选「以管理员身份运行」：写入当前用户的
                    Windows 兼容性标记，<span className="text-[#d4a174]">下次启动</span>
                    会自动弹 UAC。不改动程序文件，取消勾选即恢复。
                  </div>
                </div>
                <Switch checked={autoAdmin} onChange={toggleAutoAdmin} />
              </div>

              {/* 快捷键状态 + 提权提示 */}
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] leading-relaxed">
                <span className="text-muted/70">
                  {capturing
                    ? '按下要绑定的组合键（Esc 取消）'
                    : !enabled
                      ? '滤镜关闭时不注册快捷键'
                      : hotkeyCount > 0
                        ? `已绑定 ${hotkeyCount} 个全局快捷键：只作用于当前选中的显示器`
                        : '未绑定快捷键：点右侧「未绑定」后按下组合键'}
                </span>
                {elevated ? (
                  <span className="ml-auto flex items-center gap-1 text-[#3fb950]">
                    <span className="h-1.5 w-1.5 rounded-full bg-[#3fb950] shadow-[0_0_6px_#3fb950]" />
                    已获管理员权限
                  </span>
                ) : (
                  <>
                    <span className="text-amber/80">
                      {autoAdmin
                        ? '· 已设为自动提权，但本次启动未提权（被命令行 / 计划任务拉起时不会生效）'
                        : '· 游戏以管理员身份运行时，本程序需同样提权才能收到按键'}
                    </span>
                    <button
                      onClick={elevate}
                      className="ml-auto shrink-0 rounded border border-amber/40 bg-amber/[0.08] px-2 py-0.5 text-[11px] text-[#d4a174] transition-colors hover:bg-amber/20"
                    >
                      以管理员身份重启
                    </button>
                  </>
                )}
              </div>
            </div>
          </Section>
        </>
      )}

      {/* 底部状态行（操作按钮已并入显示器模块） */}
      <div className="flex items-center gap-1.5 px-1 text-[11px]">
        <span
          className={`h-1.5 w-1.5 shrink-0 rounded-full ${
            status
              ? status.kind === 'ok'
                ? 'bg-[#3fb950] shadow-[0_0_6px_#3fb950]'
                : status.kind === 'warn'
                  ? 'bg-amber shadow-[0_0_6px_#ef9f27]'
                  : 'bg-[#f85149] shadow-[0_0_6px_#f85149]'
              : 'bg-muted/40'
          }`}
        />
        <span
          className={`truncate ${status ? 'text-muted/80' : 'text-muted/50'}`}
          title={status?.text}
        >
          {status?.text ??
            (enabled ? '参数即时生效，程序退出后仍保留' : '滤镜已关闭，显示器保持系统默认')}
        </span>
      </div>
    </div>
  )
}

/* ---------------- 局部组件 ---------------- */

function Section({
  title,
  hint,
  icon,
  right,
  children,
}: {
  title: string
  hint?: string
  icon: ReactNode
  right?: ReactNode
  children: ReactNode
}) {
  return (
    <div className="overflow-hidden rounded-xl border border-line/80 bg-gradient-to-b from-[#161b22] to-[#131820]">
      <div className="flex items-center gap-2 border-b border-line/60 bg-white/[0.02] px-3.5 py-2">
        <span className="text-[#d4a174]">{icon}</span>
        <h2 className="text-[12.5px] font-medium tracking-wide text-[#e6edf3]">{title}</h2>
        {hint && <span className="text-[10.5px] text-muted/60">{hint}</span>}
        {right && <span className="ml-auto">{right}</span>}
      </div>
      {children}
    </div>
  )
}

function Switch({ checked, onChange }: { checked: boolean; onChange: () => void }) {
  return (
    <button
      role="switch"
      aria-checked={checked}
      onClick={onChange}
      className={`relative h-5 w-9 shrink-0 rounded-full transition-colors ${
        checked ? 'bg-amber/80' : 'bg-ink-600'
      }`}
    >
      <span
        className={`absolute top-0.5 h-4 w-4 rounded-full bg-[#f2f5f8] shadow transition-all ${
          checked ? 'left-[18px]' : 'left-0.5'
        }`}
      />
    </button>
  )
}

function ActionButton({
  children,
  onClick,
  tone,
}: {
  children: ReactNode
  onClick: () => void
  tone: 'plain' | 'primary' | 'danger'
}) {
  const cls =
    tone === 'primary'
      ? 'border-amber/50 bg-amber/15 text-[#e8b071] hover:bg-amber/25'
      : tone === 'danger'
        ? 'border-line/80 text-muted hover:border-[#f85149]/50 hover:text-[#f85149]'
        : 'border-line/80 text-muted hover:border-line hover:text-[#e6edf3]'
  return (
    <button
      onClick={onClick}
      className={`h-8 rounded-md border px-3 text-[12px] transition-colors ${cls}`}
    >
      {children}
    </button>
  )
}

/** 数值输入：聚焦期间保留用户正在敲的文本，失焦 / 回车才提交 */
function ValueBox({
  value,
  min,
  max,
  accent,
  onCommit,
}: {
  value: number
  min: number
  max: number
  accent: string
  onCommit: (v: number) => void
}) {
  const [draft, setDraft] = useState<string | null>(null)
  const commit = () => {
    if (draft === null) return
    const n = Number(draft)
    if (Number.isFinite(n)) onCommit(clamp(n, min, max))
    setDraft(null)
  }
  return (
    <input
      value={draft ?? value.toFixed(2)}
      onChange={(e) => setDraft(e.target.value)}
      onFocus={() => setDraft(value.toFixed(2))}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur()
        else if (e.key === 'Escape') setDraft(null)
      }}
      inputMode="decimal"
      style={{ color: accent }}
      className="h-7 w-[64px] shrink-0 rounded-md border border-line/80 bg-[#0d1117] px-2 text-right text-[12px] tabular-nums outline-none focus:border-amber/60 focus:ring-1 focus:ring-amber/20"
    />
  )
}

function Notice({
  title,
  text,
  tone = 'plain',
}: {
  title: string
  text: string
  tone?: 'plain' | 'err'
}) {
  return (
    <div
      className={`rounded-xl border px-4 py-3 ${
        tone === 'err' ? 'border-[#f85149]/40 bg-[#f85149]/5' : 'border-line/80 bg-ink-800/60'
      }`}
    >
      <div className="text-[13px] text-[#e6edf3]">{title}</div>
      <div className="mt-1 text-[12px] leading-relaxed text-muted/80">{text}</div>
    </div>
  )
}

function IconScreen() {
  return (
    <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2">
      <rect x="2.5" y="4.5" width="19" height="12" rx="1.6" />
      <path d="M9.5 20h5M12 16.5V20" strokeLinecap="round" />
    </svg>
  )
}

function IconSliders() {
  return (
    <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M5 4v6M5 14v6M12 4v10M12 18v2M19 4v2M19 10v10" strokeLinecap="round" />
      <circle cx="5" cy="12" r="1.6" />
      <circle cx="12" cy="16" r="1.6" />
      <circle cx="19" cy="8" r="1.6" />
    </svg>
  )
}

function IconPreset() {
  return (
    <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M4 6.5A1.5 1.5 0 0 1 5.5 5H9l1.5 2H18a1.5 1.5 0 0 1 1.5 1.5v9A1.5 1.5 0 0 1 18 19H5.5A1.5 1.5 0 0 1 4 17.5z" strokeLinejoin="round" />
    </svg>
  )
}
