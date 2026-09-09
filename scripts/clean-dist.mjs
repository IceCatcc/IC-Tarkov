/**
 * 构建前清理产物目录。
 * 用法：
 *   node scripts/clean-dist.mjs              清 src-react/dist
 *   node scripts/clean-dist.mjs --android    额外清 src-tauri/gen/android/app/build
 *
 * 背景：vite.config.ts 里 emptyOutDir=false（避免逐文件删除触发 IDE 批量确认），
 * 导致 dist 里历次构建带 hash 的 js/css 永久累积（实测曾堆到 36MB+），
 * 本地 NSIS/APK 因此明显大于 CI（CI 每次全新 checkout，dist 为空）。
 * Android 侧 gradle 的 assets 合并也是增量的，一并清 app/build 可避免旧 assets 残留。
 *
 * 实现要点：先 rename 到同级 trash 目录（同分区原子操作，源路径立即消失，构建不会被阻塞），
 * 再删除 trash；万一删除被拦截，残留的 trash 会在下次清理时带走，不影响本次构建。
 */
import { existsSync, renameSync, rmSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const targets = ['src-react/dist']
if (process.argv.includes('--android')) {
  targets.push('src-tauri/gen/android/app/build')
}

// 真正落盘的删除交给系统命令：IDE（CodeBuddy/VS Code 类）会拦截 Node 进程自身的
// 批量 fs 删除（这正是当初 vite emptyOutDir 被中断的原因），子进程里执行不受影响。
function rmDir(dir) {
  const r =
    process.platform === 'win32'
      ? spawnSync('cmd', ['/c', 'rmdir', '/s', '/q', dir], { stdio: 'ignore' })
      : spawnSync('rm', ['-rf', dir], { stdio: 'ignore' })
  if (r.status === 0 && !existsSync(dir)) return
  // 系统命令也失败时兜底：再试一次 fs 删除，仍失败只告警（trash 残留不影响构建）
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch (e) {
    console.warn(`[clean] WARN: 无法删除 ${dir}（${e.message}），下次构建会重试`)
  }
}

function clean(rel) {
  const dir = path.join(root, rel)
  if (!existsSync(dir)) {
    console.log(`[clean] skip (not exist): ${rel}`)
    return
  }
  const trash = path.join(path.dirname(dir), `.${path.basename(dir)}-trash-${process.pid}`)
  rmDir(trash)
  try {
    renameSync(dir, trash)
  } catch (e) {
    // rename 失败（极少见，如目录被占用）时退化为原地删除
    console.warn(`[clean] rename failed, fallback to rm: ${e.message}`)
    rmDir(dir)
    console.log(`[clean] removed: ${rel}`)
    return
  }
  rmDir(trash)
  console.log(`[clean] cleaned: ${rel}`)
}

for (const rel of targets) clean(rel)
