# AGENTS.md

本项目（IC Tarkov）的 AI 协作约定与常用操作流程。修改代码前请务必先读本文件。

> **文档分工**：`README.md` 面向最终用户与普通贡献者，只介绍项目、运行与构建方式；面向 AI / 内部维护的说明（约束、发布细节、提交规则、行为约定等）只维护在本文件，README 不重复、不承载此类细节，避免两份文档漂移。

## 项目概览

《逃离塔科夫》任务与地图助手，Tauri 2 + React + TypeScript 桌面应用。

- **前端**：`src-react/`（React 18 + Vite + Tailwind，构建产物 `src-react/dist/`）
- **后端**：`src-tauri/`（Rust，构建产物 `src-tauri/target/release/`，Tauri 默认目录）
- **数据**：游戏数据来自 tarkov.dev 开放接口；中文 Wiki 来自 eftarkov.com

> 注意：前端目录名为 `src-react`，**不是** `src`。

## 常用命令

```powershell
npm run react:dev     # 前端开发服务器（端口 1420）
npm run react:build   # 类型检查 + 前端生产构建 → src-react/dist
npm run tauri:dev     # Tauri 壳开发模式
npm run tauri:build   # 构建桌面应用（仅 NSIS 安装包）

.\start-dev.bat       # 仅配置 MSVC 环境后保持命令行（不自动启动应用）
.\build.bat           # 发布构建（恒 release，拒绝 --debug，输出带版本号 exe）
```

### 快速迭代（跳过不必要步骤）

默认 `npm run tauri:build` 会连带跑 `tsc && vite build`（拷贝 `public/` 下近千个 webp）和 NSIS 打包，
改 Rust 时这些都是纯浪费。按需选用 `package.json` 里的快捷脚本：

```powershell
npm run rust:check          # 只做 Rust 类型/借用检查，最快
npm run rust:build          # 只编 Rust release（跳过前端构建与 NSIS）；产物 src-tauri/target/release/ic-tarkov.exe
npm run react:build:fast    # 跳过 tsc，只 vite build
npm run tauri:build:nobundle # 完整构建但跳过 NSIS 打包
```

> `rust:check` / `rust:build` 在 Windows 需先由 `.\start-dev.bat`（或任何已配置 vcvars 的终端）提供 MSVC 链接器环境。

### 关键约束

- **前端产物目录**：`vite.config.ts` 里 `build.outDir = 'src-react/dist'`，必须与 `tauri.conf.json` 的 `frontendDist: "../src-react/dist"` 保持一致。二者不符会导致 `Unable to find your web assets` 错误。
- **构建前必须清空 `src-react/dist`**：`vite.config.ts` 里 `emptyOutDir: false`，dist 会永久累积历次构建带 hash 的 js/css（曾堆到 36MB+），本地 NSIS/APK 因此明显大于 CI（CI 每次全新 checkout，dist 为空）。`react:build` / `react:build:fast` / `tauri:android` 已前置 `scripts/clean-dist.mjs`，不要去掉这步；Android 侧它同时清 `gen/android/app/build`（gradle 增量合并 assets 也会残留旧资源）。该脚本用「rename 到 trash + 系统命令删除」实现，避免 Node 的批量 fs 删除被 IDE safe-delete 拦截。
- **不要自定义 Rust target 目录**：曾尝试用 `.cargo/config.toml` 的 `target-dir` 把产物重定向到项目根 `target/`，未生效且造成两处产物，已回退。保持 Tauri 默认 `src-tauri/target`。
- **构建环境**：Windows 上需 MSVC 链接器。`.bat` 脚本负责配置，CI 的 `windows-latest` 自带。
- **release 构建特性**：`Cargo.toml` 中 `[profile.release]` 开了 `strip + LTO`，编译较慢但可缩小体积、降低杀软误报。分发必须用 release，不要用 debug 产物。

## 发布流程

采用「本地维护说明文件 + 打 tag 触发 CI」方式。

1. **更新 `RELEASE_NOTES.md`**：写入本次版本的更新内容（Markdown）。这是 GitHub Release 的说明正文。
2. **提升版本号**：修改 `src-tauri/Cargo.toml` 的 `package.version`（版本唯一来源）。`tauri.conf.json` 与 `package.json` 均不写 `version`，Tauri 构建/运行时自动回退读 Cargo.toml。改后跑一次 `cargo check`（或 `.\check-tauri.bat`）让 `Cargo.lock` 同步。CI 的 tag/Release 名由 `release.yml` 显式从 Cargo.toml 提取，不依赖 conf。
3. **提交并打 tag**：

```powershell
git add RELEASE_NOTES.md
git commit -m "docs: 更新发布说明"
git tag v<version>    # <version> 必须与 Cargo.toml 的 package.version 一致
git push origin main
git push origin v<version>
```

4. **CI 自动完成**：`.github/workflows/release.yml` 在 `windows-latest` 构建 NSIS 包，创建 GitHub Release，说明取自 `RELEASE_NOTES.md`。

> - 若 `RELEASE_NOTES.md` 缺失或为空，Release 仍会创建，仅说明为空。
> - workflow 里 `generateReleaseNotes: false`，Release 说明不会自动生成 commit 列表。
> - Windows runner 按 2 倍分钟计费，且 LTO 编译慢，只在打 tag 或手动触发时运行。

## Git 提交规则

- **禁止自动提交**。代码改动必须等用户明确指示「提交 / commit」后才能提交。
- 提交时使用 `git-helper` skill。
- 提交后**不要 push**，除非用户明确要求。
- 禁止 `--force` / `--hard` / `--amend` 等危险操作。

### 提交 message 写法

- 格式：`<type>(<scope>): <description>`，type 取 `feat` / `fix` / `refactor` / `chore` / `docs` / `style` / `perf` / `ci`
- 首行不超过 72 字符，简体中文或英文均可
- 多行正文用 `- ` 列出要点
- **Windows 上提交中文 message 的坑**：`git commit -m` 直接带中文多行正文常因 cmd 引号/转义被拆成 pathspec 而失败。可靠做法是先把 message 写入 `.git/COMMIT_MSG_TMP.txt`，再用 `git commit -F .git/COMMIT_MSG_TMP.txt --cleanup=strip` 提交，最后删除该临时文件。另外 commit message 中避免出现 `../`，git 可能误判为路径。

## 版本检测

- 逻辑在 `src-react/updater.ts`，请求 GitHub Releases API（`IceCatcc/IC-Tarkov`）获取最新 release。
- **任何失败（断网、非 200、结构异常）一律静默返回 `null`，不做任何提示**。新增相关代码时务必保持这一行为。
- 绿点只在 `isNewer(latest, current)` 为真时显示；当前版本为空（开发环境）时不提示。
- 即使已是最新版本，点击版本标签仍展示最新 release 的说明。

## UI 约定

- 浮层层级：`SettingsModal` 为 `z-[2000]`，帮助窗口 `z-[1200]`，「关于」弹窗 `z-[1300]`，版本/更新窗口 `z-[1500]`。
- **浮层互斥**：首次启动时若帮助窗口正在展示，缺日志目录的「打开设置」要挂起到帮助关闭后再执行，避免设置盖住帮助（见 `src-react/App.tsx` 的 `pendingOpenSettings`）。
- 顶部栏（`src-react/components/TopBar.tsx`）右侧依次是：错误提示、「⚙ 设置」按钮、纯文字 `?` 帮助按钮、窗口控制按钮。
- 窗口为无边框自定义标题栏，中部空白区域带 `data-tauri-drag-region` 可拖动。
- **移动端不自动弹连接窗口**：启动只做已保存连接的自动重连（`startLanAutoConnect`），未保存过配置时不弹 `LanConnectModal`（首次启动弹窗会打断使用），入口是顶部栏常驻的「连接 / 连接中 / 已连接」按钮（见 `TopBar.tsx`）。

## 其他

- **移动端原生定制点**：`src-tauri/gen/android` 已入库并含手工改动（见 `app/src/main/java/com/icecat/ictarkov/MainActivity.kt`：edge-to-edge insets、横屏隐藏状态栏、屏幕常亮 `setKeepScreenOn`），另有 `app/proguard-rules.pro` 里为该方法加的 keep 规则（release 开 R8，不加会因反射失败报 `NoSuchMethodError`）。重跑 `tauri android init` 会覆盖工程文件，改前先备份这几处。
- **屏幕常亮**：开关持久化在 settings.json 的 `keepScreenOn`（默认 true），Android 生效路径为 `src-tauri/src/keepawake.rs` 经 `WebviewWindow::with_webview` + `jni_handle().exec` 反射调用 MainActivity 方法；iOS 无原生工程、桌面端无对应能力，均只持久化不生效，UI 用 `isAndroid()` 控制开关显隐。
- `quest_analysis/` 目录已被 `.gitignore` 忽略，README 与提交中均不涉及。
- 本项目为 Vibe Coding 项目（深度使用 AI 编程），README 与软件内「帮助窗口 → 关于」均已声明。
