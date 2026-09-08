/**
 * 将 Android 配置（src-tauri/tauri.android.conf.json）的 root `version`
 * 同步为 src-tauri/Cargo.toml 的 package.version。
 *
 * 原因：Tauri 移动端构建不会自动回退到 Cargo.toml 的版本号，缺失时 APK 的
 * versionName 默认写 1.0、versionCode 默认 1。把版本写进 Android 配置后，
 * 由本脚本在每次 android 构建前从 Cargo.toml 同步，保持「版本唯一来源 = Cargo.toml」。
 *
 * 用法：node scripts/sync-android-version.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const cargoPath = resolve(root, 'src-tauri/Cargo.toml')
const androidConfPath = resolve(root, 'src-tauri/tauri.android.conf.json')

const cargo = readFileSync(cargoPath, 'utf8')
const pkgIdx = cargo.indexOf('[package]')
const pkg = pkgIdx >= 0 ? cargo.slice(pkgIdx) : cargo
const m = pkg.match(/^\s*version\s*=\s*"([^"]+)"/m)
if (!m) {
  console.error('[sync-android-version] 无法从 src-tauri/Cargo.toml 读取 package.version')
  process.exit(1)
}
const version = m[1]

const conf = JSON.parse(readFileSync(androidConfPath, 'utf8'))
if (conf.version === version) {
  console.log(`[sync-android-version] version 已是 ${version}，无需修改`)
  process.exit(0)
}

conf.version = version
writeFileSync(androidConfPath, JSON.stringify(conf, null, 2) + '\n')
console.log(`[sync-android-version] 已将 tauri.android.conf.json version 同步为 ${version}`)
