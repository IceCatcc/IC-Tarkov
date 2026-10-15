import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { spawnSync } from 'node:child_process'
import { existsSync, renameSync, rmSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(fileURLToPath(import.meta.url))
const host = process.env.TAURI_DEV_HOST

/** lite 版要剔除的图片目录（与 src-tauri/build.rs 的 ASSET_DIRS 一致） */
const ASSET_DIRS = ['item-icons', 'trader-icons', 'boss-icons', 'maps']

/**
 * 真正落盘的删除交给系统命令：IDE 会拦截 Node 进程自身的批量 fs 删除
 * （与 scripts/clean-dist.mjs 同一套路）。先 rename 到同级 trash，再删 trash。
 */
function rmDir(dir: string): void {
  const r =
    process.platform === 'win32'
      ? spawnSync('cmd', ['/c', 'rmdir', '/s', '/q', dir], { stdio: 'ignore' })
      : spawnSync('rm', ['-rf', dir], { stdio: 'ignore' })
  if (r.status === 0 && !existsSync(dir)) return
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch (e) {
    console.warn(`[assets] WARN: 无法删除 ${dir}（${(e as Error).message}）`)
  }
}

/**
 * 无内置资源版（`IC_NO_ASSETS=1`，见 scripts/build-app.mjs --lite）：
 * 构建后把图片从产物里剔除，安装包不再带图，图片由首次启动联网下载
 * （后端见 src-tauri/src/assets.rs，前端取图见 src-react/assetUrl.ts）。
 *
 * 必须在 cargo 打包**之前**完成，因此只能挂在 Vite 构建尾上——
 * beforeBuildCommand 一跑完就进 cargo 编译，那时再删已来不及（图已在 exe/so 里）。
 */
function stripBundledAssets(): Plugin {
  let outDir = ''
  return {
    name: 'ic-tarkov-strip-bundled-assets',
    apply: 'build',
    configResolved(cfg) {
      outDir = path.resolve(cfg.root, cfg.build.outDir)
    },
    closeBundle() {
      if (!process.env.IC_NO_ASSETS) return
      let removed = 0
      for (const d of ASSET_DIRS) {
        const target = path.join(outDir, d)
        if (!existsSync(target)) continue
        // trash 放在产物目录之外：万一没删干净，也不会被打进安装包
        const trash = path.join(path.dirname(outDir), `.${d}-trash-${process.pid}`)
        rmDir(trash)
        try {
          renameSync(target, trash)
        } catch {
          rmDir(target)
          removed += 1
          continue
        }
        rmDir(trash)
        removed += 1
      }
      console.log(`[assets] IC_NO_ASSETS=1：已从产物剔除 ${removed} 个图片目录，改由首次启动下载`)
    },
  }
}

/**
 * 两套构建目标共用同一份前端源码：
 *   - 默认（`vite` / `vite build`）        → Tauri 桌面 / 移动，数据层走 invoke + 事件
 *   - `--mode web`（`vite build --mode web`）→ 服务端部署的 Web 端，数据层走 HTTP + WebSocket
 *
 * 差异全部收敛在 `@api-impl` 别名与 `__WEB_TARGET__` 常量里（见 src-react/tauri.ts、platform.ts），
 * 页面与 store 代码完全不感知平台。
 */
export default defineConfig(({ mode }) => {
  const web = mode === 'web'
  return {
    plugins: [react(), stripBundledAssets()],
    resolve: {
      alias: {
        '@api-impl': path.resolve(
          root,
          web ? 'src-react/api/web-impl.ts' : 'src-react/api/tauri-impl.ts',
        ),
      },
    },
    define: {
      __WEB_TARGET__: JSON.stringify(web),
    },
    clearScreen: false,
    server: {
      // Web 模式用 5173 + 反向代理到 Node 服务（同源 Cookie，免 CORS 配置）
      port: web ? 5173 : 1420,
      strictPort: true,
      host: host || false,
      hmr: host ? { protocol: 'ws', host, port: 1421 } : undefined,
      watch: { ignored: ['**/src-tauri/**'] },
      proxy: web
        ? {
            '/api': {
              target: process.env.API_TARGET ?? 'http://localhost:3000',
              changeOrigin: false,
              ws: true,
            },
          }
        : undefined,
    },
    build: {
      target: 'es2021',
      minify: 'esbuild',
      sourcemap: false,
      // 两个目标的产物分开，避免把 Tauri 用的 dist 覆盖掉。
      // 不自动清空 outDir：dist 下含数千图标，逐文件删除会触发 IDE safe-delete 批量确认，
      // 构建前由 scripts/clean-dist.mjs 整目录 rename + 删除（见 package.json 脚本）。
      outDir: web ? 'src-react/dist-web' : 'src-react/dist',
      emptyOutDir: false,
    },
  }
})
