/**
 * 打包统一入口：把「抓种子数据 / tauri 构建 / 产物改名」串成一条命令。
 *
 *   node scripts/build-app.mjs [--skip-data] [--no-bundle] [--android]
 *
 * 1. 先跑 scripts/fetch-api-data.mjs，把 tarkov.dev 原始 JSON 抓到 src-tauri/resources/api
 * 2. tauri build：build.rs 把种子 gzip 内嵌进二进制，resources/api 同时作为打包资源
 *
 * --skip-data  跳过抓取（用本地已有种子；没有种子时等同无内置数据，首启会联网下载）
 * --no-bundle  透传 tauri：只出 exe，不做安装包
 * --android    改为 Android APK：tauri android build + 签名（其余参数透传）
 */
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const APK_FULL = 'apks/IC-Tarkov-arm64.apk'

const argv = process.argv.slice(2)
const android = argv.includes('--android')
const skipData = argv.includes('--skip-data')
const passArgs = argv.filter((a) => !['--skip-data', '--android'].includes(a))

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

// 1. 种子数据
if (skipData) {
  console.log('[build] --skip-data：跳过抓取，使用本地已有种子')
} else {
  run('npm run data:fetch')
}

// 2. 构建
if (android) {
  run(`npx tauri android build --apk --target aarch64 ${passArgs.join(' ')}`.trim())
  run(`node scripts/sign-apk.mjs ${APK_FULL}`)
} else {
  run(`npx tauri build ${passArgs.join(' ')}`.trim())
}

console.log('[build] 完成')
