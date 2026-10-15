/**
 * 应用外壳能力（桌面端 = Tauri 窗口 / 版本号；Web 端 = 浏览器）。
 *
 * 这些能力在两端差异极大，且必须避免在 Web 环境里 import Tauri 的窗口模块
 * （`getCurrentWindow()` 在普通浏览器里会在模块加载期直接抛错），
 * 因此统一包一层并做平台判断。
 */
import { isWeb } from '../platform'

/** 应用版本号；Web 端返回空串（顶部栏据此隐藏版本标签与更新提示） */
export async function appVersion(): Promise<string> {
  if (isWeb()) return ''
  try {
    const mod = await import('@tauri-apps/api/app')
    return await mod.getVersion()
  } catch {
    return ''
  }
}

async function currentWindow(): Promise<import('@tauri-apps/api/window').Window> {
  const mod = await import('@tauri-apps/api/window')
  return mod.getCurrentWindow()
}

export async function minimizeWindow(): Promise<void> {
  if (isWeb()) return
  try {
    await (await currentWindow()).minimize()
  } catch {
    /* 忽略 */
  }
}

export async function toggleMaximizeWindow(): Promise<void> {
  if (isWeb()) return
  try {
    await (await currentWindow()).toggleMaximize()
  } catch {
    /* 忽略 */
  }
}

export async function closeWindow(): Promise<void> {
  if (isWeb()) return
  try {
    await (await currentWindow()).close()
  } catch {
    /* 忽略 */
  }
}

/**
 * 取 `convertFileSrc`：把本地绝对路径转成 Tauri 的 `asset:` 协议 URL。
 *
 * 与窗口控制同理，不能在 Web 环境里静态 import Tauri 的 core 模块，故动态加载。
 * 返回 null 表示当前环境不支持（Web 端）——调用方据此一律回退随包资源。
 * 取回的函数是同步的，可缓存后直接在 render 里用（见 src-react/assetUrl.ts）。
 */
export async function loadConvertFileSrc(): Promise<((path: string) => string) | null> {
  if (isWeb()) return null
  try {
    const mod = await import('@tauri-apps/api/core')
    return mod.convertFileSrc
  } catch {
    return null
  }
}

/**
 * 监听 Tauri 全局事件；Web 端恒为空实现。
 * 返回取消函数，与 `listen` 的用法保持一致。
 */
export async function listenEvent<T>(
  name: string,
  handler: (payload: T) => void,
): Promise<() => void> {
  if (isWeb()) return () => {}
  try {
    const mod = await import('@tauri-apps/api/event')
    return await mod.listen<T>(name, (e) => handler(e.payload))
  } catch {
    return () => {}
  }
}
