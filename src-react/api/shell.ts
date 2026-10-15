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
