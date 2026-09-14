mod apidata;
mod data;
pub mod dataset;
mod keepawake;
mod parser;
mod persist;
mod screenshots;
mod store;
mod sync;
mod watcher;
// 局域网同步服务端（axum 等）仅电脑端编译；手机端是纯 WS 客户端，不编译该模块
#[cfg(not(any(target_os = "android", target_os = "ios")))]
mod lan;

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::{Emitter, Manager};

pub struct AppState {
    /// 三种任务模式（pvp / pvps / pve）各自的进度，互不干扰
    pub modes: Mutex<HashMap<String, store::ModeData>>,
    /// 日志检测到的会话模式：新识别到的进度写入这一套
    pub active_mode: Mutex<String>,
    /// 界面查看的模式：读取与手动编辑这一套
    pub view_mode: Mutex<String>,
    /// 监控状态（全局：日志目录 / 会话数 / 最后扫描 / 错误）
    pub watch: Mutex<store::WatchStatus>,
    pub watcher: Mutex<Option<watcher::WatcherHandle>>,
    pub screenshot: Mutex<Option<screenshots::ScreenshotHandle>>,
}

impl AppState {
    /// 以指定模式的数据执行闭包（模式不存在时按空数据创建）
    pub fn with_mode<R>(&self, mode: &str, f: impl FnOnce(&mut store::ModeData) -> R) -> R {
        let key = store::norm_mode(mode);
        let mut g = self.modes.lock().unwrap();
        let md = g.entry(key).or_insert_with(store::ModeData::new);
        f(md)
    }

    /// 写入目标：日志检测到的会话模式
    pub fn with_active<R>(&self, f: impl FnOnce(&mut store::ModeData) -> R) -> R {
        let m = self.active_mode.lock().unwrap().clone();
        self.with_mode(&m, f)
    }

    /// 读取 / 手动编辑目标：界面选中的模式
    pub fn with_view<R>(&self, f: impl FnOnce(&mut store::ModeData) -> R) -> R {
        let m = self.view_mode.lock().unwrap().clone();
        self.with_mode(&m, f)
    }

    pub fn active(&self) -> String {
        self.active_mode.lock().unwrap().clone()
    }

    pub fn view(&self) -> String {
        self.view_mode.lock().unwrap().clone()
    }
}

// ---------------- 应用设置（持久化） ----------------

/// 角色档案（日志无法提供好感度，由用户手动填写）
#[derive(Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct PlayerProfile {
    /// 玩家等级
    pub level: u32,
    /// 商人忠诚等级表：trader_id -> LL（1..4），未填写按 1 处理
    pub loyalty: std::collections::HashMap<String, u32>,
    /// 已锁定的地图 id 列表（玩家尚未解锁的地图）；为空表示全部地图可用
    #[serde(default)]
    pub locked_maps: Vec<String>,
}

impl Default for PlayerProfile {
    fn default() -> Self {
        Self {
            level: 1,
            loyalty: std::collections::HashMap::new(),
            locked_maps: Vec::new(),
        }
    }
}

#[derive(Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AppSettings {
    pub log_dir: String,
    pub screenshot_dir: String,
    pub profile: PlayerProfile,
    /// 读取坐标后是否删除截图（默认 true，保留原有行为）；
    /// 开启时启动之后产生的不含坐标截图也会被一并清理
    pub delete_screenshots: bool,
    /// 移动端屏幕常亮（Android FLAG_KEEP_SCREEN_ON，默认 true）；桌面端不生效，仅持久化
    pub keep_screen_on: bool,
    /// 各任务模式（pvp / pvps / pve）的档案真值源
    #[serde(default)]
    pub profiles: HashMap<String, PlayerProfile>,
    /// UI 偏好（图谱筛选/模式切换/侧边栏等），宽松 schema：前端自行定义键值
    #[serde(default)]
    pub ui_prefs: std::collections::HashMap<String, serde_json::Value>,
}

impl AppSettings {
    /// 读取某个模式的档案（不存在则返回默认）
    pub fn profile_of(&self, mode: &str) -> PlayerProfile {
        self.profiles
            .get(&store::norm_mode(mode))
            .cloned()
            .unwrap_or_default()
    }

    /// 写回某个模式的档案
    pub fn set_profile_of(&mut self, mode: &str, p: PlayerProfile) {
        self.profiles.insert(store::norm_mode(mode), p);
    }
}

impl Default for AppSettings {
    fn default() -> Self {
        // 截图目录默认尝试 Windows「文档」下的游戏截图目录，仅在该目录真实存在时填入；
        // 否则留空，等用户在设置里自行选择。日志目录默认留空（等用户选择）。
        let screenshots = std::env::var("USERPROFILE")
            .ok()
            .map(|home| format!("{home}\\Documents\\Escape from Tarkov\\Screenshots"))
            .filter(|p| Path::new(p).is_dir())
            .unwrap_or_default();
        Self {
            log_dir: String::new(),
            screenshot_dir: screenshots,
            profile: PlayerProfile::default(),
            profiles: HashMap::new(),
            delete_screenshots: true,
            // 手机端常作第二屏：默认常亮；旧版 settings.json 无该字段时按 true 处理
            keep_screen_on: true,
            ui_prefs: std::collections::HashMap::new(),
        }
    }
}

// ---------------- 数据根目录（自动探测，不再使用位置标记文件） ----------------

/// 程序目录下的数据目录（默认/优先，即可移动的「便携目录」）
fn portable_data_root() -> Result<PathBuf, String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    Ok(exe
        .parent()
        .ok_or_else(|| "无法确定程序目录".to_string())?
        .join("data"))
}

/// 目录里是否已有「实质数据」：配置文件、任务进度，或 tarkov-api 缓存内已有 JSON。
/// 仅被自动创建的空目录不算有数据，避免误导探测。
fn root_has_data(p: &Path) -> bool {
    if !p.is_dir() {
        return false;
    }
    if p.join("settings.json").is_file() {
        return true;
    }
    // 任务进度 / 收藏进度：新格式带模式后缀（quest_state.pvp.json），旧格式无后缀
    if let Ok(rd) = std::fs::read_dir(p) {
        for e in rd.flatten() {
            let name = e.file_name().to_string_lossy().to_string();
            if name.ends_with(".json")
                && (name.starts_with("quest_state") || name.starts_with("collected"))
            {
                return true;
            }
        }
    }
    let api = p.join("tarkov-api");
    if api.is_dir() {
        if let Ok(rd) = std::fs::read_dir(&api) {
            for e in rd.flatten() {
                if e.path().extension().map_or(false, |x| x == "json") {
                    return true;
                }
            }
        }
    }
    false
}

/// 数据根目录：程序目录 data 优先，无数据再找 AppData；
/// 两侧都没有数据时在程序目录 data 下新建（若不可写则退回 AppData 新建）。
/// 完全以「数据实际在哪」为准，不依赖任何标记文件 —— 手工搬目录 / 早期迁移错位都能自愈。
pub fn data_root(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let portable = portable_data_root()?;
    if root_has_data(&portable) {
        return Ok(portable);
    }
    let app_root = app.path().app_config_dir().map_err(|e| e.to_string())?;
    if root_has_data(&app_root) {
        return Ok(app_root);
    }
    match std::fs::create_dir_all(&portable) {
        Ok(()) => Ok(portable),
        Err(_) => {
            // 程序目录不可写（例如安装到受系统保护的位置）时退回 AppData
            std::fs::create_dir_all(&app_root).map_err(|e| e.to_string())?;
            Ok(app_root)
        }
    }
}

/// 数据目录探测结果（供前端展示）
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct DataLocationInfo {
    /// 实际生效的根：portable = 程序目录 data；appdata = AppData
    kind: String,
    /// 实际生效根目录的完整路径
    root: String,
    /// 程序目录 data 里是否已有数据（说明当前为何选到这一侧）
    portable_has_data: bool,
    /// AppData 里是否已有数据
    appdata_has_data: bool,
}

/// 把「数据位置选择」记入 settings.json（ui_prefs.dataLocation）。
/// 该记录是用户上次选择/生效的位置，供前端回显与排障；
/// 运行期定位仍由 data_root() 按「数据实际在哪」自动探测，迁移成功后两者保持一致。
fn record_data_location(root: &Path, kind: &str) {
    let path = root.join("settings.json");
    let mut s = std::fs::read_to_string(&path)
        .ok()
        .and_then(|t| serde_json::from_str::<AppSettings>(&t).ok())
        .unwrap_or_default();
    let val = serde_json::json!({
        "kind": kind,
        "root": root.to_string_lossy(),
    });
    let changed = s.ui_prefs.get("dataLocation").map_or(true, |v| v != &val);
    if changed {
        s.ui_prefs.insert("dataLocation".to_string(), val);
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        if let Ok(json) = serde_json::to_string_pretty(&s) {
            let _ = std::fs::write(&path, json);
        }
    }
}

fn make_location_info(portable: &Path, app_root: &Path, root: &Path) -> DataLocationInfo {
    let kind = if root == portable { "portable" } else { "appdata" };
    DataLocationInfo {
        kind: kind.to_string(),
        root: root.to_string_lossy().into_owned(),
        portable_has_data: root_has_data(portable),
        appdata_has_data: root_has_data(app_root),
    }
}

/// 读取当前生效的数据根目录（自动探测结果，供前端展示）
#[tauri::command]
fn get_data_location(app: tauri::AppHandle) -> Result<DataLocationInfo, String> {
    let portable = portable_data_root()?;
    let app_root = app.path().app_config_dir().map_err(|e| e.to_string())?;
    let root = data_root(&app)?;
    // 清理旧版本遗留的标记文件（已不再使用）
    let _ = std::fs::remove_file(app_root.join("data_location.txt"));
    let info = make_location_info(&portable, &app_root, &root);
    record_data_location(&root, &info.kind);
    Ok(info)
}

/// 递归把 src 目录内容复制到 dst（不含 src 本身），同名文件被覆盖
fn copy_dir_contents(src: &Path, dst: &Path) -> Result<(), String> {
    std::fs::create_dir_all(dst).map_err(|e| e.to_string())?;
    for entry in std::fs::read_dir(src).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let from = entry.path();
        let to = dst.join(entry.file_name());
        if entry.file_type().map_err(|e| e.to_string())?.is_dir() {
            copy_dir_contents(&from, &to)?;
        } else {
            std::fs::copy(&from, &to).map_err(|e| format!("复制 {} 失败：{e}", from.display()))?;
        }
    }
    Ok(())
}

/// 删除目录内的全部顶层内容（目录本身保留）
fn remove_dir_contents(dir: &Path) -> Result<(), String> {
    for entry in std::fs::read_dir(dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        if entry.file_type().map_err(|e| e.to_string())?.is_dir() {
            std::fs::remove_dir_all(entry.path()).map_err(|e| e.to_string())?;
        } else {
            std::fs::remove_file(entry.path()).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

/// 数据目录迁移（设置页「数据目录位置」切换时调用）：
/// 写 settings.json 记录并把 settings.json / 任务进度 / tarkov-api 缓存整体搬到目标根，
/// 复制全部成功后才清空原根，保证运行期自动探测稳定落在新位置。
/// 目标根已存在数据时拒绝（避免两份数据互相覆盖）；复制中途失败会尽量回滚目标侧。
#[tauri::command]
fn set_data_location(app: tauri::AppHandle, kind: String) -> Result<DataLocationInfo, String> {
    if apidata::status(&app).syncing {
        return Err("数据更新正在进行中，请稍后再迁移".to_string());
    }
    let portable = portable_data_root()?;
    let app_root = app.path().app_config_dir().map_err(|e| e.to_string())?;
    let source = data_root(&app)?;
    let target = match kind.as_str() {
        "portable" => portable.clone(),
        "appdata" => app_root.clone(),
        other => return Err(format!("未知的数据位置：{other}")),
    };
    if source == target {
        // 选中的就是当前生效位置：仅补写一次记录
        record_data_location(&source, kind.as_str());
        return Ok(make_location_info(&portable, &app_root, &source));
    }
    if root_has_data(&target) {
        return Err(
            "目标位置已存在另一份数据，为避免相互覆盖，请先在目标位置打开一次本应用确认内容，或手动整理后再迁移。"
                .to_string(),
        );
    }
    if let Err(e) = copy_dir_contents(&source, &target) {
        // 复制中途失败：尽量回滚已复制到目标的内容，原根数据保持不动
        let _ = remove_dir_contents(&target);
        return Err(format!("迁移失败：{e}"));
    }
    // 数据已完整复制到目标，清空原根内容
    if let Err(e) = remove_dir_contents(&source) {
        return Err(format!(
            "数据已复制到目标位置，但清理原位置失败（{e}）。重启后应用会自动以数据所在目录为准，无需重复迁移。"
        ));
    }
    record_data_location(&target, kind.as_str());
    Ok(make_location_info(&portable, &app_root, &target))
}

fn settings_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(data_root(app)?.join("settings.json"))
}

/// 当前界面查看的任务模式（AppState 尚未初始化时回退 pvp）
pub(crate) fn view_mode_of(app: &tauri::AppHandle) -> String {
    app.try_state::<AppState>()
        .map(|s| s.view())
        .unwrap_or_else(|| "pvp".to_string())
}

fn read_settings(app: &tauri::AppHandle) -> AppSettings {
    let mut s = match settings_path(app) {
        Ok(p) => std::fs::read_to_string(p)
            .ok()
            .and_then(|t| serde_json::from_str::<AppSettings>(&t).ok())
            .unwrap_or_default(),
        Err(_) => AppSettings::default(),
    };
    // 旧版单档案迁移：只有 profile 没有 profiles 时，把旧档案归入 PVP
    if s.profiles.is_empty()
        && (s.profile.level > 1
            || !s.profile.loyalty.is_empty()
            || !s.profile.locked_maps.is_empty())
    {
        s.profiles.insert("pvp".to_string(), s.profile.clone());
    }
    // 镜像：profile 始终等于「当前查看模式」的档案，旧前端与旧逻辑无需感知 profiles
    s.profile = s.profile_of(&view_mode_of(app));
    s
}

#[tauri::command]
fn get_settings(app: tauri::AppHandle) -> AppSettings {
    read_settings(&app)
}

#[tauri::command]
fn save_settings(
    app: tauri::AppHandle,
    log_dir: String,
    screenshot_dir: String,
    delete_screenshots: Option<bool>,
    profile: Option<PlayerProfile>,
    ui_prefs: Option<std::collections::HashMap<String, serde_json::Value>>,
) -> Result<AppSettings, String> {
    // 以现有设置为基底合并，未传字段保持原值
    let mut s = read_settings(&app);
    // 目录字段语义：空 = 不修改原值（仅改角色/UI 偏好时不破坏目录配置）；
    // 非空 = 必须是存在的目录。这样好感度/UI 偏好的保存永远不会因目录问题失败。
    if !log_dir.is_empty() {
        if !Path::new(&log_dir).is_dir() {
            return Err(format!("日志目录不存在：{log_dir}"));
        }
        s.log_dir = log_dir;
    }
    if !screenshot_dir.is_empty() {
        s.screenshot_dir = screenshot_dir;
    }
    if let Some(d) = delete_screenshots {
        s.delete_screenshots = d;
    }
    let profile_changed = profile.is_some();
    if let Some(p) = profile {
        s.profile = p;
    }
    if let Some(u) = ui_prefs {
        // 合并而非整表替换：UI 偏好只回传 graphPrefs/mapPrefs/uiScale，
        // 保留后端写入的内部字段（如数据位置记录 dataLocation）。
        s.ui_prefs.extend(u);
    }
    write_settings(&app, &s)?;
    // 档案变化广播给同步的手机端（带模式标识：档案按模式独立，对端只在查看同一模式时采用）
    if profile_changed {
        let _ = app.emit(
            "profile-changed",
            serde_json::json!({ "profile": s.profile, "mode": view_mode_of(&app) }),
        );
    }
    Ok(s)
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WatcherStatePayload {
    pub watching: bool,
    pub log_dir: String,
    pub sessions: usize,
    pub last_scan: Option<String>,
    pub error: Option<String>,
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatsPayload {
    pub in_progress: u32,
    pub completed: u32,
}

#[derive(Clone, serde::Serialize)]
// 注意：enum 级 rename_all 只作用于变体名；变体字段需逐个标注 rename_all，
// 否则 trader_name/quest_id 等以 snake_case 下发，前端读到 undefined。
#[serde(tag = "type", rename_all = "camelCase")]
pub enum QuestEvent {
    #[serde(rename_all = "camelCase")]
    Accept {
        quest_id: String,
        name: String,
        trader_id: String,
        trader_name: String,
        objectives: Vec<data::ObjectivePayload>,
        wiki: String,
        min_level: Option<u32>,
        timestamp: String,
        source: String,
        /// 事件归属的任务模式（= 日志检测到的会话模式）；前端只在查看同一模式时采用
        mode: String,
    },
    #[serde(rename_all = "camelCase")]
    Complete {
        quest_id: String,
        name: String,
        timestamp: String,
        via: String,
        source: String,
        mode: String,
    },
    #[serde(rename_all = "camelCase")]
    Progress {
        timestamp: String,
        endpoint: String,
        source: String,
        mode: String,
    },
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RewardPayload {
    pub name: String,
    pub count: i64,
}

#[tauri::command]
fn start_watching(app: tauri::AppHandle, dir: Option<String>) -> Result<(), String> {
    // 未选择日志目录时：不硬编码默认路径，保持空闲等待用户在设置里选择
    let path = match dir {
        Some(d) if !d.trim().is_empty() => d,
        _ => {
            {
                let binding = app.state::<AppState>();
                let mut w = binding.watcher.lock().unwrap();
                if let Some(h) = w.take() {
                    h.stop();
                }
                let mut s = binding.screenshot.lock().unwrap();
                if let Some(old) = s.take() {
                    old.stop();
                }
            }
            return Ok(());
        }
    };
    {
        let binding = app.state::<AppState>();
        let mut w = binding.watcher.lock().unwrap();
        if let Some(h) = w.take() {
            h.stop();
        }
    }
    // 三套模式进度已在 AppState 初始化时按模式载入（persist::load_all），
    // 各自带着上次的扫描偏移，因此这里无需再做任何恢复动作。
    let handle = watcher::start(&app, &path).map_err(|e| e.to_string())?;
    {
        let binding = app.state::<AppState>();
        let mut w = binding.watcher.lock().unwrap();
        w.replace(handle);
    }
    // 截图监听（目录来自设置）
    {
        let binding = app.state::<AppState>();
        let mut s = binding.screenshot.lock().unwrap();
        if let Some(old) = s.take() {
            old.stop();
        }
        let shot_settings = read_settings(&app);
        if !shot_settings.screenshot_dir.is_empty()
            && Path::new(&shot_settings.screenshot_dir).is_dir()
        {
            s.replace(screenshots::start(
                &app,
                &shot_settings.screenshot_dir,
                shot_settings.delete_screenshots,
            ));
        }
    }
    emit_state(&app);
    Ok(())
}

#[tauri::command]
fn stop_watching(app: tauri::AppHandle) -> Result<(), String> {
    {
        let binding = app.state::<AppState>();
        let mut w = binding.watcher.lock().unwrap();
        if let Some(h) = w.take() {
            h.stop();
        }
    }
    {
        let binding = app.state::<AppState>();
        let mut s = binding.screenshot.lock().unwrap();
        if let Some(h) = s.take() {
            h.stop();
        }
    }
    emit_state(&app);
    Ok(())
}

#[tauri::command]
fn get_player_position(app: tauri::AppHandle) -> Option<screenshots::ShotPosition> {
    let _ = &app;
    let dir = read_settings(&app).screenshot_dir;
    if dir.is_empty() || !Path::new(&dir).is_dir() {
        return None;
    }
    // 启动之前就存在的截图不用于定位；是否读取后删除由设置决定
    let delete_after = read_settings(&app).delete_screenshots;
    let shot = match screenshots::scan_latest(Path::new(&dir)) {
        Some((p, mtime)) if mtime > screenshots::started_at() => {
            let shot = p
                .file_name()
                .map(|s| s.to_string_lossy().to_string())
                .and_then(|n| screenshots::parse_filename(&n));
            if delete_after {
                let _ = std::fs::remove_file(&p);
            }
            shot
        }
        _ => None,
    };
    // 读取坐标后删除模式下，一并清理启动之后产生的不含坐标截图
    if delete_after {
        screenshots::purge_unparsable(Path::new(&dir));
    }
    shot
}

#[tauri::command]
fn get_state(app: tauri::AppHandle) -> WatcherStatePayload {
    let st = app.state::<AppState>();
    let w = st.watcher.lock().unwrap();
    let wt = st.watch.lock().unwrap();
    WatcherStatePayload {
        watching: w.is_some(),
        log_dir: wt.log_dir.clone(),
        sessions: wt.sessions,
        last_scan: wt.last_scan.clone(),
        error: wt.error.clone(),
    }
}

#[tauri::command]
fn get_stats(app: tauri::AppHandle) -> StatsPayload {
    let binding = app.state::<AppState>();
    let (in_progress, completed) = binding.with_view(|md| md.stats());
    StatsPayload {
        in_progress,
        completed,
    }
}

#[tauri::command]
fn get_player_quests(app: tauri::AppHandle) -> Vec<store::PlayerQuest> {
    let binding = app.state::<AppState>();
    let mut out: Vec<store::PlayerQuest> = Vec::new();
    binding.with_view(|md| {
        for (qid, entry) in &md.quests {
            // 只有「目标打勾」记录、既未接取也未完成的条目不算玩家任务：
            // 勾选未接取任务的目标会在 store 里留下条目，不能让它冒到任务列表和地图上
            if entry.accepted_at.is_none() && entry.completed_at.is_none() {
                continue;
            }
            let info = data::resolve_accept(qid);
            let status = if entry.completed_at.is_some() {
                "completed"
            } else {
                "in_progress"
            };
            out.push(store::PlayerQuest {
                quest_id: qid.clone(),
                name: info.name,
                trader_id: info.trader_id,
                trader_name: info.trader_name,
                accepted_at: entry.accepted_at.clone(),
                completed_at: entry.completed_at.clone(),
                status: status.to_string(),
                wiki: info.wiki,
                min_level: info.min_level,
                maps: data::quest_maps(qid),
            });
        }
    });
    out.sort_by(|a, b| {
        let pa = a.accepted_at.clone().unwrap_or_default();
        let pb = b.accepted_at.clone().unwrap_or_default();
        pb.cmp(&pa) // 最新接取在前
    });
    out
}

#[tauri::command]
fn get_activity(app: tauri::AppHandle) -> Vec<store::ActivityRow> {
    let binding = app.state::<AppState>();
    binding.with_view(|md| md.activity.clone())
}

/// 返回手动解锁的任务集合（随模式持久化）
#[tauri::command]
fn get_unlocked(app: tauri::AppHandle) -> Vec<String> {
    let binding = app.state::<AppState>();
    binding.with_view(|md| md.unlocked.iter().cloned().collect())
}

/// 收藏家任务 id（数据集里找不到时返回 null）
#[tauri::command]
fn get_collector_quest_id() -> Option<String> {
    data::collector_quest_id()
}

/// 已收集的物品 id 列表（随模式持久化于 <data_root>/collected.{mode}.json）
#[tauri::command]
fn get_collected_items(app: tauri::AppHandle) -> Vec<String> {
    let binding = app.state::<AppState>();
    binding.with_view(|md| md.collected.iter().cloned().collect())
}

/// 标记 / 取消标记某个收集品为已收集，立即落盘，返回更新后的全集
#[tauri::command]
fn set_item_collected(app: tauri::AppHandle, item_id: String, collected: bool) -> Vec<String> {
    let binding = app.state::<AppState>();
    let all = binding.with_view(|md| {
        if collected {
            md.collected.insert(item_id);
        } else {
            md.collected.remove(&item_id);
        }
        md.collected.iter().cloned().collect::<Vec<String>>()
    });
    persist::save_all_from(&app);
    // 广播给同步的手机端（桌面前端自身已就地更新，重复设置同值无害）
    let _ = app.emit("collected-changed", &all);
    all
}

/// 某任务里已手动打勾完成的目标 id（随模式持久化）
#[tauri::command]
fn get_objectives_done(app: tauri::AppHandle, quest_id: String) -> Vec<String> {
    let binding = app.state::<AppState>();
    binding.with_view(|md| {
        md.quests
            .get(&quest_id)
            .map(|e| e.objectives_done.iter().cloned().collect())
            .unwrap_or_default()
    })
}

#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ObjectiveChanged {
    quest_id: String,
    objectives_done: Vec<String>,
}

/// 单独勾选 / 取消勾选某个任务目标，立即落盘，返回该任务更新后的已完成目标 id 列表。
/// 只影响玩家自己记录的进度，不会改变任务的接取/完成状态。
#[tauri::command]
fn set_objective_status(
    app: tauri::AppHandle,
    quest_id: String,
    objective_id: String,
    done: bool,
) -> Vec<String> {
    let binding = app.state::<AppState>();
    let ids = binding.with_view(|md| {
        let e = md.quests.entry(quest_id.clone()).or_default();
        if done {
            e.objectives_done.insert(objective_id);
        } else {
            e.objectives_done.remove(&objective_id);
        }
        e.objectives_done.iter().cloned().collect::<Vec<String>>()
    });
    persist::save_all_from(&app);
    // 广播给同步的手机端（本机前端已就地更新，回声为同值无害）
    let _ = app.emit(
        "objective-changed",
        ObjectiveChanged {
            quest_id,
            objectives_done: ids.clone(),
        },
    );
    ids
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct StatusResult {
    quests: Vec<store::PlayerQuest>,
    unlocked: Vec<String>,
}

/// 手动修改任务状态：
/// - "accept"  接取：完成该任务链的全部前置任务，并把本任务标记为已接取（进行中）
/// - "complete" 完成：把本任务标记为已完成
/// - "unlock"  解锁：把本任务及其全部「未结束」的前置任务标记为已解锁（可接取）
/// 返回刷新后的玩家任务列表与解锁集合，前端据此更新图谱与监控。
#[tauri::command]
fn set_quest_status(
    app: tauri::AppHandle,
    quest_id: String,
    action: String,
) -> Result<StatusResult, String> {
    let ts = chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string();
    let binding = app.state::<AppState>();
    let res: Result<(), String> = binding.with_view(|md| {
        match action.as_str() {
            "unlock" => {
                // 目标本身 + 所有前置（传递闭包）；前置中未完成的才需要解锁
                let mut to_unlock: Vec<String> = vec![quest_id.clone()];
                for pid in data::prereqs_closure(&quest_id) {
                    let completed = md
                        .quests
                        .get(&pid)
                        .map(|e| e.completed_at.is_some())
                        .unwrap_or(false);
                    if !completed {
                        to_unlock.push(pid);
                    }
                }
                for id in to_unlock {
                    md.unlocked.insert(id.clone());
                    md.push_activity(store::ActivityRow {
                        id: format!("unl|{id}|{ts}"),
                        ts: ts.clone(),
                        kind: "progress".to_string(),
                        quest_id: id.clone(),
                        quest_name: data::resolve_name(&id),
                        text: format!("手动解锁：{}", data::resolve_name(&id)),
                        wiki: None,
                    });
                }
            }
            "accept" => {
                // 接取：先完成全部前置任务
                for pid in data::prereqs_closure(&quest_id) {
                    let e = md.quests.entry(pid.clone()).or_default();
                    if e.completed_at.is_none() {
                        e.accepted_at = Some(ts.clone());
                        e.completed_at = Some(ts.clone());
                        md.push_activity(store::ActivityRow {
                            id: format!("cmp|{pid}|manual|{ts}"),
                            ts: ts.clone(),
                            kind: "complete".to_string(),
                            quest_id: pid.clone(),
                            quest_name: data::resolve_name(&pid),
                            text: format!("手动完成（接取前置）：{}", data::resolve_name(&pid)),
                            wiki: None,
                        });
                    }
                }
                // 接取目标本身（若已 completed 则保持）
                let e = md.quests.entry(quest_id.clone()).or_default();
                if e.accepted_at.is_none() {
                    e.accepted_at = Some(ts.clone());
                }
                md.push_activity(store::ActivityRow {
                    id: format!("acc|{quest_id}|manual|{ts}"),
                    ts: ts.clone(),
                    kind: "accept".to_string(),
                    quest_id: quest_id.clone(),
                    quest_name: data::resolve_name(&quest_id),
                    text: format!("手动接取：{}", data::resolve_name(&quest_id)),
                    wiki: None,
                });
            }
            "complete" => {
                let e = md.quests.entry(quest_id.clone()).or_default();
                if e.accepted_at.is_none() {
                    e.accepted_at = Some(ts.clone());
                }
                e.completed_at = Some(ts.clone());
                md.push_activity(store::ActivityRow {
                    id: format!("cmp|{quest_id}|manual|{ts}"),
                    ts: ts.clone(),
                    kind: "complete".to_string(),
                    quest_id: quest_id.clone(),
                    quest_name: data::resolve_name(&quest_id),
                    text: format!("手动完成：{}", data::resolve_name(&quest_id)),
                    wiki: None,
                });
            }
            "reset" => {
                // 重置为未接取：清掉接取/完成时间、目标打勾，并取消该任务的手动解锁标记
                if let Some(e) = md.quests.get_mut(&quest_id) {
                    e.accepted_at = None;
                    e.completed_at = None;
                    e.objectives_done.clear();
                }
                md.unlocked.remove(&quest_id);
                md.push_activity(store::ActivityRow {
                    id: format!("rst|{quest_id}|manual|{ts}"),
                    ts: ts.clone(),
                    kind: "progress".to_string(),
                    quest_id: quest_id.clone(),
                    quest_name: data::resolve_name(&quest_id),
                    text: format!("手动重置为未接取：{}", data::resolve_name(&quest_id)),
                    wiki: None,
                });
            }
            other => return Err(format!("未知操作：{other}")),
        }
        Ok(())
    });
    res?;
    persist::save_all_from(&app);

    // 重建返回数据
    let binding2 = app.state::<AppState>();
    let mut out: Vec<store::PlayerQuest> = Vec::new();
    let unlocked_vec = binding2.with_view(|md| {
        for (qid, entry) in &md.quests {
            // 同上：只有目标打勾记录的条目不进入玩家任务列表
            if entry.accepted_at.is_none() && entry.completed_at.is_none() {
                continue;
            }
            let info = data::resolve_accept(qid);
            let status = if entry.completed_at.is_some() {
                "completed"
            } else {
                "in_progress"
            };
            out.push(store::PlayerQuest {
                quest_id: qid.clone(),
                name: info.name,
                trader_id: info.trader_id,
                trader_name: info.trader_name,
                accepted_at: entry.accepted_at.clone(),
                completed_at: entry.completed_at.clone(),
                status: status.to_string(),
                wiki: info.wiki,
                min_level: info.min_level,
                maps: data::quest_maps(qid),
            });
        }
        md.unlocked.iter().cloned().collect::<Vec<String>>()
    });
    out.sort_by(|a, b| {
        let pa = a.accepted_at.clone().unwrap_or_default();
        let pb = b.accepted_at.clone().unwrap_or_default();
        pb.cmp(&pa)
    });
    Ok(StatusResult {
        quests: out,
        unlocked: unlocked_vec,
    })
}

/// 重新读取日志：支持「覆盖 / 补充」两种模式（通用日志↔数据合并策略）。
/// - cover（默认）：清空持久化文件与内存状态（含扫描偏移、手动解锁），再从零全量扫描重置到日志真值。
/// - merge：保留当前进度（含手动改动），仅清空扫描偏移后重扫，把本地日志里缺失的进度补充进 store（apply_* 幂等）。
/// 初始扫描 emit=false，仅重建内存与落盘，不会向前端刷历史活动。
#[tauri::command]
fn reset_and_rescan(app: tauri::AppHandle, mode: Option<String>) -> Result<(), String> {
    let merge = mode.as_deref() == Some("merge");
    let binding = app.state::<AppState>();
    if merge {
        // 保留进度：清空扫描偏移并落盘（磁盘 offsets 为空、进度完整），
        // 随后 start_watching 从 0 重读本地日志，把缺失进度补充回来（apply_* 幂等）。
        binding.with_active(|md| md.offsets.clear());
        persist::save_all_from(&app);
    } else {
        // cover（默认）：清空全部模式的持久化文件与内存进度，全量重扫重置到日志真值
        persist::remove_all(&app);
        {
            let mut g = binding.modes.lock().unwrap();
            for md in g.values_mut() {
                md.quests.clear();
                md.activity.clear();
                md.current_map = None;
                md.offsets.clear();
                md.unlocked.clear();
            }
        }
    }
    let dir = read_settings(&app).log_dir;
    start_watching(app, Some(dir))
}

/// 导出数据：先把内存态落盘，再把 quest_state / collected / settings 三份 json 打包为 zip。
/// path 为空时（移动端无保存对话框）自动导出到数据目录下的 ic-tarkov-data.zip，返回实际路径。
#[tauri::command]
fn export_data(app: tauri::AppHandle, path: Option<String>) -> Result<String, String> {
    persist::save_all_from(&app);
    let target = match path.as_deref() {
        Some(p) if !p.trim().is_empty() => PathBuf::from(p),
        _ => data_root(&app)?.join("ic-tarkov-data.zip"),
    };
    let path = target;
    let mut entries: Vec<(String, PathBuf)> = Vec::new();
    // 三种模式各自一份进度 + 收藏
    for m in store::MODES {
        if let Some(p) = persist::state_path_for(&app, m) {
            if p.exists() {
                entries.push((format!("quest_state.{m}.json"), p));
            }
        }
        if let Some(p) = persist::collected_path_for(&app, m) {
            if p.exists() {
                entries.push((format!("collected.{m}.json"), p));
            }
        }
    }
    let sp = settings_path(&app)?;
    if sp.exists() {
        entries.push(("settings.json".into(), sp));
    }
    if entries.is_empty() {
        return Err("没有可导出的数据".into());
    }
    let file = std::fs::File::create(&path).map_err(|e| e.to_string())?;
    let mut zip = zip::ZipWriter::new(file);
    let opts = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);
    for (name, p) in entries {
        let data = std::fs::read(&p).map_err(|e| e.to_string())?;
        zip.start_file(name, opts).map_err(|e| e.to_string())?;
        std::io::Write::write_all(&mut zip, &data).map_err(|e| e.to_string())?;
    }
    zip.finish().map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().into_owned())
}

/// 导入数据：读取 zip 包（quest_state / collected / settings.json），覆盖对应持久化文件并载入内存；
/// 兼容旧版单文件 quest_state.json 直接导入。随后重启监控（按导入的偏移增量续读）。
#[tauri::command]
// 旧版兼容：单 JSON 文件（仅任务状态，字段与模式数据一致）→ 归入 PVP 模式
fn import_json(app: &tauri::AppHandle, content: &str) -> Result<(), String> {
    let md: store::ModeData =
        serde_json::from_str(content).map_err(|e| format!("文件格式错误：{e}"))?;
    if let Some(p) = persist::state_path_for(app, "pvp") {
        if let Some(parent) = p.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        std::fs::write(&p, content).map_err(|e| e.to_string())?;
    }
    apply_mode_data(app, "pvp", md);
    restart_watcher_after_import(app);
    Ok(())
}

// 从 zip 读取器导入数据包（内存字节或文件皆可）。
// 支持 quest_state.{mode}.json / collected.{mode}.json / settings.json，
// 并兼容旧版无模式后缀的文件名（归入 PVP）。
fn import_zip(app: &tauri::AppHandle, reader: impl std::io::Read + std::io::Seek) -> Result<(), String> {
    let mut zip =
        zip::ZipArchive::new(reader).map_err(|e| format!("无法读取压缩包：{e}"))?;
    let root = data_root(app)?;
    for i in 0..zip.len() {
        let mut entry = zip.by_index(i).map_err(|e| e.to_string())?;
        let name = entry.name().to_string();
        // 只接受平铺的已知文件名（防路径穿越 / 意外条目）
        let dest = if name == "settings.json" {
            settings_path(app).ok()
        } else if name == "quest_state.json" {
            persist::state_path_for(app, "pvp")
        } else if name == "collected.json" {
            persist::collected_path_for(app, "pvp")
        } else if let Some(m) = name
            .strip_prefix("quest_state.")
            .and_then(|s| s.strip_suffix(".json"))
        {
            persist::state_path_for(app, m)
        } else if let Some(m) = name
            .strip_prefix("collected.")
            .and_then(|s| s.strip_suffix(".json"))
        {
            persist::collected_path_for(app, m)
        } else {
            continue;
        };
        let Some(dest) = dest else { continue };
        let mut content = String::new();
        std::io::Read::read_to_string(&mut entry, &mut content)
            .map_err(|e| format!("{name} 读取失败：{e}"))?;
        serde_json::from_str::<serde_json::Value>(&content)
            .map_err(|e| format!("{name} 不是有效的 JSON：{e}"))?;
        if let Some(parent) = dest.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        std::fs::write(&dest, content).map_err(|e| e.to_string())?;
    }
    // 覆盖完成后把三套数据整体重新载入内存（settings.json 的变化由前端导入后自行刷新）
    {
        let all = persist::load_all(app);
        let binding = app.state::<AppState>();
        let mut g = binding.modes.lock().unwrap();
        *g = all;
    }
    restart_watcher_after_import(app);
    // 归一化数据位置记录：导入的 settings 可能来自另一台机器/位置
    let portable = portable_data_root()?;
    let kind = if root == portable { "portable" } else { "appdata" };
    record_data_location(&root, kind);
    Ok(())
}

#[tauri::command]
fn import_data(app: tauri::AppHandle, path: String) -> Result<(), String> {
    let src = Path::new(&path);
    // 旧版兼容：单 JSON 文件（仅任务状态）
    if src
        .extension()
        .map_or(false, |e| e.eq_ignore_ascii_case("json"))
    {
        let content = std::fs::read_to_string(src).map_err(|e| e.to_string())?;
        import_json(&app, &content)
    } else {
        let file = std::fs::File::open(src).map_err(|e| e.to_string())?;
        import_zip(&app, file)
    }
}

/// 移动端导入：对话框返回的是 content://（Android）/ file://（iOS）URI，
/// std::fs 无法直接打开，由前端用 plugin-fs 读取字节后传入本命令。
#[tauri::command]
fn import_data_bytes(app: tauri::AppHandle, bytes: Vec<u8>) -> Result<(), String> {
    if bytes.len() >= 2 && &bytes[0..2] == b"PK" {
        import_zip(&app, std::io::Cursor::new(bytes))
    } else {
        import_json(&app, &String::from_utf8_lossy(&bytes))
    }
}

/// 用一份模式数据替换内存中对应模式的进度（旧版单文件导入 / 同步快照用）
pub(crate) fn apply_mode_data(app: &tauri::AppHandle, mode: &str, data: store::ModeData) {
    let binding = app.state::<AppState>();
    let mut g = binding.modes.lock().unwrap();
    g.insert(store::norm_mode(mode), data);
}

/// 导入完成后按当前日志目录重建监控。
/// 移动端无日志可监控：不启动 watcher（否则本地 watcher-state{watching:false}
/// 会覆盖手机端从电脑端同步来的监控状态）。
fn restart_watcher_after_import(app: &tauri::AppHandle) {
    #[cfg(not(mobile))]
    {
        let dir = read_settings(app).log_dir;
        let _ = start_watching(app.clone(), Some(dir));
    }
    #[cfg(mobile)]
    {
        let _ = app;
    }
}

/// 写设置到 settings.json（save_settings 与局域网快照应用共用）
pub(crate) fn write_settings(app: &tauri::AppHandle, s: &AppSettings) -> Result<(), String> {
    let mut s = s.clone();
    // 前端提交的 profile 视为「当前查看模式」的档案，写回真值源后再落盘
    let mode = view_mode_of(app);
    s.set_profile_of(&mode, s.profile.clone());
    s.profile = s.profile_of(&mode);
    let p = settings_path(app)?;
    if let Some(parent) = p.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let json = serde_json::to_string_pretty(&s).map_err(|e| e.to_string())?;
    std::fs::write(&p, json).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn get_quest_graph(app: tauri::AppHandle) -> data::QuestGraph {
    let _ = &app;
    data::get_graph()
}

#[tauri::command]
fn get_quest_detail(quest_id: String) -> Option<data::QuestDetail> {
    data::get_detail(&quest_id)
}

#[tauri::command]
fn get_current_map(app: tauri::AppHandle) -> Option<String> {
    let st = app.state::<AppState>();
    st.with_active(|md| md.current_map.clone())
}

/// 当前会话模式（由日志检测得到）：pvp / pvps / pve
#[tauri::command]
fn get_session_mode(app: tauri::AppHandle) -> Option<String> {
    let st = app.state::<AppState>();
    Some(st.active())
}

/// 切换界面查看的任务模式（读取与手动编辑都落到该模式；日志写入仍由 active_mode 决定）
#[tauri::command]
fn set_view_mode(app: tauri::AppHandle, mode: String) -> Result<(), String> {
    let m = store::norm_mode(&mode);
    let changed = {
        let st = app.state::<AppState>();
        let mut vm = st.view_mode.lock().unwrap();
        if *vm == m {
            false
        } else {
            *vm = m;
            true
        }
    };
    // 切换后立即落盘一次，避免刚编辑的档案 / 进度丢失
    if changed {
        persist::save_all_from(&app);
        emit_state(&app);
    }
    Ok(())
}

#[tauri::command]
fn get_maps() -> Vec<data::MapInfo> {
    data::get_maps()
}

/* ---------------- 游戏数据（tarkov.dev 原始 API JSON） ---------------- */

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct DataStatusPayload {
    #[serde(flatten)]
    base: apidata::DataStatus,
    quest_count: usize,
    map_count: usize,
}

/// 后台同步：拉取全部端点 -> 重建派生索引 -> 通知前端刷新
fn spawn_sync(app: tauri::AppHandle, force: bool) {
    std::thread::spawn(move || match apidata::sync(&app, force) {
        Ok(report) => {
            if !report.updated.is_empty() {
                match dataset::rebuild(&app) {
                    Ok((q, m)) => println!("[data] 数据集已刷新：{q} 个任务 / {m} 张地图"),
                    Err(e) => eprintln!("[data] 刷新后重建数据集失败：{e}"),
                }
                let _ = app.emit("data-reloaded", report.updated_at);
            }
        }
        Err(e) => eprintln!("[apidata] 数据更新失败：{e}"),
    });
}

#[tauri::command]
fn get_data_status(app: tauri::AppHandle) -> DataStatusPayload {
    let s = dataset::store();
    DataStatusPayload {
        base: apidata::status(&app),
        quest_count: s.quests.len(),
        map_count: s.maps.len(),
    }
}

/// 触发数据更新（异步执行，进度通过 data-sync-progress / data-synced 事件下发）
#[tauri::command]
fn refresh_game_data(app: tauri::AppHandle, force: Option<bool>) -> Result<(), String> {
    if apidata::status(&app).syncing {
        return Err("数据更新正在进行中".to_string());
    }
    spawn_sync(app, force.unwrap_or(false));
    Ok(())
}

/// 地图标记（原 public/data/map-markers.json，现由原始 API 数据派生）
#[tauri::command]
fn get_map_markers() -> serde_json::Value {
    dataset::store().markers.clone()
}

/// 任务目标区域（原 public/data/quest-zones.json）
#[tauri::command]
fn get_quest_zones() -> serde_json::Value {
    dataset::store().zones.clone()
}

/// 地图 Boss 刷新率（原 public/data/map-bosses.json）
#[tauri::command]
fn get_map_bosses() -> serde_json::Value {
    dataset::store().bosses.clone()
}

/// 地图骨架（随包分发的静态几何数据，中文名由原始 API 数据注入）
#[tauri::command]
fn get_maps_skeleton() -> serde_json::Value {
    dataset::store().skeleton.clone()
}

#[tauri::command]
fn open_url(url: String) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        // 用 explorer 打开 URL（走默认浏览器）。
        // 不用 `cmd /c start`：应用派生 cmd.exe 是杀软行为启发式的常见扣分项，
        // 未签名 + debug 符号 + 派生 cmd 容易被 360 等判定为可疑。
        std::process::Command::new("explorer")
            .arg(&url)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(&url)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(any(target_os = "android", target_os = "ios"))]
    {
        // 移动端无桌面文件浏览器；外链打开后续由 tauri-plugin-shell 补全（见 P4）
        let _ = url;
    }
    #[cfg(not(any(
        target_os = "windows",
        target_os = "macos",
        target_os = "android",
        target_os = "ios"
    )))]
    {
        std::process::Command::new("xdg-open")
            .arg(&url)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn open_data_dir(app: tauri::AppHandle) -> Result<(), String> {
    let dir = data_root(&app)?;
    if !dir.exists() {
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer")
            .arg(&dir)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(&dir)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(any(target_os = "android", target_os = "ios"))]
    {
        // 移动端无「文件浏览器」概念；数据目录分享/提示后续在 P4 补全
        let _ = dir;
    }
    #[cfg(not(any(
        target_os = "windows",
        target_os = "macos",
        target_os = "android",
        target_os = "ios"
    )))]
    {
        std::process::Command::new("xdg-open")
            .arg(&dir)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

pub(crate) fn emit_state(app: &tauri::AppHandle) {
    let st = app.state::<AppState>();
    let w = st.watcher.lock().unwrap();
    let wt = st.watch.lock().unwrap();
    let payload = WatcherStatePayload {
        watching: w.is_some(),
        log_dir: wt.log_dir.clone(),
        sessions: wt.sessions,
        last_scan: wt.last_scan.clone(),
        error: wt.error.clone(),
    };
    let _ = app.emit("watcher-state", payload);
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn emit_accept(
    app: &tauri::AppHandle,
    quest_id: &str,
    name: &str,
    trader_id: &str,
    trader_name: &str,
    objectives: &[data::ObjectivePayload],
    wiki: &str,
    min_level: Option<u32>,
    timestamp: &str,
    source: &str,
) {
    let ev = QuestEvent::Accept {
        quest_id: quest_id.to_string(),
        name: name.to_string(),
        trader_id: trader_id.to_string(),
        trader_name: trader_name.to_string(),
        objectives: objectives.to_vec(),
        wiki: wiki.to_string(),
        min_level,
        timestamp: timestamp.to_string(),
        source: source.to_string(),
        mode: app.state::<AppState>().active(),
    };
    let _ = app.emit("quest-event", ev);
}

pub(crate) fn emit_complete(
    app: &tauri::AppHandle,
    quest_id: &str,
    name: &str,
    timestamp: &str,
    via: &str,
    source: &str,
) {
    let ev = QuestEvent::Complete {
        quest_id: quest_id.to_string(),
        name: name.to_string(),
        timestamp: timestamp.to_string(),
        via: via.to_string(),
        source: source.to_string(),
        mode: app.state::<AppState>().active(),
    };
    let _ = app.emit("quest-event", ev);
}

pub(crate) fn emit_progress(app: &tauri::AppHandle, endpoint: &str, timestamp: &str, source: &str) {
    let ev = QuestEvent::Progress {
        timestamp: timestamp.to_string(),
        endpoint: endpoint.to_string(),
        source: source.to_string(),
        mode: app.state::<AppState>().active(),
    };
    let _ = app.emit("quest-event", ev);
}

// 移动端（Android/iOS）入口：tauri-build 会为移动 target 设置 mobile cfg，
// 生成 JavaVM 启动符号；桌面端无影响。
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default().plugin(tauri_plugin_dialog::init());
    #[cfg(mobile)]
    let builder = builder
        .plugin(tauri_plugin_barcode_scanner::init())
        .plugin(tauri_plugin_fs::init());
    builder
        .setup(|app| {
            // 数据根目录在每次需要时按「程序目录 data → AppData → 新建程序目录 data」自动探测，
            // 不依赖任何标记文件，此处无需提前设置，直接进入状态初始化。
            // 三套模式进度（含收藏）在初始化时一次性按模式载入
            let handle = app.handle().clone();
            app.manage(AppState {
                modes: Mutex::new(persist::load_all(&handle)),
                active_mode: Mutex::new("pvp".to_string()),
                view_mode: Mutex::new("pvp".to_string()),
                watch: Mutex::new(store::WatchStatus::default()),
                watcher: Mutex::new(None),
                screenshot: Mutex::new(None),
            });
            // 装载 tarkov.dev 原始数据的派生索引。
            // 仅当缓存里已有部分数据且已过期时才后台静默拉取；
            // 缓存为空（没有任何 JSON）时不自动联网下载，避免离线/首次启动空转与误报，
            // 首次数据由用户在设置页点击「更新数据」获取。
            let handle = app.handle().clone();
            // 移动端：按 settings.json 的 keepScreenOn 应用屏幕常亮
            // （启动即生效；用户在设置里切换时由 set_keep_screen_on 即时同步）
            #[cfg(any(target_os = "android", target_os = "ios"))]
            crate::keepawake::apply(&handle, read_settings(&handle).keep_screen_on);
            data::init(&handle);
            let st = apidata::status(&handle);
            let has_cache = st.files.iter().any(|f| f.bytes > 0);
            if st.stale && has_cache {
                spawn_sync(handle, false);
            }
            // 同步：生成 token + 广播通道，并把现有事件桥接到广播（供手机端 WS 订阅）。
            // 仅电脑端启动服务端；手机端为客户端，无此步骤。
            #[cfg(not(any(target_os = "android", target_os = "ios")))]
            crate::lan::setup_lan(app);
            Ok(())
        })
        .invoke_handler({
            // 电脑端：含局域网同步服务端命令
            #[cfg(not(any(target_os = "android", target_os = "ios")))]
            {
                tauri::generate_handler![
                    start_watching,
                    stop_watching,
                    get_state,
                    get_stats,
                    get_player_quests,
                    get_activity,
                    get_quest_graph,
                    get_quest_detail,
                    get_settings,
                    save_settings,
                    get_player_position,
                    get_current_map,
                    get_session_mode,
                    set_view_mode,
                    get_maps,
                    open_url,
                    open_data_dir,
                    get_data_location,
                    set_data_location,
                    reset_and_rescan,
                    export_data,
                    import_data,
                    import_data_bytes,
                    get_unlocked,
                    get_collector_quest_id,
                    get_collected_items,
                    set_item_collected,
                    set_quest_status,
                    get_objectives_done,
                    set_objective_status,
                    get_data_status,
                    refresh_game_data,
                    get_map_markers,
                    get_quest_zones,
                    get_map_bosses,
                    get_maps_skeleton,
                    lan::start_lan_sync,
                    lan::stop_lan_sync,
                    lan::get_lan_status,
                    lan::get_connect_info,
                    sync::get_snapshot,
                    sync::apply_snapshot,
                    sync::get_sync_summary,
                    lan::resolve_lan_conflict,
                    keepawake::set_keep_screen_on
                ]
            }
            // 手机端：纯 WS 客户端，不注册局域网同步服务端命令
            #[cfg(any(target_os = "android", target_os = "ios"))]
            {
                tauri::generate_handler![
                    start_watching,
                    stop_watching,
                    get_state,
                    get_stats,
                    get_player_quests,
                    get_activity,
                    get_quest_graph,
                    get_quest_detail,
                    get_settings,
                    save_settings,
                    get_player_position,
                    get_current_map,
                    get_session_mode,
                    set_view_mode,
                    get_maps,
                    open_url,
                    open_data_dir,
                    get_data_location,
                    set_data_location,
                    reset_and_rescan,
                    export_data,
                    import_data,
                    import_data_bytes,
                    get_unlocked,
                    get_collector_quest_id,
                    get_collected_items,
                    set_item_collected,
                    set_quest_status,
                    get_objectives_done,
                    set_objective_status,
                    get_data_status,
                    refresh_game_data,
                    get_map_markers,
                    get_quest_zones,
                    get_map_bosses,
                    get_maps_skeleton,
                    // 手机端也要能生成 / 应用快照与数据摘要（WS 客户端同步用）
                    sync::get_snapshot,
                    sync::apply_snapshot,
                    sync::get_sync_summary,
                    keepawake::set_keep_screen_on
                ]
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
