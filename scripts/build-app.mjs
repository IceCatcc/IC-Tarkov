/**
 * 打包统一入口：把「抓种子数据 / 无内置数据版 / tauri 构建 / 产物改名」串成一条命令。
 *
 *   node scripts/build-app.mjs [--lite] [--skip-data] [--no-bundle] [--android]
 *
 * 完整版（默认）
 *   1. 先跑 scripts/fetch-api-data.mjs，把 tarkov.dev 原始 JSON 抓到 src-tauri/resources/api
 *   2. tauri build：build.rs 把种子 gzip 内嵌进二进制，resources/api 同时作为打包资源
 *
 * 无内置数据版（--lite）
 *   - 跳过抓取，设 IC_NO_SEED=1（build.rs 不内嵌），并把本地已有种子临时挪走，
 *     避免 tauri 把它们打进安装包；数据由用户首次启动时联网下载
 *   - 产物加 _lite 后缀（NSIS 安装包 ...-setup_lite.exe / APK IC-Tarkov-arm64-lite.apk），
 *     与完整版并存不互相覆盖
 *
 * --skip-data  完整版也跳过抓取（用本地已有种子；没有种子时等同无内置数据版）
 * --no-bundle  透传 tauri：只出 exe，不做安装包
 * --android    改为 Android APK：tauri android build + 签名（其余参数透传）
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const API_DIR = path.join(ROOT, 'src-tauri', 'resources', 'api')
/** --lite 期间本地种子的暂存目录（构建结束自动挪回；异常残留会在下次运行时自愈） */
const STASH_DIR = path.join(ROOT, 'src-tauri', 'resources', '.api-stash')
const NSIS_DIR = path.join(ROOT, 'src-tauri', 'target', 'release', 'bundle', 'nsis')
const APK_FULL = 'apks/IC-Tarkov-arm64.apk'
const APK_LITE = 'apks/IC-Tarkov-arm64-lite.apk'

const argv = process.argv.slice(2)
const lite = argv.includes('--lite')
const android = argv.includes('--android')
const noBundle = argv.includes('--no-bundle') && !android
const skipData = lite || argv.includes('--skip-data')
const passArgs = argv.filter((a) => !['--lite', '--skip-data', '--android'].includes(a))

function fail(msg) {
  console.error(`[build] ${msg}`)
  process.exit(1)
}

function run(cmd, extraEnv = {}) {
  console.log(`[build] > ${cmd}`)
  const r = spawnSync(cmd, {
    shell: true,
    stdio: 'inherit',
    cwd: ROOT,
    env: { ...process.env, ...extraEnv },
  })
  if (r.status !== 0) fail(`命令失败（exit ${r.status}）：${cmd}`)
}

/** 把本地种子挪到暂存目录（返回是否真的挪了东西） */
function stashSeeds() {
  if (existsSync(STASH_DIR)) restoreSeeds() // 上次异常残留：先还原再重来
  const files = existsSync(API_DIR) ? readdirSync(API_DIR).filter((f) => f.endsWith('.json')) : []
  if (files.length === 0) return false
  mkdirSync(STASH_DIR, { recursive: true })
  for (const f of files) renameSync(path.join(API_DIR, f), path.join(STASH_DIR, f))
  console.log(`[build] 已临时挪走 ${files.length} 个本地种子（lite 版不打进包）`)
  return true
}

function restoreSeeds() {
  if (!existsSync(STASH_DIR)) return
  for (const f of readdirSync(STASH_DIR)) {
    renameSync(path.join(STASH_DIR, f), path.join(API_DIR, f))
  }
  rmSync(STASH_DIR, { recursive: true, force: true })
  console.log('[build] 本地种子已还原')
}

/** lite 安装包加 _lite 后缀（取目录里最新生成的 exe，避免误改旧版本产物） */
function renameLiteInstaller() {
  if (!existsSync(NSIS_DIR)) return
  const exes = readdirSync(NSIS_DIR).filter(
    (f) => f.toLowerCase().endsWith('.exe') && !f.includes('_lite'),
  )
  if (exes.length === 0) {
    console.warn('[build] 未在 NSIS 目录找到安装包，跳过改名')
    return
  }
  const newest = exes
    .map((f) => ({ f, t: statSync(path.join(NSIS_DIR, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t)[0].f
  const to = newest.replace(/\.exe$/i, '_lite.exe')
  renameSync(path.join(NSIS_DIR, newest), path.join(NSIS_DIR, to))
  console.log(`[build] lite 安装包：${path.join(NSIS_DIR, to)}`)
}

// 1. 种子数据
if (!skipData) {
  run('npm run data:fetch')
} else {
  console.log(
    lite
      ? '[build] --lite：不抓取种子数据（数据由用户首次启动时下载）'
      : '[build] --skip-data：跳过抓取，使用本地已有种子',
  )
}

// 2. 构建
// lite 版两个开关：
//   IC_NO_SEED      build.rs 不内嵌种子 JSON
//   IC_NO_ASSETS    build.rs 输出空的随包图片清单，且 Vite 构建后把图片从产物里剔除
const liteEnv = lite ? { IC_NO_SEED: '1', IC_NO_ASSETS: '1' } : {}
if (android) {
  const stashed = lite ? stashSeeds() : false
  try {
    run(`npx tauri android build --apk --target aarch64 ${passArgs.join(' ')}`.trim(), liteEnv)
    run(`node scripts/sign-apk.mjs ${lite ? APK_LITE : APK_FULL}`)
  } finally {
    if (stashed) restoreSeeds()
  }
} else {
  const stashed = lite ? stashSeeds() : false
  try {
    run(`npx tauri build ${passArgs.join(' ')}`.trim(), liteEnv)
    if (lite && !noBundle) renameLiteInstaller()
  } finally {
    if (stashed) restoreSeeds()
  }
}

console.log(lite ? '[build] 完成（无内置数据版）' : '[build] 完成（完整版）')
