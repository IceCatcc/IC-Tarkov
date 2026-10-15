/**
 * 打包「自有图片资源」，生成上传到 Release 的资源包与清单。
 *
 *   node scripts/pack-assets.mjs
 *
 * 产出（dist-assets/，**两个文件都要上传**，且必须放在同一目录下）：
 *   assets.zip            地图底图 SVG / 地图标记图标 / Boss 图（zip 内保持 public/ 下的相对路径）
 *   assets-manifest.json  清单：资源包文件名 + 内容摘要（后端据此判断要不要整包重下）
 *
 * 客户端的取用逻辑见 src-tauri/src/assets.rs：物品图标与商人头像直连
 * assets.tarkov.dev，不在这里的资源包内。
 *
 * 上传到本仓库 Release 的 `assets` 标签（对应 assets.rs 里的默认基址）：
 *   gh release create assets dist-assets/assets.zip dist-assets/assets-manifest.json \
 *      --title "图片资源" --notes "地图底图 / 地图标记 / Boss 图"
 * 自建服务则把两个文件放到同一目录，并用环境变量 IC_ASSETS_BASE 指向它。
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const publicDir = path.join(root, 'public')
const outDir = path.join(root, 'dist-assets')
const zipName = 'assets.zip'
const zipPath = path.join(outDir, zipName)

/** 打进资源包的目录（zip 内的路径 = 前端 public/ 下的相对路径） */
const SOURCES = ['maps', 'boss-icons']

function fail(msg) {
  console.error(`[assets] ${msg}`)
  process.exit(1)
}

const present = SOURCES.filter((d) => existsSync(path.join(publicDir, d)))
if (present.length === 0) {
  fail(`public/ 下没有可打包的目录（${SOURCES.join(' / ')}）`)
}

mkdirSync(outDir, { recursive: true })
if (existsSync(zipPath)) rmSync(zipPath, { force: true })

// 用系统命令打包：zip 内保留 public/ 下的相对路径，客户端解包后直接对应前端路径
const packed =
  process.platform === 'win32'
    ? spawnSync(
        'powershell',
        [
          '-NoProfile',
          '-Command',
          `Compress-Archive -Path ${present
            .map((d) => `'${path.join(publicDir, d)}'`)
            .join(',')} -DestinationPath '${zipPath}' -Force`,
        ],
        { stdio: 'inherit' },
      )
    : spawnSync('zip', ['-r', '-q', zipPath, ...present], { cwd: publicDir, stdio: 'inherit' })

if (packed.status !== 0 || !existsSync(zipPath)) {
  fail('打包失败：Windows 需要 PowerShell（Compress-Archive），其它平台需要 zip 命令')
}

const bytes = statSync(zipPath).size
const hash = createHash('sha256').update(readFileSync(zipPath)).digest('hex').slice(0, 16)

const manifest = {
  version: 1,
  zip: zipName,
  // 内容摘要：客户端与本地记录一致时跳过整个资源包的下载
  hash,
  bytes,
  packedAt: Math.floor(Date.now() / 1000),
  sources: present,
}
writeFileSync(
  path.join(outDir, 'assets-manifest.json'),
  `${JSON.stringify(manifest, null, 2)}\n`,
  'utf8',
)

console.log(
  `[assets] 已生成 ${path.relative(root, zipPath)}（${(bytes / 1048576).toFixed(1)} MB，` +
    `含 ${present.join(' / ')}）与 assets-manifest.json（hash=${hash}）`,
)
console.log('[assets] 把这两个文件一起上传到 Release 的 assets 标签（或自建目录 + IC_ASSETS_BASE）')
