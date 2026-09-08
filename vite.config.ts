import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const host = process.env.TAURI_DEV_HOST

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: 'ws', host, port: 1421 } : undefined,
    watch: { ignored: ['**/src-tauri/**'] },
  },
  build: {
    target: 'es2021',
    minify: 'esbuild',
    sourcemap: false,
    // 前端产物输出到 src-react/dist，与 tauri.conf.json 的 frontendDist 保持一致。
    outDir: 'src-react/dist',
    // 不自动清空 dist：dist/item-icons 含数千图标，逐文件删除会触发 IDE safe-delete 批量确认而中断构建。
    // 改为构建前由 scripts/clean-dist.mjs 整目录 rename+删除（已挂到 react:build / tauri:android 前置）。
    // 切勿改回 true：历史 hash 产物残留会让本地包比 CI 大几十 MB。
    emptyOutDir: false,
  },
})
