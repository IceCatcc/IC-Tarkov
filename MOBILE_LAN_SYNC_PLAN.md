# IC Tarkov 移动端（局域网同步）实施计划

> 分支：`feat/mobile-lan-sync`
> 目标：让安卓/iOS 端作为「查阅 / 规划」伴随端，通过局域网连接电脑端，实时接收监控事件并同步数据。
> 本文档面向开发者，描述架构、阶段、风险。提交规则见 `AGENTS.md`（禁止自动提交）。

---

## 1. 总体架构

```
┌──────────── 电脑端（桌面 App，已有） ────────────┐
│ 日志监控 watcher ─┐                               │
│ 截图定位 screenshots ─┤ app.emit(...) ──┐          │
│ 游戏数据 apidata     │                  ▼          │
│                      │          emit 桥接 → broadcast::channel
│                      │                  ▼          │
│                      │         本地 WS/HTTP 服务 (axum, 局域网端口)
└──────────────────────┼──────────────────┼─────────┘
                        │   quest-event / map-changed /         │
                        │   player-position / data-* (JSON)     │
                        │   ◄──── WebSocket (ws://, token 鉴权)  │
┌──────────── 手机端（移动 App，新建） ────────────┐
│ 前端原生 WebSocket 客户端（逐个 host 尝试连接）    │
│   ▼ 收到事件 → 注入 store（复用 applyEvent 等）    │
│ 移动端 Rust 后端：监控关闭，仅存连接状态 + 提供配置 │
│ UI：连接页 / 地图 / 任务图谱 / 收藏家 / 档案       │
└───────────────────────────────────────────────────┘
```

- 电脑端与手机端**共用同一套 Rust 后端 + 同一套 React 前端**。
- 手机端「远程模式」下不启动 `watcher` / `screenshots`（游戏在 PC，无日志/截图源）。
- 统一事件入口：本地 Tauri 事件 与 远程 WS 消息，在手机端前端归一为同一组 store action。
- **手机端同时也是用户数据的「随身副本」**：连接后把电脑端全部用户数据（设置 / 档案 / 收藏家 / 任务状态）拉到手机；协议对称，未来可反向把手机数据一键推到任意新电脑（见 §2.3）。

---

## 2. 设计点评估结论（已确认）

### 2.1 局域网同步方案 —— 可行
- 电脑端嵌入 `axum` + `tokio-tungstenite`，用 `tauri::async_runtime::spawn` 启动（Tauri 2 自带 tokio）。
- 事件桥接在 `setup` 用 `app.listen(...)` 订阅现有事件并转发到 `broadcast::channel`，**`watcher.rs` / `screenshots.rs` 零改动**。
- 手机端前端用浏览器原生 `WebSocket` 直连，Rust 改动最小（仅持久化连接配置）。
- 配对：电脑端枚举网卡 IP + `qrcode` crate 生成二维码；手机端逐个 host 尝试。

### 2.2 zoom 与 TLS 替换影响
- **zoom→transform**：按平台分支——桌面保留 `document.documentElement.style.zoom`（已验证），移动端改用 `transform: scale()`（需设 `transform-origin` 并固定根容器尺寸防溢出）。桌面体验零影响。
- **native-tls→rustls**：全平台统一 `rustls`（纯 Rust，移动端必须）。普通桌面用户（直连 `json.tarkov.dev`）无影响；仅企业自签/代理证书场景有差异（可接受）。

### 2.3 全量用户数据双向同步 + 反向同步（本次新增需求）
**用户数据边界**（来自 `src-tauri/src/persist.rs`）：
- `settings.json`：设置项（`logDir` / `screenshotDir` / `deleteScreenshots` / `uiScale` / `mapPrefs` / `profiles` 档案等）。
- `quest_state.json`（`Persisted`）：`quests`（任务进度）、`activity`（活动历史）、`current_map`、`unlocked`（手动解锁的前置）、`collected`（收藏家收集进度）。
- `collected.json`：收藏家（已并入 `Persisted.collected`，单独文件仅为避免「重新读取日志」清空手动记录）。
- **不跨设备同步**：`Persisted.offsets` 是 `HashMap<完整文件路径, 字节偏移>`——**key 是设备相关的绝对路径**（日志文件名可能含日期，但路径本身跨设备失效），同步时必须丢弃。导入端重置 `offsets` 为 `0`，新电脑**从 0 扫描其本地日志**即可重建偏移并得到「本地真值」。`persist.rs` 的读取逻辑本就是「读取日志 → 补充任务完成情况」，因此重新读取日志是**增量补充**而非全量重算，开销很小。

**复用现有 export/import 基础设施**：`persist.rs` 的 `save_to_path` / `load` 与前端 `exportData` / `importData` 命令已能序列化 / 还原 `Persisted`。**快照（snapshot）= `settings.json` + `Persisted{ 不含 offsets }`**，无需新序列化格式。

**同步协议（对称，双向 WS）**：
- `event` 消息：现有增量事件（`quest-event` / `map-changed` / `player-position` / `data-reloaded` 等），实时转发。
- `snapshot` 消息：携带全量用户数据 JSON。任意一端可发，另一端 `apply`（等同 `importData`：写盘 + 重载 store + 重启 watcher）。

**连接流程（V1，手机 ← 电脑）**：
1. 手机连电脑 WS → 发 `{type:"pull"}`。
2. 电脑回 `{type:"snapshot", payload}` → 手机 `apply`（等同 `importData`）。
3. 之后持续收 `event` 增量实时更新。

**反向同步（V2，手机 → 新电脑，一键）**：
1. 新电脑打开 app → 启动本地服务 → 显示二维码。
2. 手机扫码连上新电脑 → 用户点「同步到这台电脑」。
3. 手机发 `{type:"snapshot", payload: 手机当前全量数据}` → 新电脑 `apply`：`settings.json` / `quest_state.json` 写入 → 重载 store + 重启 watcher（`offsets` 重置为 0）。

**日志 ↔ 数据合并策略（通用，用户可选「覆盖 / 补充」）**：该策略同时作用于两个场景——
- **(a) 本机重新扫描日志**：现有 `reset_and_rescan`（`lib.rs:756`）目前是「覆盖」式（clear + 全量重扫）。改造为支持 `mode`：
  - `cover`（现状）：清空 store + 全量重扫 → 重置到日志真值（用于手动接取 / 完成任务后丢弃随身副本里的手动改动）。
  - `merge`（新增）：保留 `store.quests/activity/unlocked/collected`，仅清空 `offsets` 后重新 `start_watching`，把本地日志里缺失的进度补进 store（`apply_*` 幂等，重复无害）。用于漏开程序遗漏日志、或某台设备日志不全。
- **(b) 跨设备导入 snapshot**：V1 手机拉取 / V2 反向时 apply：
  - `cover`：以本地日志真值为准，apply 后由 watcher 从 `offsets=0` 重扫，本地日志进度覆盖冲突项。
  - `merge`：把手机 snapshot 中「本地日志扫描结果没有的进度」补进 store，本地已有的保留本地。
  - 跨设备导入一律**丢弃 `offsets`**（重置 0），由新电脑重扫本地日志重建；`import_data`（`lib.rs:784`）当前会带入源设备 offsets，属桌面备份导入可保留，但 snapshot 路径必须重置 0（见 P1）。
- 两种模式导入前都自动备份旧数据为 `backup_*.json`。
- 后续可升级为按 `updatedAt` 字段自动 last-write-wins（避免手动选择）。

---

## 3. 实施阶段

### P0 · 编译阻断修复（不解决无法编移动端）
1. `src-tauri/src/main.rs:1`
   将 `#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]`
   改为 `#[cfg(target_os = "windows")] #![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]`。
2. `src-tauri/src/lib.rs` `open_url` / `open_data_dir`：
   现有 `#[cfg(target_os="windows")]` + `#[cfg(not(target_os="windows"))]`（xdg-open）两分支。
   改为三分支：`windows`(explorer) / `target_os = "macos"`(open) / `mobile`(android/ios 用 `tauri-plugin-...` 或 Intent 打开 URL；「打开数据目录」移动端无对应概念，改为提示/分享)。
3. `src-tauri/Cargo.toml` + `apidata.rs:284-296`：
   `ureq` 由 `features = ["native-tls"]` 改为 `features = ["rustls"]`（或 `rustls-tls`）；
   `build_agent()` 改用 `ureq::config::Config::builder().tls_config(...)` rustls 配置，移除 `ureq::native_tls`。

### P1 · 电脑端本地服务（MVP）
4. 新增 `src-tauri/src/lan.rs`：
   - 端口可配置（默认如 `9527`，settings 可改；避免与常用端口冲突）。
   - `tauri::async_runtime::spawn` 启动 axum：
     - `GET /ws?token=<t>`：升级 WebSocket，双向通道。
     - `GET /api/snapshot`：返回全量用户数据快照（`settings.json` + `Persisted` 去掉 `offsets`），供手机端连接后首拉。新增 Tauri command `get_snapshot()` / `apply_snapshot(json)`，**直接复用** `persist.rs` 的 `save_to_path` / `load` 与现有 `importData` 逻辑，零新增序列化代码。
     - `GET /api/info`：返回本机可连接 IP 列表（枚举网卡）+ 端口 + token，供电脑端渲染二维码。
   - 全局 `broadcast::channel`；`setup` 中 `app.listen` 订阅 `quest-event`/`map-changed`/`session-mode`/`player-position`/`data-reloaded` 并 `broadcast::send`。
   - WS 客户端订阅 broadcast，收到即转发；手机端可发指令（如「刷新数据」「请求 snapshot」）。
   - token：启动时随机生成（`rand` 或 `uuid`），存入 AppState，供二维码编码。
5. 二维码：`Cargo.toml` 加 `qrcode` + `image`（或 `image` 仅生成 PNG）；新增 Tauri command `get_connect_qr()` 返回 base64 PNG 或让前端用 `qrcode` 在 JS 侧生成（推荐 JS 侧，省 Rust 依赖）。编码内容：`ictarkov://connect?hosts=192.168.1.5,192.168.0.8&port=9527&token=xxx`。
6. 电脑端「连接」页（前端）：展示二维码 + IP + 端口 + token；显示当前连接数。

### P1.5 · 桌面端重扫模式增强（覆盖/补充通用策略的本机落点）
- 改造现有 `reset_and_rescan`（`src-tauri/src/lib.rs:756`）：新增 `mode: "cover" | "merge"` 参数。
  - `cover`：现状（clear + 全量重扫，重置到日志真值）。
  - `merge`：保留 `store.quests/activity/unlocked/collected`，仅清空 `offsets` 后重新 `start_watching`，把本地日志中缺失进度补充进 store（`apply_*` 幂等，重复无害）。
- 前端设置页「重新扫描日志」按钮增加模式选择（覆盖 / 补充）。
- `apply_snapshot`（P1 第 4 点）跨设备导入时**丢弃 `offsets`（重置 0）**，避免沿用源设备路径偏移导致漏扫；`import_data`（`lib.rs:784`）作为桌面备份导入可保留 offsets（源路径不同自动从 0 重读）。

### P2 · 手机端连接与数据同步（前端）
7. 新增前端模块 `src-react/lan.ts`：
   - 解析 `ictarkov://connect?...` 或手动输入，得到 hosts/port/token。
   - 逐个 host 尝试 `new WebSocket(\`ws://${host}:${port}/ws?token=${token}\`)`，成功即停，失败试下一个。
   - 收到 JSON 消息 → 映射到 store action：`event` 类消息走 `applyEvent` / `setCurrentMapId` / `applyDetectedMode`；`snapshot` 类消息走与 `importData` 相同的前端应用路径（写 store + 刷新 UI）。连接后先发 `pull` 拉全量，再收增量。反向同步时手机作为发送方，复用同一 `snapshot` 消息。
   - 连接状态持久化（localStorage / settings），下次打开 app 自动尝试重连；重连失败仅给轻量 toast 提示「无法连接」，不阻塞，用户可重新执行扫码流程。
8. 手机端「连接」视图（未连接时显示）：**以扫码为主**（`tauri-plugin-barcode-scanner`，已确认采用），并保留手动输入 IP:端口:token 作为兜底。扫码解析出 `ictarkov://connect?...` 后自动开始连接；连接成功后进入主界面，连接配置自动保存供下次自动重连。
9. 抽象事件源：现有 `initTauri()` 的 `listen(...)` 与 WS 消息，统一调用同一组 store 更新函数，避免逻辑分叉。

### P3 · 移动端 UI 适配
10. `TopBar.tsx`：用 `@tauri-apps/plugin-os` 的 `platform()` 判断；移动端隐藏 `win.minimize()/toggleMaximize()/close()` 与 `data-tauri-drag-region`，改为移动端标题栏（含 safe-area inset）。
11. `App.tsx:68`：仅移动端用 `transform: scale()` 替代 `zoom`；桌面保持原逻辑。
12. 导航重排：顶部 5 个 nav 在移动端改为底部 Tab 或抽屉；地图/任务等页面响应式微调。
13. 视口：`100dvh` 处理移动浏览器地址栏抖动。
14. 移动端关闭监控相关 UI（设置页「监控目录」「截图目录」整块隐藏；`start_watching` 空目录分支本就不启动，无需改）。

### P4 · 配置与权限
15. `tauri.conf.json`：新增 `app.android` / `app.ios` 配置块（全屏、权限声明）；移动端窗口 label 仍为 `main`。
16. `capabilities/`：拆分 `mobile.json`（引用 `mobile-schema.json`），保留 `core:default` / `dialog:default`，移除桌面专有 `core:window:allow-start-dragging` 等（或保留 Tauri 会忽略不支持项，待实测）。
17. `security.csp`：明确放行 `connect-src ws:`、`https://api.tarkov.dev`、`https://json.tarkov.dev`（移动端建议不再用 `null`）。
18. 安卓 `AndroidManifest`：`INTERNET`（联网更新数据 + WS 客户端）、可选 `POST_NOTIFICATIONS`、相机（若用扫码）。iOS `Info.plist`：ATS 允许 `ws://` 明文（或升级 wss）、网络权限。
19. `npm run tauri android init` 生成 `src-tauri/gen/android`；配置 SDK/NDK。

> **P4 落地记录（桌面环境可做部分，已完成）**：
> - 平台配置改用 Tauri 2 官方方式：`src-tauri/tauri.android.conf.json` / `tauri.ios.conf.json`（构建对应平台时与主配置合并；主配置 `app.windows` 不含 label，移动端由平台配置提供 `label: "main"`）。CSP 在平台配置里显式放行：`connect-src 'self' ws: wss: https://api.tarkov.dev https://api.github.com`（GitHub 为前端版本检测）、`img-src` 含 asset 协议（地图/头像本地图标）、`style-src 'unsafe-inline'`（Leaflet/内联样式）。计划原写的 `app.android/app.ios` 配置块在 Tauri 2 schema 中不存在，故用平台配置文件替代。
> - `capabilities/default.json` 加 `"platforms": ["windows","macOS","linux"]`；新增 `capabilities/mobile.json`（platforms android/iOS，仅 `core:default` + `dialog:default`，无窗口控制权限）。`mobile-schema.json` 需 `tauri android init` 生成后才存在，此前仅编辑器提示，不影响构建。
> - 前端版本检测请求的是 `api.github.com`（updater.ts），CSP 已含；数据下载（json.tarkov.dev）走 Rust 端 ureq，不受 CSP 约束。
>
> **P4 遗留（需移动构建环境）**：
> - ~~`npm run tauri android init` 生成 `src-tauri/gen/android`~~ ✅ 已完成（SDK cmdline-tools + platform-tools + android-34/36 + build-tools 34/36 + NDK 27.2.12479018 已装到 `C:\Users\lsscf\AppData\Local\Android\Sdk`；JAVA_HOME 已切到 Microsoft JDK 21 `C:\Users\lsscf\java\jdk-21`——模板 Gradle 8.14 不支持 Java 25；4 个 Android Rust target 已由 init 自动安装）。
> - ~~Android 明文 `ws://`~~ ✅ 已完成：`gen/android/app/build.gradle.kts` 的 `manifestPlaceholders["usesCleartextTraffic"]` 由默认 `"false"`（仅 debug true）改为恒 `"true"`，局域网配对的明文 WS 在 release 包同样放行；`INTERNET` 权限模板自带。
> - **`.gitignore` 调整**：`gen/android` 工程文件入库（含上述定制），仅忽略 `gen/schemas`、`gen/android` 的 build 产物 / `.gradle` / `local.properties` / `.idea`。
> - ~~iOS `gen/ios/.../Info.plist`：ATS 例外~~ 已取消（iOS 不在范围内）。
> - `tauri-plugin-barcode-scanner` 插件接入与 capabilities 追加（届时移动端连接页补扫码按钮）。
> - 环境变量（用户级已持久化）：`ANDROID_HOME` / `NDK_HOME` / `JAVA_HOME`。新开终端生效；首次 `tauri android build` 时 Gradle 还需联网下载依赖。

### P5 · 实测调优
20. 桌面 ↔ 安卓真机局域网联调；iOS 模拟器联调。
21. 低端安卓地图页（Leaflet）性能；WS 重连与电量。

---

## 4. 风险与待确认

| 风险 | 说明 | 应对 |
|------|------|------|
| Windows 防火墙 | 电脑端服务端口可能被拦 | 首次启动提示用户放行；文档说明；端口可配置 |
| 端口占用 | 默认端口被占 | 启动时若占用则顺序试探下一个端口 |
| 多网卡 / 多 IP | 二维码含多个 host，手机逐个尝试 | 已实现 hosts 列表 + 逐个重试 |
| iOS ATS | 已确认用 `ws://` 明文（本地局域网） | Info.plist 配置 `NSAllowsArbitraryLoads`（开发期）或仅对局域网 IP 例外放行 `ws://`；Android 明文 ws 默认允许 |
| 企业自签证书 | rustls 不信任系统证书 | 已知限制，普通用户无影响 |
| 扫码权限 | 相机权限 + 插件体积 | 提供「手动输入 IP」兜底，扫码可选 |
| 双向控制范围 | 手机端是否反控电脑（手动改任务状态） | 待确认；WS 已预留指令通道，可后续扩展 |
| 电量 | WS 长连 + 地图页 | 移动端不启动截图轮询线程；WS 心跳保活即可 |
| 数据冲突 | 覆盖可能丢手动改动 / 补充可能留旧进度 | 导入时用户选「覆盖」或「补充」；两种均自动备份 `backup_*.json`；后续可按 updatedAt last-write-wins |

**待确认决策**：
- [x] **iOS 不在范围内**：仅做 Android（`tauri.ios.conf.json` 不创建、Info.plist ATS 例外不做、iOS 联调取消），文档中 iOS 相关条目保留仅作存档。
- [x] 手机端连接以**扫码为主**（`tauri-plugin-barcode-scanner`），手动输入 IP 兜底。
- [x] 传输用 **`ws://` 明文**（本地局域网，不引证书）；iOS 侧配 ATS 例外。
- [x] 反向同步（手机 → 新电脑一键）纳入 **V2**（协议从 V1 起对称预留，V2 仅补 UI 按钮）。
- [x] 导入合并策略：用户可选 **覆盖 / 补充** 两种模式（覆盖=重置到日志真值；补充=把手机增量补进本地）；两种均自动备份 `backup_*.json`。

---

## 5. 兼容性回顾（来自前期评估）

可复用（基本零改动）：全部 `#[tauri::command]`、事件机制、`data_root()` 的 `app_config_dir` fallback、任务图谱/档案/收藏家页、地图页（Leaflet 纯前端）。

需改：编译阻断 3 处（P0）、窗口/拖拽/UI 缩放（P3）、监控功能在移动端关闭（P2/P3 语义）。

功能语义：移动端不做「实时监控器」，定位为「查阅/规划 + 局域网实时跟随」。

---

## 6. 提交与发布

- 按 `AGENTS.md`：完成并验收后由用户明确指示再 `git commit`（用 `git-helper` skill），**不自动 push**。
- 版本号提升在 `src-tauri/Cargo.toml`；移动端发布流程另议（CI 需加 android/iOS 构建矩阵）。
