/**
 * 抓取 tarkov.dev 原始 API JSON（种子数据）到 src-tauri/resources/api。
 *
 * 实际抓取逻辑在 scripts/fetch_api_data.py（保留 Python 实现，便于手工单跑）；
 * 这里只负责挑一个可用的解释器名——Windows 上是 `python`，Linux/CI 上常只有 `python3`
 * ——让 `npm run data:fetch` 在两端都能用。
 */
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)))

function resolvePython() {
  for (const exe of ['python', 'python3']) {
    if (spawnSync(`${exe} --version`, { shell: true, stdio: 'ignore' }).status === 0) return exe
  }
  return null
}

const python = resolvePython()
if (!python) {
  console.error('[data] 未找到 python / python3，无法抓取种子数据')
  process.exit(1)
}

const r = spawnSync(`${python} scripts/fetch_api_data.py`, {
  shell: true,
  stdio: 'inherit',
  cwd: ROOT,
})
process.exit(r.status ?? 1)
