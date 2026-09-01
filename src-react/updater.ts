// GitHub Releases 版本检测（只读，不做自动更新）
// 联网失败或返回异常时一律静默返回 null，不打扰用户。

const REPO = 'IceCatcc/IC-Tarkov'
const API = `https://api.github.com/repos/${REPO}/releases/latest`
const RELEASES_PAGE = `https://github.com/${REPO}/releases`

export interface ReleaseInfo {
  /** 最新版本号（去掉 tag 前缀 v，如 0.1.6） */
  version: string
  /** GitHub Releases 说明正文 */
  notes: string
  /** 发布页地址 */
  url: string
}

/**
 * 比较 semver（支持 x.y.z，忽略前导 v 与预发布后缀）。
 * current 为空（如开发环境取不到版本号）时始终返回 false，避免误提示。
 */
export function isNewer(latest: string, current: string): boolean {
  if (!current || !current.trim()) return false
  const parse = (v: string) => {
    const core = v.trim().replace(/^v/i, '').split('-')[0] || ''
    const parts = core.split('.').map((n) => parseInt(n, 10) || 0)
    while (parts.length < 3) parts.push(0)
    return parts.slice(0, 3)
  }
  const a = parse(latest)
  const b = parse(current)
  for (let i = 0; i < 3; i++) {
    if (a[i] > b[i]) return true
    if (a[i] < b[i]) return false
  }
  return false
}

/**
 * 拉取 GitHub 最新 release。
 * 任何失败（网络异常 / 非 200 / 结构不符 / 无 release）都返回 null。
 */
export async function checkLatestRelease(signal?: AbortSignal): Promise<ReleaseInfo | null> {
  try {
    const res = await fetch(API, {
      headers: { Accept: 'application/vnd.github+json' },
      ...(signal ? { signal } : {}),
    })
    if (!res.ok) return null
    const json = (await res.json()) as {
      tag_name?: string
      name?: string
      body?: string
      html_url?: string
    }
    if (!json || typeof json.tag_name !== 'string' || !json.tag_name) return null
    return {
      version: json.tag_name.replace(/^v/i, ''),
      notes: typeof json.body === 'string' ? json.body.trim() : '',
      url: json.html_url || RELEASES_PAGE,
    }
  } catch {
    // 断网 / 超时 / 被拦截：静默失败
    return null
  }
}

export { RELEASES_PAGE }
