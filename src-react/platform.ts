/**
 * 平台探测（移动端 UI 适配用）。
 *
 * 用 navigator.userAgent 粗判移动端，避免引入 @tauri-apps/plugin-os
 * （需额外 Rust crate + capability + 移动构建链验证）。
 * 桌面 Tauri WebView 的 UA 不含 android/iphone/ipad/ipod，移动 WebView 均含，判定可靠。
 * 后续如需更精细的平台信息（android/ios 区分等），可替换为 plugin-os 的 platform()。
 */
export function isMobile(): boolean {
  if (typeof navigator === 'undefined') return false
  const ua = navigator.userAgent || ''
  return /android|iphone|ipad|ipod/i.test(ua)
}
