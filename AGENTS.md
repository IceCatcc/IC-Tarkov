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

- 浮层层级：`SettingsModal` 为 `z-[2000]`，帮助窗口 `z-[1200]`，「关于」弹窗 `z-[1300]`，版本/更新窗口 `z-[1500]`；帮助与关于从设置页打开时分别抬到 `z-[2100]` / `z-[2200]`（`HelpModal` / `AboutModal` 的 `z` prop）。
- **帮助与关于入口**：两者都在设置页左下角（帮助另有首次启动自动弹出这一入口）。帮助窗口内**不再**放「关于」按钮；「去设置」按钮仅在首次启动引导时显示（由 `onGoSettings` 是否传入决定）。
- **浮层互斥**：首次启动时若帮助窗口正在展示，缺日志目录的「打开设置」要挂起到帮助关闭后再执行，避免设置盖住帮助（见 `src-react/App.tsx` 的 `pendingOpenSettings`）。
- 顶部栏（`src-react/components/TopBar.tsx`）右侧依次是：错误提示、（电脑端）「连接」状态按钮、「⚙ 设置」按钮、窗口控制按钮。**不再**有 `?` 帮助按钮。
- **「收藏家」页签默认隐藏**：由任务视图（`QuestGraphPage` 工具栏，两个子视图下都显示）的「收藏家追踪」开关控制，开启后顶栏导航与移动端底部 Tab 才出现「收藏家」页签。开关存 `store.collectorTrack`（随 `graphPrefs` 持久化：localStorage + settings.json 的 `uiPrefs.graphPrefs.collectorTrack`，局域网/Web 同步沿用同一路径；旧偏好无该字段时按 `false` 处理）。关闭时若正停留在收藏家页（手动关闭、或从设置/同步恢复出关闭态），由 `App.tsx` 的 effect 踢回监控页，避免出现没有页签可点的死角。
- 窗口为无边框自定义标题栏，中部空白区域带 `data-tauri-drag-region` 可拖动。
- **移动端不自动弹连接窗口**：启动只做已保存连接的自动重连（`startLanAutoConnect`），未保存过配置时不弹 `LanConnectModal`（首次启动弹窗会打断使用），入口是顶部栏常驻的「连接 / 连接中 / 已连接」按钮（见 `TopBar.tsx`）。
- **地图「钥匙锁」的名称**：上游 `locks` 只有 `lockType` + `key`（钥匙物品 id），没有名称字段，`dataset::build_markers` 用 `item_name`（`zh_items` 的 `{id} Name`）把钥匙中文名填进 `name` / `nameZh`，前端据此把「同一把钥匙的几扇门」归为一组；同时下发 `keyName`（钥匙 id）与 `lockType`（door / trunk / container / switch）。
- **钥匙「使用位置」与跳地图定位**：物品页的钥匙详情按 `keyName` 扫全部地图的 `locks`，列出「地图 · 锁类型（同地图同类型多处时带 `序号/总数`）」；点击把 `{map, x, z}` 写进 store 的 `mapFocus` 信号（`src-react/store.ts`），`MapPage` 消费它切到该地图并 `setView` 居中到坐标后清空信号。两个易错点：① MapPage 里 keepAlive 的视图复位 effect（切回地图页 `fitBounds`）**带 `mapFocus` 时必须跳过**，否则会把刚定位到的视图拉回整张地图；② 首次从别的页面跳进来时地图骨架还没加载，`selectable` 为空，**不能据此判定「地图不存在」并清掉信号**（否则跳转彻底失效），要等 `skeleton` 到位后再判定。
- **跳转定位与目标「选中」**：跳转定位（物品页钥匙「使用位置」）后，`MapPage` 把目标处的锁「选出来」：直接把该子项**写进 `mapChips`**（`setMapChip(subKey('locks:<钥匙名>'), true)`，即使原先或用户显式关掉了「钥匙锁」分类 / 这一子项也强制勾上；分类因此显示为三态的「部分选中」，该子项显示为勾选，并随 uiPrefs 持久化）、`openPopup()` 打开弹窗（`autoPan: false`，避免再把视图挪走）、并给图标 `<img>` 加 `.map-lock-focus`（放大发光 2s；**标记元素自身的 transform 被 Leaflet 用来定位，动效只能加在内层 img 上**）。因为等不到下一次 render 的 `syncAll`，勾选的同时就地更新 `chipsRef.current` 再同步一次图层，才能在同一次 effect 里拿到标记元素并弹窗。落点提示**不再用扩散波纹**（`pulseAt` / `.map-pulse` 已删除，跳转与玩家位置刷新都不再用），只靠「自动勾选 + 弹窗 + 图标放大发光」。
- **物品口径**：上游 `properties.caliber` 带 `Caliber` 前缀（如 `Caliber9x19mm`），`dataset::item_props` 统一剥掉前缀再下发（`ItemInfo.caliber`）。物品页的「口径」筛选不是按类别写死的，而是从**当前分类里带 `caliber` 的物品**派生——弹药、武器、弹匣都有该属性，且各类别的口径字符串一致（同一口径枚举），因此能互相对应；无口径的类别（医疗等）不显示这一行。口径很多，默认收起成一行（`CALIBER_LIMIT`），可展开全部。
- **工具页**：`src-react/pages/ToolsPage.tsx` 是「工具卡片列表 ↔ 工具界面」两态容器（点卡片进入，左上角 ← 返回列表），新工具在 `TOOLS` 里加一项并在 `renderTool` 里注册组件。页面走 keepAlive（`App.tsx` 的 `toolsAlive`，只切 `display`）；**打开过的工具也在 ToolsPage 内部常驻挂载**（`opened` 数组 + `display` 切换，返回列表不销毁），因此搜索 / 筛选 / 滚动位置都能保留。
  - **「物品」页签已移除，物品图鉴改为工具页里的 `items` 工具**：`Page` 类型（`store.ts`）与 `TopBar.tsx` 的 `NAV_ITEMS` 都不再有 `items`（桌面导航与移动端底部 Tab 同源，一处即两端）。`ItemsPage` 新增 `embedded` 参数——内嵌时只隐藏自己的 `<h1>物品</h1>` 与多余的顶部留白，**保留自身滚动区**，所以工具定义里带 `full: true`（`ToolDef.full`）：这种工具的外层容器是 `h-full`，不再套 `px-4 pb-4` 的滚动壳，否则会出现双层滚动、内层 `h-full` 被压扁。从物品页外跳（任务详情 / 钥匙「使用位置」→ 地图）仍是 `setPage('graph' | 'map')`，返回时落在工具页签的图鉴界面（`active` 未持久化，重启回到工具列表）。
- **配方查询**：工具 `craft` 在 `src-react/components/CraftTool.tsx`，数据来自命令 `get_crafts`（`dataset::CraftInfo`）：
  - 上游三份数据：`regular/crafts`（材料/产物 id + 数量、station id、level、duration、`attributes.tool`、`requiredQuestItems`）、`regular/hideout`（station id → 文案 key，如 `hideout_area_13_name`）、`regular/hideout_zh`（文案 key → 中文设施名）。三处端点清单（`apidata.rs` / `scripts/fetch_api_data.py` / `server/src/data/endpoints.ts`）已同步；老数据包缺文件时 `Store.crafts` 为空，页面提示先更新数据。
  - **价格实时查询走 json.tarkov.dev 的单件价格历史端点**：`src-react/fleaPrices.ts` 请求 `https://json.tarkov.dev/regular/prices/{itemId}`（端点目录见 `https://json.tarkov.dev/endpoints`），取最后一个数据点（`price` 为该次刷新的均价，`priceMin` 为最低价），约每 2 小时刷新一个点；单件 gzip 后约 20KB，并发上限 6，内存缓存 10 分钟，点「刷新价格」强制忽略缓存。
  - **不要用 tarkov.dev GraphQL**：官方已不维护（`api.tarkov.dev/graphql` 实测返回 `422 {"errors":["GraphQL server unavailable. Try again later."]}`），本项目从创建起只用 json.tarkov.dev 静态端点；`json.tarkov.dev` 也没有「批量当前价」端点（`items` 是 17MB 全量），所以按物品逐个查价格历史是当前唯一轻量方案。
  - **必须降级**：个别物品请求失败只影响该物品（用数据集里的同步价补齐并在状态行提示「n 项未取到」）；全部失败（断网 / Cloudflare 拦截）才整块退回数据集价格并提示「实时价格接口暂不可用，当前为 xx 同步的价格」，同时给一个「更新游戏数据」入口（复用 `refreshGameData()`，带 ETag）。`json.tarkov.dev` 的响应带 `Access-Control-Allow-Origin: *`，前端直接 fetch 可用（桌面与 Web 共用同一份实现，不需要 `_apiParity` 两套）。
  - 成本口径：`attributes.tool` 的工具材料**不消耗、不计入成本**；`requiredQuestItems` 标记为「任务」材料照常计费（可能买不到）。有材料缺跳蚤价时成本视为不完整，利润 / 时薪显示「—」并提示。
  - 上游未本地化的物品（新道具 / 任务物品）中文名会退化成 24 位 id，前端 `displayName()` 统一转成「未知物品（前 8 位…）」占位。
  - Web 分支：`/api/crafts` 读派生文档 `crafts.json`（`server/src/data/derive.ts`），但 `rebuild()` 尚未移植，当前返回空数组。
- **工具「显示器滤镜」**（`src-react/components/DisplayFilterTool.tsx` + `src-tauri/src/display.rs`，仅电脑端）：
  - 原理是改**显卡 gamma 查找表**（GDI `SetDeviceGammaRamp`，3×256 的 16bit LUT），不是给画面叠加后处理，因此全屏独占（DirectX）游戏同样生效、无性能开销、不碰游戏文件。曲线顺序为「对比度（绕 0.5 拉伸）→ 亮度（线性缩放）→ Gamma（幂 1/γ）」，三步单调 + 末段夹到 [0,1] 保证整表单调递增（驱动要求）。
  - FFI 只声明 `gdi32`/`user32` 的 `CreateDCW`（driver=`DISPLAY`、device=`\\.\DISPLAYn`）/`DeleteDC`/`SetDeviceGammaRamp`/`GetDeviceGammaRamp`/`EnumDisplayDevicesW`/`EnumDisplaySettingsW`，**没有引入 windows crate**（与项目零额外依赖的风格一致）。`DisplayDeviceW`/`DevModeW` 均为手写 `#[repr(C)]`，尺寸须为 840 / 220 字节（改结构体后要重新核对）。
  - 命令：`list_displays` / `get_display_filter` / `save_display_filter`（只落盘）/ `apply_display_filter` / `reset_display_filter`（`displayId` 省略=还原全部）/ `is_elevated` / `relaunch_as_admin`。**只注册在桌面端 `invoke_handler`**；手机端不编译该模块，web 端在 `web-impl.ts` 里返回空列表 / 抛「不支持」。
  - 状态存档 `<数据根>/display-filter.json`（`enabled` / `lockedRgb` / `selected` / 每台显示器参数 / `presets`），不走 settings.json 的 uiPrefs——因为后端启动时要直接读它复现滤镜（`display::restore_on_startup`，gamma 表不跨重启 / 驱动重置保留）。**内置预设已移除**（原「恢复默认 / 亮度+40 / +60 / +100」）：`FilterState::default()` 的 `presets` 为空，`load_state()` 会用 `is_builtin_preset()` 按「名称 + 参数都吻合」清掉老存档里的这四项，用户自建方案原样保留。方案可绑定全局快捷键（`hotkey: {vk, ctrl, alt, shift, label}`，VK 码由前端 `KeyboardEvent.code` 换算）。
  - **所有修改只作用于选中的那一台显示器**：滑块 / 数值框 / 方案「套用」都只对当前选中项（前端 `pushParams` 只传 `[selectedId]`），没有「应用到所有显示器」的批量操作（只剩「重置当前 / 重置全部」作为兜底，总开关关闭也会还原全部）。选中项存 `FilterState.selected`，前端 `selectDisplay` 立即落盘；`apply_display_filter` 也接受 `selected` 参数——因为它会把整份状态写回磁盘，若只用存档里的旧值会把刚切的选中项覆盖掉，随后快捷键就会作用错屏。
  - **全局快捷键在后台线程里注册**：`RegisterHotKey(NULL, …)` 把 `WM_HOTKEY` 投递到**调用线程**的消息队列，所以 `display.rs::hotkeys` 起一个常驻线程自己持有队列，用 `PeekMessageW(WM_HOTKEY, WM_HOTKEY)` 非阻塞取消息（`MSG` 手写 `#[repr(C)]`，64 位下必须 48 字节）；配置变更走 mpsc，`recv_timeout(20ms)` 兼作轮询，改动不重新注册（`fingerprint()` 按 vk+修饰键去重，滑块调参触发的落盘不会打断已注册的热键）。只在 `state.enabled` 时注册，关闭 / 注销即全部 `UnregisterHotKey`。命中后**只把该方案应用到 `state.selected` 那一台**（没有记录或该屏已拔掉时退回主显示器，再不行退回第一台）、落盘、`emit("display-filter-changed", {state, preset, display})` 让界面同步并提示作用到了哪块屏。
  - **提权**：热键由系统转发，游戏以管理员身份运行时未提权的进程收不到 `WM_HOTKEY`（UIPI 拦截），所以界面在未提权时给「以管理员身份重启」按钮（`relaunch_as_admin` = `ShellExecuteW("runas")` + `app.exit(0)`；`is_elevated` 用 `shell32!IsUserAnAdmin`）。这两处都在 `display.rs` 手写 extern，没引入额外 crate。
  - **提权重启不能弹控制台**：debug 构建是控制台子系统（`main.rs` 只在 release 加 `windows_subsystem = "windows"`），`ShellExecuteW("runas")` 会给它分配一个黑框并把 `eprintln!` 打在里面。做法是给新进程传标记参数 `--elevated`（`ELEVATED_ARG`），`lib.rs::run()` 第一行调 `display::hide_console_if_relaunched()` 用 `ShowWindow(GetConsoleWindow(), SW_HIDE)` 隐藏。**不要改用 `FreeConsole`**：释放控制台后 stdout 句柄失效，之后任何 `println!` 都会 panic（stderr 的 `eprintln!` 才吞错）。
  - 界面：**总开关关闭时收起下面三块设置**（显示器 / 调节参数 / 配置方案与快捷键），只留顶部开关卡 + 一张「滤镜已关闭」说明卡，避免在未生效状态下调参数；内容整体 `mx-auto max-w-[920px]` 居中。
  - 界面：显示器单选卡片（主屏标记、分辨率、生效指示）、5 条通道色滑块（`.df-range` 在 `index.css`，轨道按 `--df-fill` 填充）、数值框（聚焦编辑、失焦提交）、方案列表（套用 / 删除 / 按键框绑定快捷键：点一下进入捕获，Esc 取消、Delete 解除，同一组合自动从其它方案摘除）、重置当前 / 重置全部（**没有「应用到全部」**）。拖动滑块下发防抖 90ms、落盘防抖 600ms；重置前必须 `cancelTimers()`，否则挂起的落盘会在还原后把旧参数写回、下次启动又复活滤镜。
- **地图「开关 / 拉杆」的中文**：上游 `switches` 的 `name` 是内部 id（如 `switch_00409_power`），`zh_maps` 把它映射成英文可读名（如 `Med Elevator Power Button`）而非中文；`dataset::SWITCH_ZH` 是按该英文名手工维护的中文表（当前 32 条、覆盖全部开关），`switch_zh()` 在 `build_markers` 里套用，查不到就保留英文。新增/改名开关时需要同步这张表。
- **工具「战局 Boss 监控」**（`src-react/components/BossMonitorTool.tsx` + `src-tauri/src/boss.rs`，仅电脑端；参考 seongjin-lab/tarkov-boss 的日志思路）：
  - 数据来自本机游戏日志，**增量读取**（`Runtime.offsets` + 半行 `tails`，每秒轮询一次；会话目录按 mtime 取最新，不按目录名排序——小时可能是一位数）。文件按名字包含 `application` / `aiData` / `backend` 分类（日志名可能带时间戳前缀，不能用 starts_with）。
  - 事件口径：`application` 的 `MatchingCompleted:`（战局边界，**只在「当前没有有效战局」时开新局**：`raid.map` 为空或上一局 `ended`，否则只当作「已进图」；早期按「5s 内不重置」判断，两行间隔超过 5s 就会把刚识别的战局清空，正是「进图容易漏」的成因，换局一律交给 RaidId 变化判定）与 `RaidId:...,Locations:...`（地图链取**最后一个**非空段，与 `parser.rs` 一致；`RE_RAID` 匹配不到时用 `RE_LOCATION` 只取地图链兜底）；`aiData` 的 `Init Boss wave:<role> ShallSpawn:(True|False) BossChance:n`（生成判定）、`Bot activate ... role:... pos:(...)`（实际激活）、`Group set boss. ... groupName:... bossType:...`（刷新区域）、`bot dispose:<id>` + `BotDied`（死亡配对）；`backend` 的 `client/match/local/end`（战局结束）。**「预计刷新」与「已刷新」必须分开**，才能区分「本局不刷」与「刷了但还没激活」。
  - **护卫统计与存活口径（全部来自日志，不用数据集）**：本局护卫数取 `SpawnWave   BornZone:<zone>, ShallSpawn:True, EscortCount:N, BossType:<role>, EscortType:<follower>`（`ShallSpawn:False` 的行不是本局实际刷的，忽略；同一 Boss 多条取 max）；护卫类型即 `EscortType`。存活数改用 `[checklist] [AllAlivePotentialEnemiesPlayers] ... allAlivePlayersList: 15:bossBully, 26:followerBully, ...`（每只 AI 决策时都会打，实测一趟 8 MB 日志里有 5000+ 条）：按 role 重新计数，**比 `bot dispose` + `BotDied` 配对准得多**（实测 dispose 55 次、BotDied 只有 28 次，配对会漏死亡）。只有「曾出现在名单里」的角色才允许按缺席判 0（`Runtime.seen_in_list`），否则没刷的 Boss 会被误清零。快照里每个 Boss 带 `escortType` / `escortTotal` / `escortAlive`（`snapshot()` 里按 escort_type 汇总 alive），前端只在 Boss 已刷新 / 已死亡时显示 `存活/总数`（如 `2/4`）。`SpawnWave BornZone` 同时用作 `zone` 缺失时的兜底。
  - **多文件按时间归并**：一次轮询里各文件的新行不能按文件顺序直接投递（否则回放时本会话所有战局的 AI 行都算到最后一次战局头上），`replay_in_order` 按行首时间戳分块归并后再投递，最后留下的就是「最近一次进图记录」（先开游戏、程序后开也能立刻显示）。
  - **兜底检查**（`fallback_entry_check`，每 3s 且 application 日志签名变化时才跑）：不依赖增量偏移，直接从最新 application 日志**尾部**（2MB 一块、最多回看 16MB）取最后一条 `Locations` / `MatchingCompleted` 行。只有行时间晚于 `last_entry_ts`（已处理过的进图行时间，单调）才采纳，所以重复执行既不重复也不回退到上一局，也不会清掉 `ended`；覆盖日志轮转、程序打开太晚、会话目录被换等情况。工具页「当前战局」右上角 **`重新扫描`** = `boss_get_state({ force: true })`，清掉偏移从会话开头完整回放，作为手动兜底。
  - Boss 名/刷新概率不在后端拼：后端只给 role（= tarkov.dev 的 mob id），前端用 `get_map_bosses` 的 `maps[nn]` 合并；`bossKnight` 的判定行会展开成 `followerBigPipe` / `followerBirdEye`（日志只为 Knight 写一条）。
  - **BTR**：`shooterBTR` 走同一套判定，另记 `OnReadyToDeparture(BtrReadyToDepartureEvent)`（发车准备，该行常无时间戳，用当前时间兜底）与 `Service PlayerTaxi has already been purchased!`（购车）。BTR 不在 `map-bosses` 数据里，所以界面单独一块显示，且只在森林 / 街区 / 灯塔或真有日志信号时出现。
  - 拉取地图中文名用 `dataset::store().skeleton` 的 `nameZh`（`map_zh()`），取不到退化 nn。
  - `Logging.config`（游戏安装目录，与 `EscapeFromTarkov.exe` 同级）：一键修改只把 `rules[].fileName == "aiData"` 的 `minLevel` 改成 `Trace`（先校验 JSON，再用正则只替换该值，保留原格式与其它规则）。**AI 数据的原始级别固定是 `Error`（`ORIGINAL_AI_LEVEL`），「恢复」就是把该值写回，不记录原值、不生成 `.bak` 备份**；为了不误伤手动设置，只有当前级别仍是 `Trace` 时才自动还原，否则报错让用户自行确认（参考实现 tarkov-boss 也拒绝自动恢复已被外部改动的配置）。**修改后需重启游戏生效**。
  - **开关与日志配置联动**：`boss_set_enabled(true)` 会顺手 `apply_logging_inner`（aiData → Trace），`false` 时 `restore_logging_inner`（→ Error）。两者都是 best-effort（找不到配置 / 没写权限时**不阻断开关**，前端在切换后重新拉 `boss_logging_status` 并按 `patched` 给出警告），配置卡里的两个按钮仍保留用于手动补做。目录定位顺序：存档里的 `configPath` → `gameRoot`（含向上 4 层）→ 日志目录向上 6 层 → 各固定盘常见安装路径；找不到就让用户选游戏目录。
  - 存档 `<数据根>/boss-monitor.json`（`enabled` / `notify` / `cleanAi` / `gameRoot` / `configPath`）；命令 `boss_get_state`（可选 `force`，见上）/ `boss_set_enabled` / `boss_set_notify` / `boss_set_clean` / `boss_logging_status` / `boss_set_game_root` / `boss_apply_logging` / `boss_restore_logging`，**只注册桌面端**，web 端 `web-impl.ts` 给空状态 / 抛不支持，手机端界面直接提示仅电脑端可用。
  - **自动清理 AI 日志**（`BossSettings.clean_ai` + `maybe_clean_ai`）：每轮 `poll` 解析完之后，若当前会话里 `aiData` 日志超过 `CLEAN_LIMIT`（16 MB）就 `set_len(0)` 截断，**只动 aiData，application / backend 一字不动**；截断后把该文件偏移归零、丢掉半行 `tails`。游戏以「追加 + 写共享」方式打开日志，所以运行中通常也能清；被独占锁住时 open 失败 → 只写 `cleanNote` 提示并下一轮重试，不阻断监控。快照里带 `cleanAi` / `cleanNote`（后者不随 `reset_scan` 清空），界面在开关行下方显示。`read_new_lines` 会抹掉 NUL，防止非追加写入留下的空洞污染解析。
  - 快照变化才 `emit("boss-monitor")`（比对时不带 `updatedAt`，否则每秒都会发）。监听在 `tauri-impl.ts` 的 `initTauri` 里，收到的快照**写进 store 的 `boss`**（工具页与地图页共用同一份，不要各自再 invoke + listen）；通知按「会话 + RaidId + 地图」去重并**跳过每局首个快照**（开启监控时会回放当前局的已有日志，不能补弹一堆历史通知）；只提示本图 Boss 表里有的 role，以及 BTR 的出发准备信号。
  - **地图页「Boss 刷新率」面板与监控联动**（`MapPage.tsx` 的 `bossChanceStyle` / `bossStatusTag`）：按 role 匹配 `store.boss`，百分比文字颜色表示状态 —— 已刷新绿 / 预计刷新琥珀 / 本局不刷灰 / 已确认死亡暗红 / 未检测淡灰；未开启监控时保持原来的琥珀色。**不能只靠颜色**：每行名字旁另有状态小标签（预计刷新 / 已刷新 / 已死亡 / 本局不刷）。百分比口径：优先日志里的 `BossChance`（本局**实际刷新率**，0~100），日志还没判定时退回 tarkov.dev 上游 `spawnChance`（0~1，**来源 wiki**），tooltip 明确标注当前是哪种。
  - **「在地图上标注 Boss 状态」开关**（`store.bossMarkers`，随 `mapPrefs.bossMarkers` 持久化，默认关）：**开关在工具页「战局 Boss 监控」顶部卡片里**（与「刷新通知 / 自动清理 AI 日志」同一行的 `ToggleChip` 开关片），地图页只读结果、不再放开关。勾上后 `MapPage` 用独立 `bossLayerRef` 图层把日志坐标画成 Boss 头像（`bossImage(role)`，缺失用 `?` 占位；`.map-boss-live` 在 `map.css`，死亡态淡显），图标下方带 `.map-boss-live-tag` 文字小标签（已刷新 / 已死亡）——**不能只用颜色区分状态**。**角色必须是真 Boss 或 BTR**（`bossImages.ts` 的 `isBossRole`：`boss` 前缀 + 例外表 `NON_PREFIX_BOSSES`（邪教徒祭司 `sectantPriest`、黑色守望 `blackDivision`）；`shooterBTR` 单独放行，用蓝色 `BTR` 字样标记），日志里的 `pmcBEAR` / `pmcUSEC` / `assault` / `marksman` / `follower*` 等普通 AI 一律不画；工具页的「日志里出现但不在本表」列表用同一个 `isBossRole` 过滤（BTR 有独立状态卡）。新增不带 `boss` 前缀的 Boss 时记得补进 `NON_PREFIX_BOSSES`。只画状态为 `confirmed` / `dead` 且**有坐标**的条目（`预计刷新` 还没坐标），并且要求 `store.boss.map === imap.key` 且坐标落在 `imap.bounds` 内，避免跨图错位。坐标口径与截图定位一致：日志 `pos:(x, y, z)` 取 x/z → `L.latLng(z, x)`（`logPosLatLng`）。该图层不受图标分类筛选影响，但要在 `markers` 重建地图后重画（依赖里带 `markers`）。
  - **全局通知改为底部居中**（`components/Toasts.tsx`）：`bottom-4`，移动端用 `max-md:bottom-[calc(var(--nav-h)+env(safe-area-inset-bottom)+12px)]` 避开底部导航；入场动画自下上滑（`index.css` 的 `toast-in`）。
  - 界面顶部常驻**风险警告「未知是否会造成封号影响」**（开启监控前还会 `confirm` 一次）：功能只读日志 + 改日志级别，但不保证反作弊不会判定，这行提示不要删。
- **互斥任务（多选一）失败判定**：上游 `failConditions` 里 `type=taskStatus` + `status` 含 `complete` 表示「那个任务完成时本任务失败」（如海关的化学品-4 / 大客户 / 出于好奇三选一）。`dataset` 解析为 `QuestNode.fail_on_done` 并反推 `Store.fail_map`，`data::failed_quests(completed)` 算出失败集合，`get_player_quests` / `set_quest_status` 返回 `status:"failed"`（自身已完成时以完成为准）。前端 `QuestStatus` 增 `'failed'`：地图只画 `in_progress`（失败任务自动不再出现），监控页/任务板/图谱显示「已失败」。日志检测到完成任务后 `applyEvent` 会补拉一次任务列表刷新该派生状态。
- **任务目标可单独勾选**：目标 id 取上游 objective id（`dataset::Objective.id` → `ObjectiveInfo.id`，缺失时兜底 `任务id#序号`）。打勾进度按任务模式存在 `quest_state.{mode}.json` 的 `QuestEntry.objectivesDone`，读写命令 `get_objectives_done` / `set_objective_status`（后者落盘后 emit `objective-changed`，已在 `lan.rs` 的事件转发列表与手机端反向同步里）。勾选只是玩家自己记进度，**不改变任务的接取/完成状态**；任务「手动重置」时清空该任务的目标打勾。三处目标列表（监控页卡片 / 任务板卡片 / 任务链详情面板）统一用 `src-react/components/ObjectiveChecklist.tsx`，状态经 `useObjectivesDone` 缓存（切模式时清空）。地图页点击任务目标图标的 Leaflet 弹窗也能勾选：它是静态 HTML，走 `data-obj-check="任务id|目标id"` + 地图容器的事件委托，勾选后就地改 DOM（不走重绘），所需进度由 `ensureObjectivesDone` 预取。**同一任务里坐标相同的多个目标（如「找到」+「标记」）会合并成一个图标**（图标只标任务名，弹窗里逐条列出目标描述、各自可勾选），图标的半透明要求组内目标全部勾选。已勾选的目标在地图上图标转半透明（`.quest-obj-marker.is-done`，由 `refreshObjectiveMarkers` 就地改 class，不重建图层以免弹窗被关掉）。另外 `dataset::push_zone_dedup` 会按「地图+坐标」给目标的 zone 点去重：上游 `zones` 里常有完全重合的重复点（如「这是什么梗」在工厂的放置点），不去重会画出两个重叠图标（典型案例：目标的 zone 带 factory4_day / factory4_night 两份副本，`NN_MERGE` 后 nn 都是 `factory`，且两份副本坐标可能有微小出入——所以去重优先按上游 zone id（`zid`），无 id 才退回按坐标）。前端 `MapPage` 绘制时再按「任务id+目标id+坐标」兜底去重一次，这样旧数据集或未重建时也不会重影。（只有目标打勾、既未接取也未完成的任务条目不进入玩家任务列表，避免打勾把未接取任务顶到列表/地图上。）
- **地图「图标」筛选**：分类 / 子分类由 `src-react/mapIconGroups.ts` 从当前地图数据派生（不写死清单），每个子分类一个独立 Leaflet 图层、可单独开关；开关键为 `cat:<分类>` / `sub:<分类>:<子分类>`，存于 `uiPrefs.mapPrefs.chips`，旧版扁平键（`extract_pmc` 等）在 `migrateChips` 里一次性迁移；「任务目标」的子项即进行中的任务，沿用 `untrackedQuests`。默认显隐见 `ICON_DEFAULTS`（未显式设置的子项继承所属分类）。
- **地图底图：有 SVG 线稿就不用卫星图**（`MapPage`，用户偏好线稿）：
  - 主层：数据里同时给了 `svgPath` 与 `tilePath` 时**只加载 SVG**；`tilePath` 仅在**没有** `svgPath` 的地图上用（实验室 / 破冰船 / 迷宫）；
  - **底图地址必须经 `assetUrl()` 归一化**（`MapPage.tsx`）：骨架数据里 `svgPath` 是站内相对路径（`maps/svg/Customs.svg`，需要补 `/`），而 `tilePath` 是 **assets.tarkov.dev 的绝对 URL**（`https://assets.tarkov.dev/maps/labs_v4/1st/{z}/{x}/{y}.png`）。统一加 `/` 会得到 `/https://…`，直接 404 —— 表现就是「有线稿的地图正常、只有瓦片的地图整片空白」；
  - 楼层：该层在 SVG 里有对应线稿组（`layers[].svgLayer` 且该 `id` 确实存在于 SVG 里）就只用线稿——主层线稿**压暗 20%** 作底（`applySvgLayer(id, true, false)`，CSS 的 `.off-level g.base-layer`）、选中层全亮，不加载该层瓦片；没有线稿组的楼层（海关 4 楼、储备站 2~5 楼，上游没给线稿）才用瓦片，此时整张线稿隐藏（`hideBase=true` / `svgRoot.style.display='none'`）；
  - 瓦片图层**懒创建**（切到该层才建），线稿可用时移除已建瓦片，避免「SVG 尚未加载完成时先按瓦片处理」留下的卫星图残留；
  - SVG 取不到时（文件缺失，`fetch` 非 2xx 显式抛错）**回退瓦片**，不让地图空着；SVG 异步加载完成后按 `floorSelRef.current` 复位当前楼层（不能直接 `showSvgMain()`，会把用户已选的楼层顶掉）。
- **地图「游戏时间」显示**：组件 `src-react/components/GameClock.tsx`，**固定显示在地图页右上角**（常驻徽标，不随「地图信息」面板收起；原先放在右下角面板里，已移出，面板的 `title` 也不再提游戏时间）。**纯本地计算，不依赖任何后端接口**（历史上基于 tarkov.dev `time` 接口的版本已因长期无数据被移除）：`游戏秒 = (UTC 秒 × 7 + 3h) % 86400`，现实 1 秒 = 游戏 7 秒，故以 `1000/7 ≈ 143ms` 定时刷新让游戏秒逐秒跳动。UI 是右上角两行的小徽标：上行「游戏时间」（11px 淡灰），下行为两个时间用 ` / ` 隔开（`g1 / g2`，同一字号同一颜色，**不分主次、不做强调**），无按钮、无弹窗、不显示 UTC。地图页 keepAlive 隐藏（`display:none`）时按 store 的 `page` 停表，切回立即刷新一次。
- **地图页浮窗排布**：左上角一行依次是「任务 → 地图选单（双列）→ 层级 → 聚焦 → BTR」；右上角只有游戏时间徽标。层级 / 聚焦原在右上角，为给时钟让位已并入左上角一行（`items-start`，各自的展开面板 `left-0` 向左对齐）。层级外层带 `z-[620]`，高于右下角「地图信息」浮窗（`z-600`），否则展开的楼层选单会被它盖住。
- **BTR 路线跟踪**：数据在 `public/data/btr-routes.json`（路线轨迹 + 到站时序，坐标已按 tarkov.dev 底图线性校准；来源与误差写在文件内 `source` 字段），推算逻辑在 `src-react/btr.ts`（`btrSnapshot`，时间轴统一为「战局剩余秒数」，与上游 `raidDuration` 一致），面板 `src-react/components/BtrPanel.tsx`，仅森林 / 街区 / 灯塔显示（`btrKeyOf`）。
  - **数据生成必须保证 `schedule.pathIndex` 与 `path` 点列一一对应**。参考站有两套几何：`map.routes[].path`（官方采样，索引指向它）与 `manualGeometry.routes`（手工路径，坐标可与游戏坐标对齐，但点数/圈数不同）。直接拿手工路径套官方索引会让到站瞬间跳变（森林 R5 曾出现「先正常移动、然后突然跳到 USEC 检查点」）。当前做法：森林按站点锚点把手索引映射到手工路径（站点误差 0m）；街区 / 灯塔的手工路径圈数不全，改用站点样本拟合的仿射变换直接转换官方采样点（残差约 6 / 18m）。生成脚本在 `quest_analysis/btr_gen.cjs`（该目录被 gitignore），改数据后务必跑一遍并检查输出的 `worstStopGap`。
  - **计时基准**来自后端 `raid-changed` 事件（`store::RaidState`，全局且不落盘）：进图（`RaidId` / `Locations:` 行）置 `active=true` 并记录 `startedAt`，出图（`CompleteSelectedProfile` 行）置 `false` 并记录 `endedAt`；同一张图连打两局时 `map-changed` 不 emit，但 `raid-changed` 每次都发，否则第二局没有计时基准。转场到新图同样重置计时（新战局）。
  - **进程退出兜底**：崩溃 / 强退写不出出图行，watcher 的 3 秒轮询在 `raid.active` 时用 `tasklist` 检查 `EscapeFromTarkov.exe`，进程不在则结束战局（`endedAt` 取检测时刻，最多晚 3 秒）。
  - **交互**：出图后倒计时冻结在出图时刻；面板提供「继续追踪 / 暂停 / 复位」、参考站同款快捷时间点（战局剩余 35:00 / 30:00 / … / 01:00）与自定义剩余时间。路线每局随机，默认把所有候选路线都画在地图上（颜色区分、点车辆或筛选可只看一条），无需先确定路线。
  - **收起 ≠ 停止**：`MapPage` 用 `btrArmed`（已启用跟踪）与 `btrOpen`（面板展开）两个状态区分——面板的 × 只把 `btrOpen` 置 false，`BtrPanel` 仍然挂载（`visible` 传 false 时返回 null），计时、手动跳转状态与地图图层都不中断；只有面板里的「停止」按钮才清 `btrArmed` 并移除图层。BTR 图层 effect 依赖 `btrArmed` 而不是 `btrOpen`。
  - **「精简日志」必须保留 `RaidId` 与 `CompleteSelectedProfile` 行**，否则精简后 BTR 会失去计时基准与出图信号。web 端没有日志监控，`getRaidState` 返回 `null`，BTR 退化为手动开始 / 手动跳时间。
- **启动：资料读取与界面进程分离 + 「读取中 xx」提示**。`setup` 只做轻量初始化（装配 `AppState`、同步载入体量很小的三套任务进度、局域网服务），最耗时的游戏数据集构建（约 17MB 原始 JSON 的解析与派生索引重建）放到后台线程（`src-tauri/src/lib.rs::load_in_background`），进度写入 `src-tauri/src/startup.rs::StartupTracker`，经 `startup-step` 事件与 `get_startup_state` 命令下发；数据集构建的各子阶段（读各文件 / 建索引）通过 `dataset::*_with(progress)` 回调上报同一步骤键，前端就地更新文案而不新增行。前端 `src-react/boot.ts` 把后端步骤与自身步骤（读取界面设置 / 扫描日志 / 加载任务列表）汇成一条时间线，由 `StartupSplash`（`z-[3000]`，见 `src-react/components/StartupSplash.tsx`）渲染遮罩。**约定：`bootReady()` resolve 之前不得调用依赖数据集的命令**（任务/地图/物品），否则会读到空数据集；`bootReady` 用「事件 + 轮询」双保险并带 120s 兜底，后端异常也不会把界面卡在遮罩上。另外 `start_watching` / `reset_and_rescan` 声明为 async：非 async 命令跑在 Tauri 主线程，全量日志扫描会把界面冻住。
- **日志监控只看任务 + 「精简日志」**：重扫（`reset_and_rescan`）与启动首扫（`emit=false`）不再解析「进入地图」事件（`watcher.rs` 里 `RawEvent::Location` 在 `!emit` 时直接跳过），当前地图只由实时事件（notify / 3 秒轮询，`emit=true`）决定；覆盖重扫也不再清空 `current_map`（清了就补不回来）。另设「精简日志」入口（设置页数据操作区，命令 `simplify_logs` → `parser::simplify_logs_in_place`）：**就地覆盖** `Logs` 下的 `.log` 原文件，删掉与任务无关的行（进入地图 `Locations:` / `RaidId`、资源加载等），只保留任务通知多行 JSON 块（整块原样保留，写回后仍可被 `parse_chunk` 解析）、`Session mode:` 行与 `client/quest/` 请求；mtime 在 60 秒内的文件视为游戏仍在写，跳过不动。`simplify_logs` 在 `api/tauri-impl.ts` 与 `api/web-impl.ts`（抛「不支持」）都已实现，勿漏。

## 其他

- **移动端原生定制点**：`src-tauri/gen/android` 已入库并含手工改动（见 `app/src/main/java/com/icecat/ictarkov/MainActivity.kt`：edge-to-edge insets、横屏隐藏状态栏、屏幕常亮 `setKeepScreenOn`），另有 `app/proguard-rules.pro` 里为该方法加的 keep 规则（release 开 R8，不加会因反射失败报 `NoSuchMethodError`）。重跑 `tauri android init` 会覆盖工程文件，改前先备份这几处。
- **屏幕常亮**：开关持久化在 settings.json 的 `keepScreenOn`（默认 true），Android 生效路径为 `src-tauri/src/keepawake.rs` 经 `WebviewWindow::with_webview` + `jni_handle().exec` 反射调用 MainActivity 方法；iOS 无原生工程、桌面端无对应能力，均只持久化不生效，UI 用 `isAndroid()` 控制开关显隐。
- **角色档案已移除**：等级 / 商人忠诚等级（loyalty）/ 地图解锁（lockedMaps）不再维护，档案页、`settings.json` 的 `profile` / `profiles` 字段、`save_settings` 的 `profile` 参数、`profile-changed` 事件与 `set-profile` 反向同步指令、同步摘要里的 `level` 均已删除。任务图谱 / 任务板 / 收藏家页里原本的「当前 Lv / 当前 LL + ✓✗ 达标」对照一并降级为只显示任务自带的要求值（要求值来自任务数据，保留）。旧 `settings.json` / 旧快照里残留的 `profile` / `profiles` 会被 serde 忽略（未知字段不报错），无需迁移；新旧版本混用做局域网同步时摘要指纹会不同，会触发一次「两端不一致」确认。
- `quest_analysis/` 目录已被 `.gitignore` 忽略，README 与提交中均不涉及。
- 本项目为 Vibe Coding 项目（深度使用 AI 编程），README 与软件内「帮助窗口 → 关于」均已声明。

## Web 分支（服务器部署）

`web` 分支把桌面端迁移为「Node.js + MySQL 服务端 + 浏览器前端」，数据按用户账号隔离。
**本节只描述 web 分支；上面的桌面端约定在 web 分支上仅作参考，不再作为主构建路径。**

> 一句话架构：**同一份 React 源码，两套数据层**。页面 / store 完全不感知平台，
> 差异收敛在 `src-react/api/` 与打包期别名里。

### 目录与职责

```
IC-Tarkov/
├── server/                    # 新增：Node.js + Fastify + MySQL 服务端
│   ├── sql/                   # 迁移脚本（按文件名排序，一次性执行并记录）
│   ├── src/
│   │   ├── index.ts           # 启动入口（连库 → 迁移 → 加载数据 → 监听）
│   │   ├── app.ts             # Fastify 组装（Cookie / CORS / WS / 静态前端 / 鉴权）
│   │   ├── config.ts          # 环境变量集中处
│   │   ├── db.ts              # 连接池与 query / execute / tx 封装
│   │   ├── migrate.ts         # 迁移执行器
│   │   ├── auth/              # 注册登录、会话、口令哈希（Node 内置 scrypt）
│   │   ├── repo/userData.ts   # 按 (user_id, mode) 隔离的用户数据访问层
│   │   ├── routes/            # progress / game / settings / data / ws 路由
│   │   ├── data/              # 游戏数据：endpoints / store（原始缓存）/ derive / questIndex
│   │   └── realtime/hub.ts    # WebSocket 按用户广播（替代 Tauri emit）
│   └── Dockerfile
├── src-react/                 # 复用：前端
│   ├── api/tauri-impl.ts      # 数据层实现 A：Tauri invoke + 事件
│   ├── api/web-impl.ts        # 数据层实现 B：HTTP + WebSocket
│   ├── api/shell.ts           # 外壳能力：窗口控制 / 版本号 / 监听事件（web 端空实现）
│   └── tauri.ts               # 唯一入口：`export * from '@api-impl'`
└── docker-compose.yml         # MySQL + 服务端一键部署
```

### 关键约束（web 分支）

- **数据层必须成对实现**：新增任何数据访问函数，`api/tauri-impl.ts` 与 `api/web-impl.ts` 都要加。
  `web-impl.ts` 末尾有一处编译期校验（`_apiParity`），缺函数或签名不符会在 `tsc` 时报错。
- **入口与别名**：页面一律 `import ... from '../tauri'`；实现由 `vite.config.ts` 的 `@api-impl` 别名选择。
  `tsconfig.json` 的 `paths` 指向 tauri 实现（供类型检查），因此 `web-impl.ts` 自身也要能被 `tsc` 覆盖到。
- **两套构建产物分开**：`src-react/dist`（Tauri）/ `src-react/dist-web`（Web），
  `clean-dist.mjs --web` 只清后者，互不覆盖。
- **平台判断用 `isWeb()`**（打包期常量 `__WEB_TARGET__`），不要用 UA —— 桌面壳里跑的是同一套代码。
  需要区分「浏览器 / Tauri」的地方：窗口控制按钮、局域网「连接」按钮、刷新与右键屏蔽、LAN 自动重连。
- **shell 能力集中在 `api/shell.ts`**：禁止在组件里直接 `import { getCurrentWindow } from '@tauri-apps/api/window'`
  （`getCurrentWindow()` 在浏览器里模块加载期就会抛错）。版本号取不到时返回空串，顶部栏据此隐藏版本标签。
- **服务端不做本机能力**：日志监控、截图定位、数据目录迁移、局域网同步在 web 端不存在，
  对应函数是空实现或抛「当前环境不支持」。局域网同步的职责由「同一账号多端实时同步」取代。
- **时间格式**：DB 读出的 DATETIME 一律以 `YYYY-MM-DD HH:mm:ss` 字符串往返（连接池 `dateStrings: true`），
  与桌面端日志时间戳格式保持一致，前端无需适配。
- **模式（pvp / pvps / pve）**：所有用户数据表都以 `(user_id, mode)` 为主键前缀；
  接口的 `mode` 参数缺省时取该用户 `user_settings.view_mode`。

### 常用命令（web 分支）

```powershell
# 前端
npm run web:dev              # Web 前端开发服务器（5173，/api 反向代理到 3000）
npm run web:build            # 类型检查 + 构建到 src-react/dist-web
npm run web:build:fast       # 跳过 tsc

# 服务端（首次需先 cd server; npm install）
npm run server:dev           # tsx watch
npm run server:migrate       # 只建表 / 升级结构
npm run server:build         # tsc → server/dist
npm run server:start         # node dist/index.js

# 一键部署
docker compose up -d --build # 需先 npm run web:build
```

服务端配置见 `server/.env.example`（复制为 `server/.env`）。本地无 MySQL 时可用
`docker compose up -d mysql` 只起数据库，再 `npm run server:dev`。

### 账号与数据导入

- **登录门禁**：`src-react/components/AuthGate.tsx`，由 `App.tsx` 在 `isWeb()` 且未登录时整屏接管；
  未登录期间**不发起任何业务请求**（否则会 401），启动链（`bootReady` 之后的那段）也一并跳过。
- **账号接口**：`src-react/api/web-account.ts`（Web 专属，**不**放进 `tauri.ts` 的统一数据层，
  否则会破坏 `web-impl.ts` 的一致性校验）。
- **数据导入**：`POST /api/import`（multipart，字段 `file` + `mode=replace|merge`），
  解析在 `server/src/import/parse.ts`，落库在 `server/src/repo/importData.ts`，UI 为 `ImportPanel.tsx`
  （首次登录且账号为空时由 AuthGate 引导，另有顶部栏「导入数据」按钮）。
  - 支持桌面端导出的 zip（`quest_state.{mode}.json` / `collected.{mode}.json` / `settings.json`），
    也支持单个 JSON 文件；无文件名的裸 JSON 按内容猜归属。
  - **命名易错点**：`ModeData` 在 Rust 侧**没有** `rename_all`，字段是 snake_case（`current_map`、
    `offsets`）；而 `QuestEntry` / `ActivityRow` 是 camelCase（`acceptedAt`、`objectivesDone`、`questId`）。
    解析器两种都容忍，改动时别只按一种写。
  - 导入后经 `hub.emit(userId, 'data-imported')` 通知同账号其它设备整批重取。

### 待办（按优先级）

1. **移植 `src-tauri/src/dataset.rs` → `server/src/data/derive.ts`**（当前为空实现）。
   这是唯一的功能性缺口：没有它，任务 / 地图 / 物品 / 标记接口都会返回空数据
   （`GET /api/data/status` 的 `derivedReady` 为 false）。
   落地形态：读取 `DATA_DIR/tarkov-api/*.json`，产出 `DATA_DIR/derived/*.json` 后 `derived.load()`。
   产出清单与逐项要点见 `derive.ts` 末尾的注释。`maps-skeleton.json` 已可直接服务（无需派生）。
   备选方案（若不愿重写 1600 行派生逻辑）：把 dataset.rs 抽成独立 Rust CLI 侧车，只负责产出这些 JSON。
2. 设置页适配：日志目录 / 截图目录 / 数据目录迁移 / 局域网同步等桌面专属项在 web 端隐藏
   （目前这些控件仍会渲染，web 端点了不生效）。
3. 数据导出（web 端改为服务端生成 zip 下载），与导入形成闭环。
4. 任务进度录入方式（见下方「开放决策」）。
5. 安全加固：注册/登录接口限流、改密后强制其它会话失效已做但未覆盖「导出/导入」的频次限制。

### 开放决策

**桌面端最核心的「实时监控游戏日志」在 Web 上无法直接实现** —— 服务端读不到玩家本机的
`Logs/*.log`。目前已确定的部分：手动接取 / 完成 / 重置、目标打勾、收藏家勾选全部可用；
尚未决定的是「自动跟踪」这一能力怎么补：

- 方案 A（改动最小）：web 端只做手动维护，砍掉自动跟踪。
- 方案 B（推荐）：新增「日志上报」入口 —— 用户在 PC 上选一次日志目录，由一个小工具
  （或浏览器 File System Access API 轮询）把 `Logs` 增量推到服务端，服务端复用
  `src-tauri/src/parser.rs` 的解析逻辑（需移植为 TS）写库并广播 `quest-event`。
  这样能保住「实时监控」的核心体验，且多端天然同步。
- 方案 C：只支持手动上传日志文件，服务端离线解析一次（无实时性，但实现最简单）。

实时通道（WebSocket + `hub.emit`）与 `applyDetectedEvent` 入库函数已就位，
方案 B / C 落地时直接调用即可，无需改动前端事件层。
