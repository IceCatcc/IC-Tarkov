/**
 * 生成图片资源的**增量清单**与散附件。
 *
 *   node scripts/pack-assets.mjs              # 含物品图标 / 商人头像的版本标记
 *   node scripts/pack-assets.mjs --no-icons   # 只打包自有资源（不抓上游图标标记，快很多）
 *
 * 产出（dist-assets/，**全部一起上传，且必须放在同一目录下**）：
 *   files/                自有资源的附件（扁平命名：maps__svg__Customs.svg）
 *   assets-manifest.json  清单：每条 = { path, name | url, bytes, etag }
 *
 * 客户端（src-tauri/src/assets.rs）拿清单与本地记录逐条比对：
 * **摘要一致就整条跳过，只下载变化的文件** —— 改一张底图不会再重下整套资源。
 * 物品图标与商人头像不在附件里（它们直连 assets.tarkov.dev），清单只带它们的
 * 上游版本标记，于是「上游换了某张图」也能只更新那几张。
 *
 * 上传到本仓库 Release 的 `assets` 标签（对应 assets.rs 里的默认基址）：
 *   gh release create assets dist-assets/assets-manifest.json dist-assets/files/* \
 *      --title "图片资源" --notes "地图底图 / 地图标记 / Boss 图 + 图标版本标记"
 * 自建服务则把 files/ 与清单放进同一目录，并用环境变量 IC_ASSETS_BASE 指向它。
 */
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const publicDir = path.join(root, 'public')
const outDir = path.join(root, 'dist-assets')
const filesDir = path.join(outDir, 'files')
const manifestName = 'assets-manifest.json'

/** 打进附件目录的自有资源（zip 内的路径 = 前端 public/ 下的相对路径） */
const SOURCES = ['maps', 'boss-icons']
/** 上游 CDN：物品图标与商人头像（清单只记版本标记，不搬文件） */
const CDN_BASE = 'https://assets.tarkov.dev'
/** 抓上游版本标记的并发数 */
const HEAD_CONCURRENCY = 16

const withIcons = !process.argv.includes('--no-icons')

function fail(msg) {
  console.error(`[assets] ${msg}`)
  process.exit(1)
}

/** 落盘删除交给系统命令：IDE 会拦截 Node 进程自身的批量 fs 删除（同 clean-dist.mjs） */
function rmDir(dir) {
  if (!existsSync(dir)) return
  const trash = `${dir}-trash-${process.pid}`
  try {
    spawnSync('cmd', ['/c', 'move', dir, trash], { stdio: 'ignore' })
  } catch {
    /* 忽略 */
  }
  const r =
    process.platform === 'win32'
      ? spawnSync('cmd', ['/c', 'rmdir', '/s', '/q', existsSync(trash) ? trash : dir], { stdio: 'ignore' })
      : spawnSync('rm', ['-rf', existsSync(trash) ? trash : dir], { stdio: 'ignore' })
  if (r.status !== 0) console.warn(`[assets] WARN: 无法清理 ${dir}`)
}

/** 递归列出目录下的文件（相对 public 的路径，'/' 分隔） */
function walk(dir, prefix, out) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const rel = `${prefix}${e.name}`
    const abs = path.join(dir, e.name)
    if (e.isDirectory()) walk(abs, `${rel}/`, out)
    else out.push({ rel, abs })
  }
}

/** 内容摘要（sha256 前 16 位）：客户端据此判断本地副本是否需要替换 */
function digest(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex').slice(0, 16)
}

/** 从「中文本地化」文件里取 id（其结构是 { data: { "<id> Name": "中文名" } }） */
function zhIds(file, suffix) {
  const p = path.join(root, 'src-tauri', 'resources', 'api', file)
  if (!existsSync(p)) return []
  const data = JSON.parse(readFileSync(p, 'utf8'))?.data ?? {}
  const ids = new Set()
  for (const k of Object.keys(data)) {
    if (k.endsWith(suffix)) ids.add(k.slice(0, -suffix.length))
  }
  return [...ids].sort()
}

/** 抓上游的版本标记（ETag；没有就退化为 Last-Modified + 长度），失败即跳过 */
async function headVersion(items) {
  const out = []
  let next = 0
  await Promise.all(
    Array.from({ length: HEAD_CONCURRENCY }, async () => {
      for (;;) {
        const i = next++
        if (i >= items.length) return
        const it = items[i]
        try {
          const r = await fetch(it.url, { method: 'HEAD' })
          if (!r.ok) continue
          const etag =
            r.headers.get('etag') ||
            `${r.headers.get('last-modified') ?? ''}|${r.headers.get('content-length') ?? ''}`
          if (etag && etag !== '|') out.push({ ...it, etag })
        } catch {
          /* 网络问题就跳过：客户端还有「缺失即下」的兜底 */
        }
      }
    }),
  )
  return out
}

// ---- 1. 自有资源：复制成扁平附件 + 记录摘要 ----
const present = SOURCES.filter((d) => existsSync(path.join(publicDir, d)))
if (present.length === 0) fail(`public/ 下没有可打包的目录（${SOURCES.join(' / ')}）`)

rmDir(filesDir)
mkdirSync(filesDir, { recursive: true })

const entries = []
for (const sub of present) {
  const files = []
  walk(path.join(publicDir, sub), `${sub}/`, files)
  for (const f of files) {
    // 附件名不能用 '/' 分隔，扁平成 maps__svg__Customs.svg
    const name = f.rel.replace(/\//g, '__')
    copyFileSync(f.abs, path.join(filesDir, name))
    entries.push({ path: f.rel, name, bytes: statSync(f.abs).size, etag: digest(f.abs) })
  }
}

// ---- 2. 图标 / 商人头像：只记上游版本标记（文件本身仍从 CDN 直连）----
let iconCount = 0
if (withIcons) {
  const iconItems = zhIds('regular_items_zh.json', ' Name').map((id) => ({
    path: `item-icons/${id}.webp`,
    url: `${CDN_BASE}/${id}-icon.webp`,
  }))
  const traderItems = zhIds('regular_traders_zh.json', ' Description').map((id) => ({
    path: `trader-icons/${id}.webp`,
    url: `${CDN_BASE}/${id}.webp`,
  }))
  const all = [...iconItems, ...traderItems]
  if (all.length === 0) {
    console.warn('[assets] 没有找到物品 / 商人数据（先跑 npm run data:fetch），本次不含图标标记')
  } else {
    console.log(`[assets] 抓取 ${all.length} 个图标的版本标记…`)
    const got = await headVersion(all)
    entries.push(...got)
    iconCount = got.length
    if (got.length < all.length) {
      console.warn(`[assets] ${all.length - got.length} 个图标没抓到标记（客户端会退化为「缺失即下」）`)
    }
  }
}

// ---- 3. 写清单 ----
entries.sort((a, b) => a.path.localeCompare(b.path))
// 只有程序会读，紧凑序列化（缩进会让这份「每次更新都要下载」的清单多出约 200 KB）
writeFileSync(
  path.join(outDir, manifestName),
  `${JSON.stringify({ version: 2, generatedAt: Math.floor(Date.now() / 1000), files: entries })}\n`,
  'utf8',
)

const attached = entries.length - iconCount
const kb = Math.round(statSync(path.join(outDir, manifestName)).size / 1024)
console.log(
  `[assets] 清单共 ${entries.length} 条（附件 ${attached} 个 + 图标标记 ${iconCount} 个，${kb} KB）\n` +
    `[assets] 上传：dist-assets/${manifestName} 与 dist-assets/files/ 下全部附件（同一目录）`,
)
