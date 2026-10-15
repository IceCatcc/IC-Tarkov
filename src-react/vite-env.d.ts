/// <reference types="vite/client" />

/**
 * 打包期注入的平台常量（见 vite.config.ts 的 define）：
 * true = Web 构建（服务端部署），false = Tauri 桌面 / 移动构建。
 */
declare const __WEB_TARGET__: boolean
