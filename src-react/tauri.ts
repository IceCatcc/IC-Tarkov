/**
 * 数据层入口（唯一入口）。
 *
 * 具体实现由构建目标决定，业务代码只认这个模块：
 *   - 桌面 / 移动（Tauri）：`api/tauri-impl.ts`，走 Tauri invoke + 事件
 *   - Web（nodejs 服务端）：`api/web-impl.ts`，走 HTTP + WebSocket
 *
 * 切换发生在打包期（vite.config.ts 的 `@api-impl` 别名，随 `--mode web` 变化），
 * 因此不会把两套实现同时打进产物。
 */
export * from '@api-impl'
