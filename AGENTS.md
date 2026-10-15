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
- **地图「开关 / 拉杆」的中文**：上游 `switches` 的 `name` 是内部 id（如 `switch_00409_power`），`zh_maps` 把它映射成英文可读名（如 `Med Elevator Power Button`）而非中文；`dataset::SWITCH_ZH` 是按该英文名手工维护的中文表（当前 32 条、覆盖全部开关），`switch_zh()` 在 `build_markers` 里套用，查不到就保留英文。新增/改名开关时需要同步这张表。
- **互斥任务（多选一）失败判定**：上游 `failConditions` 里 `type=taskStatus` + `status` 含 `complete` 表示「那个任务完成时本任务失败」（如海关的化学品-4 / 大客户 / 出于好奇三选一）。`dataset` 解析为 `QuestNode.fail_on_done` 并反推 `Store.fail_map`，`data::failed_quests(completed)` 算出失败集合，`get_player_quests` / `set_quest_status` 返回 `status:"failed"`（自身已完成时以完成为准）。前端 `QuestStatus` 增 `'failed'`：地图只画 `in_progress`（失败任务自动不再出现），监控页/任务板/图谱显示「已失败」。日志检测到完成任务后 `applyEvent` 会补拉一次任务列表刷新该派生状态。
- **任务目标可单独勾选**：目标 id 取上游 objective id（`dataset::Objective.id` → `ObjectiveInfo.id`，缺失时兜底 `任务id#序号`）。打勾进度按任务模式存在 `quest_state.{mode}.json` 的 `QuestEntry.objectivesDone`，读写命令 `get_objectives_done` / `set_objective_status`（后者落盘后 emit `objective-changed`，已在 `lan.rs` 的事件转发列表与手机端反向同步里）。勾选只是玩家自己记进度，**不改变任务的接取/完成状态**；任务「手动重置」时清空该任务的目标打勾。三处目标列表（监控页卡片 / 任务板卡片 / 任务链详情面板）统一用 `src-react/components/ObjectiveChecklist.tsx`，状态经 `useObjectivesDone` 缓存（切模式时清空）。地图页点击任务目标图标的 Leaflet 弹窗也能勾选：它是静态 HTML，走 `data-obj-check="任务id|目标id"` + 地图容器的事件委托，勾选后就地改 DOM（不走重绘），所需进度由 `ensureObjectivesDone` 预取。**同一任务里坐标相同的多个目标（如「找到」+「标记」）会合并成一个图标**（图标只标任务名，弹窗里逐条列出目标描述、各自可勾选），图标的半透明要求组内目标全部勾选。已勾选的目标在地图上图标转半透明（`.quest-obj-marker.is-done`，由 `refreshObjectiveMarkers` 就地改 class，不重建图层以免弹窗被关掉）。另外 `dataset::push_zone_dedup` 会按「地图+坐标」给目标的 zone 点去重：上游 `zones` 里常有完全重合的重复点（如「这是什么梗」在工厂的放置点），不去重会画出两个重叠图标（典型案例：目标的 zone 带 factory4_day / factory4_night 两份副本，`NN_MERGE` 后 nn 都是 `factory`，且两份副本坐标可能有微小出入——所以去重优先按上游 zone id（`zid`），无 id 才退回按坐标）。前端 `MapPage` 绘制时再按「任务id+目标id+坐标」兜底去重一次，这样旧数据集或未重建时也不会重影。（只有目标打勾、既未接取也未完成的任务条目不进入玩家任务列表，避免打勾把未接取任务顶到列表/地图上。）
- **地图「图标」筛选**：分类 / 子分类由 `src-react/mapIconGroups.ts` 从当前地图数据派生（不写死清单），每个子分类一个独立 Leaflet 图层、可单独开关；开关键为 `cat:<分类>` / `sub:<分类>:<子分类>`，存于 `uiPrefs.mapPrefs.chips`，旧版扁平键（`extract_pmc` 等）在 `migrateChips` 里一次性迁移；「任务目标」的子项即进行中的任务，沿用 `untrackedQuests`。默认显隐见 `ICON_DEFAULTS`（未显式设置的子项继承所属分类）。
- **地图「游戏时间」显示**：组件 `src-react/components/GameClock.tsx`，并入地图页右下角「地图信息」面板（Boss 刷新率上方）。**纯本地计算，不依赖任何后端接口**（历史上基于 tarkov.dev `time` 接口的版本已因长期无数据被移除）：`游戏秒 = (UTC 秒 × 7 + 3h) % 86400`，另有一套 `+12h` 的对侧时间；现实 1 秒 = 游戏 7 秒，故以 `1000/7 ≈ 143ms` 定时刷新让游戏秒逐秒跳动。UI 上只保留一个「游戏时间」标签（第二行即 +12h 时间，不带标签），无按钮、无弹窗、不显示 UTC。地图页 keepAlive 隐藏（`display:none`）时按 store 的 `page` 停表，切回立即刷新一次；面板收起时组件卸载，定时器随之清理。
- **启动：资料读取与界面进程分离 + 「读取中 xx」提示**。`setup` 只做轻量初始化（装配 `AppState`、同步载入体量很小的三套任务进度、局域网服务），最耗时的游戏数据集构建（约 17MB 原始 JSON 的解析与派生索引重建）放到后台线程（`src-tauri/src/lib.rs::load_in_background`），进度写入 `src-tauri/src/startup.rs::StartupTracker`，经 `startup-step` 事件与 `get_startup_state` 命令下发；数据集构建的各子阶段（读各文件 / 建索引）通过 `dataset::*_with(progress)` 回调上报同一步骤键，前端就地更新文案而不新增行。前端 `src-react/boot.ts` 把后端步骤与自身步骤（读取界面设置 / 扫描日志 / 加载任务列表）汇成一条时间线，由 `StartupSplash`（`z-[3000]`，见 `src-react/components/StartupSplash.tsx`）渲染遮罩。**约定：`bootReady()` resolve 之前不得调用依赖数据集的命令**（任务/地图/物品），否则会读到空数据集；`bootReady` 用「事件 + 轮询」双保险并带 120s 兜底，后端异常也不会把界面卡在遮罩上。另外 `start_watching` / `reset_and_rescan` 声明为 async：非 async 命令跑在 Tauri 主线程，全量日志扫描会把界面冻住。
- **日志监控只看任务 + 「精简日志」**：重扫（`reset_and_rescan`）与启动首扫（`emit=false`）不再解析「进入地图」事件（`watcher.rs` 里 `RawEvent::Location` 在 `!emit` 时直接跳过），当前地图只由实时事件（notify / 3 秒轮询，`emit=true`）决定；覆盖重扫也不再清空 `current_map`（清了就补不回来）。另设「精简日志」入口（设置页数据操作区，命令 `simplify_logs` → `parser::simplify_logs_in_place`）：**就地覆盖** `Logs` 下的 `.log` 原文件，删掉与任务无关的行（进入地图 `Locations:` / `RaidId`、资源加载等），只保留任务通知多行 JSON 块（整块原样保留，写回后仍可被 `parse_chunk` 解析）、`Session mode:` 行与 `client/quest/` 请求；mtime 在 60 秒内的文件视为游戏仍在写，跳过不动。`simplify_logs` 在 `api/tauri-impl.ts` 与 `api/web-impl.ts`（抛「不支持」）都已实现，勿漏。

- **图片资源（物品图标 / 商人头像 / Boss 图 / 地图底图 / 地图标记 / 瓦片）可在线更新**：
  - 后端 `src-tauri/src/assets.rs` 把图片缓存到 `<data_root>/tarkov-assets/`，布局与前端 `public/` 下**完全一致**（`item-icons/<物品id>.webp`、`trader-icons/<商人id>.webp`、`boss-icons/*`、`maps/svg/*.svg`、`maps/interactive/*.png`、`maps/tiles/<地图>/<z>/<x>/<y>.png`），随 `apidata` 的「更新数据」一并同步（共用 `data-sync-progress` / `data-synced` 事件与设置页进度）。
  - 两类来源：物品图标与商人头像按 id 直连 `assets.tarkov.dev`（数千张，非强制更新**只补本地缺失的**，不做逐张条件请求）；地图底图 / 地图标记 / Boss 图 / 瓦片走项目**自有资源包**（`{IC_ASSETS_BASE}/assets-manifest.json` 里的 `hash` 与本地一致就跳过整包，否则下载 `assets.zip` 解包覆盖）。默认基址是本仓库 Release 的 `assets` 标签，用 `npm run assets:pack` 生成这两个文件；自建服务用环境变量 `IC_ASSETS_BASE` 覆盖。自有清单不可达时**静默跳过**（不报错、不影响 JSON 数据更新）。
  - 前端一律经 `src-react/assetUrl.ts` 的 `assetUrl()` / `assetUrlTemplate()` 取图，**不要再写 `/item-icons/...` 这类硬编码路径**：运行时目录里有就用 Tauri `asset:` 协议（`protocol-asset` feature + `tauri.conf.json` 的 `assetProtocol.enable`，`setup` 里 `allow_directory` 放行资源目录；Android CSP 需允许 `asset:` / `http://asset.localhost`），没有就回退随包路径 —— 离线可用与在线更新因此并存。启动时 `refreshAssets()` 取一次索引（`get_asset_index`），`data-synced` 后再刷一次。
  - 「随包已带的图片」由 `build.rs` 扫描 `public/{item-icons,trader-icons,boss-icons,maps}` 生成 `bundled_assets.rs`（`IC_NO_ASSETS=1` 时为空），图标类据此跳过已随包的图，完整版因此几乎不用下载。
  - **lite 版**（`--lite` → `IC_NO_SEED=1 IC_NO_ASSETS=1`）：`build.rs` 不内嵌种子与图片清单，且 `vite.config.ts` 的插件在构建后把 `item-icons` / `trader-icons` / `boss-icons` / `maps` 从产物里剔除（必须赶在 cargo 打包前，故挂在 Vite 构建尾上），图片全部由首次启动下载。商人 / Boss 图因此在 `public/` 下（不再走 Vite 静态 import，那会带 hash 无法剔除）。
  - 地图底图「瓦片优先」：数据里给了 `tilePath` 就用真瓦片（`assetUrlTemplate` 解析含 `{z}/{x}/{y}` 的模板），没有才回退单张 SVG；两者同时存在时瓦片作底图、SVG 作该层线稿叠加。

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
