import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(fileURLToPath(import.meta.url))
const host = process.env.TAURI_DEV_HOST

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
    plugins: [react()],
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
