/**
 * 图片资源的统一取用入口（物品图标 / 商人头像 / Boss 图 / 地图底图 / 地图标记）。
 *
 * 每张图都有两个可能来源，且**互不排斥**：
 *   1. 随包资源：打进安装包的 `public/` 下文件，站点根下的相对路径即可访问
 *      （完整版安装包自带全部图片，离线也能用）；
 *   2. 运行时资源：用户点「更新图片资源」（或首次启动兜底下载）时落到
 *      `<数据目录>/tarkov-assets` 的版本，必须经 Tauri 的 `asset:` 协议访问
 *      （lite 版完全依赖它）。
 *
 * 启动时取一次资源索引（`getAssetIndex`，见 boot 流程）：运行时目录里有这张图就用它，
 * 否则回退随包版本 —— 于是「在线可更新」与「离线可用」同时成立。
 * 图片资源更新结束（`assets-synced`）后刷新索引并通知订阅者重渲染，新图立即生效。
 *
 * Web 端（服务端部署）没有本机资源目录，恒用随包版本。
 */
import { getAssetIndex } from './tauri'
import { loadConvertFileSrc, listenEvent } from './api/shell'

/** 资源目录绝对路径（空串 = 不可用） */
let assetsDir = ''
/** 已下载的资源相对路径集合 */
let available = new Set<string>()
/** 已下载资源涉及的目录集合（瓦片模板判断「这一级有没有下载的瓦片」用） */
let availableDirs = new Set<string>()
/** convertFileSrc（Tauri）或 null（Web 端 / 取不到） */
let convert: ((path: string) => string) | null = null

const listeners = new Set<() => void>()

/**
 * 刷新资源索引：启动时调用一次，图片资源更新结束（assets-synced）后再调一次。
 * 索引有变化时通知订阅者（顶层据此重渲染，让新下载的图片替换掉随包路径）。
 */
export async function refreshAssetIndex(): Promise<void> {
  try {
    const idx = await getAssetIndex()
    const next = new Set(idx.files)
    const changed = idx.dir !== assetsDir || next.size !== available.size
    const nextDirs = new Set<string>()
    for (const f of next) {
      const parts = f.split('/')
      for (let i = 1; i < parts.length; i += 1) nextDirs.add(parts.slice(0, i).join('/'))
    }
    assetsDir = idx.dir
    available = next
    availableDirs = nextDirs
    if (!convert) convert = await loadConvertFileSrc()
    if (changed) listeners.forEach((fn) => fn())
  } catch {
    /* 取不到索引（旧后端 / 环境不支持）时保持现状，一律用随包资源 */
  }
}

/**
 * 图片资源更新结束后自动刷新索引：后端 `assets-synced` 事件（「更新图片资源」按钮 /
 * 首次启动兜底下载都会发）。`data-synced` 一并挂着：新后端里游戏数据更新不再动图片，
 * 但旧后端会借它通知，多听一个事件没有代价。
 * 返回取消函数；Web 端没有这些事件，恒为空实现。
 */
export function registerAssetSyncListener(): () => void {
  const offs: ((() => void) | null)[] = []
  let disposed = false
  for (const ev of ['assets-synced', 'data-synced']) {
    const i = offs.length
    offs.push(null)
    void listenEvent(ev, () => void refreshAssetIndex()).then((u) => {
      if (disposed) u()
      else offs[i] = u
    })
  }
  return () => {
    disposed = true
    offs.forEach((f) => f?.())
  }
}

export function subscribeAssets(fn: () => void): () => void {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}

/**
 * 相对路径（与 `public/` 下一致，'/' 分隔）→ 可直接放进 `<img src>` / `fetch` 的 URL。
 * 已是完整 URL（http/https/协议形式）的原样返回。
 */
export function assetUrl(rel: string): string {
  if (!rel) return rel
  if (/^(https?:|data:|blob:|asset:|tauri:)/i.test(rel)) return rel
  const clean = rel.replace(/^\/+/, '')
  if (assetsDir && convert && available.has(clean)) {
    return convert(`${assetsDir}/${clean}`)
  }
  return `/${clean}`
}

/**
 * 瓦片模板（含 `{z}` / `{x}` / `{y}` 占位）→ URL。
 *
 * 模板没法按「这个文件是否存在」判断，因此改为看**该模板所在的目录**在运行时资源里
 * 有没有内容：有（说明瓦片已被「更新图片资源」下载或本就由接口下发）就用资源目录，
 * 否则回退随包路径——于是「用瓦片的地图 / 楼层」在两种分发形态下都成立
 * （用不用瓦片由 MapPage 决定：有 SVG 线稿的地图与楼层不用卫星图）。
 */
export function assetUrlTemplate(tpl: string): string {
  if (!tpl) return tpl
  if (/^(https?:|data:|blob:|asset:|tauri:)/i.test(tpl)) return tpl
  const clean = tpl.replace(/^\/+/, '')
  const cut = clean.indexOf('{')
  if (cut > 0 && assetsDir && convert) {
    const dir = clean.slice(0, cut).replace(/\/[^/]*$/, '')
    if (availableDirs.has(dir)) return convert(`${assetsDir}/${clean}`)
  }
  return `/${clean}`
}
