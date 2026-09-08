/**
 * 对 tauri android 产物（未签名 release APK）做 zipalign + debug 密钥签名。
 * 用法：node scripts/sign-apk.mjs [输出路径]（默认 apks/IC-Tarkov-arm64.apk）
 * 依赖环境变量：ANDROID_HOME（SDK 根）；JAVA_HOME 可选（找不到时回退 PATH 里的 keytool/java）。
 * 签名密钥：%USERPROFILE%/.android/debug.keystore（不存在时自动生成，仅用于分发可安装包）。
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

const OUT = process.argv[2] || 'apks/IC-Tarkov-arm64.apk'
const RAW =
  'src-tauri/gen/android/app/build/outputs/apk/universal/release/app-universal-release-unsigned.apk'
const win = process.platform === 'win32'

function fail(msg) {
  console.error(`[sign-apk] ${msg}`)
  process.exit(1)
}
function run(cmd) {
  console.log(`[sign-apk] > ${cmd}`)
  const env = { ...process.env }
  if (javaBin) env.PATH = `${javaBin}${path.delimiter}${env.PATH ?? ''}`
  const r = spawnSync(cmd, { shell: true, stdio: 'inherit', env })
  if (r.status !== 0) fail(`命令失败（exit ${r.status}）：${cmd}`)
}

if (!existsSync(RAW)) fail(`未找到未签名 APK：${RAW}`)

const androidHome = process.env.ANDROID_HOME
if (!androidHome) fail('缺少 ANDROID_HOME 环境变量')

// 取最高版本的 build-tools
const btRoot = path.join(androidHome, 'build-tools')
const versions = existsSync(btRoot) ? readdirSync(btRoot) : []
const btVer = versions.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))[0]
if (!btVer) fail(`未找到 build-tools：${btRoot}`)
const bt = path.join(btRoot, btVer)

const javaBin = process.env.JAVA_HOME ? path.join(process.env.JAVA_HOME, 'bin') : ''
const keytool = path.join(
  javaBin || '',
  win ? 'keytool.exe' : 'keytool',
)
const zipalign = path.join(bt, win ? 'zipalign.exe' : 'zipalign')
const apksigner = path.join(bt, win ? 'apksigner.bat' : 'apksigner')

// 优先使用环境变量指定的发布密钥（本地与 CI 共用同一份，保证签名一致）：
//   ANDROID_KEYSTORE_PATH      密钥库路径（必填，若设置则以它为签名密钥）
//   ANDROID_KEYSTORE_PASSWORD  密钥库口令（默认 android）
//   ANDROID_KEY_PASSWORD       密钥口令（默认同密钥库口令）
//   ANDROID_KEY_ALIAS          密钥别名（默认 androiddebugkey）
// 未设置 ANDROID_KEYSTORE_PATH 时，回退到 Android 默认 debug.keystore
// （不存在则生成，与 Android Studio/AGP 默认行为一致），用于本地开发。
const KS_PATH = process.env.ANDROID_KEYSTORE_PATH
const KS_PASS = process.env.ANDROID_KEYSTORE_PASSWORD || 'android'
const KEY_ALIAS = process.env.ANDROID_KEY_ALIAS || 'androiddebugkey'
const KEY_PASS = process.env.ANDROID_KEY_PASSWORD || KS_PASS

let ks
if (KS_PATH) {
  ks = KS_PATH
  if (!existsSync(ks)) {
    fail(`指定的签名密钥不存在：${ks}（请检查 ANDROID_KEYSTORE_PATH 或 CI Secret 是否正确解码）`)
  }
} else {
  ks = path.join(homedir(), '.android', 'debug.keystore')
  if (!existsSync(ks)) {
    mkdirSync(path.dirname(ks), { recursive: true })
    run(
      `"${keytool}" -genkeypair -keystore "${ks}" -alias androiddebugkey ` +
        `-dname "CN=Android Debug,O=Android,C=US" -storepass android -keypass android ` +
        `-keyalg RSA -keysize 2048 -validity 10000`,
    )
  }
}

mkdirSync('apks', { recursive: true })
const aligned = 'apks/aligned.tmp.apk'
run(`"${zipalign}" -f 4 "${RAW}" "${aligned}"`)
rmSync(OUT, { force: true })
run(
  `"${apksigner}" sign --ks "${ks}" --ks-key-alias "${KEY_ALIAS}" ` +
    `--ks-pass pass:${KS_PASS} --key-pass pass:${KEY_PASS} ` +
    `--out "${OUT}" "${aligned}"`,
)
rmSync(aligned, { force: true })

const mb = (statSync(OUT).size / 1024 / 1024).toFixed(2)
console.log(`[sign-apk] DONE: ${OUT} (${mb} MB)`)
