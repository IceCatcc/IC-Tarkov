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
    // 不自动清空 dist：dist/item-icons 含数千图标，触发 IDE safe-delete 批量确认而中断 CI/构建。
    // 改用构建前手动删除 dist（见 build.bat / 脚本）或依赖 tauri 的 outDir 覆盖。
    emptyOutDir: false,
  },
})
