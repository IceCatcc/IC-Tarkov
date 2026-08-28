mod data;
mod parser;
mod persist;
mod screenshots;
mod store;
mod watcher;

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::{Emitter, Manager};

pub struct AppState {
    pub store: Mutex<store::QuestStore>,
    pub watcher: Mutex<Option<watcher::WatcherHandle>>,
    pub screenshot: Mutex<Option<screenshots::ScreenshotHandle>>,
    /// 每文件扫描字节偏移（持久化），key = 文件完整路径字符串；重启后据此只扫新增内容
    pub offsets: Mutex<HashMap<String, u64>>,
    /// 手动解锁的任务集合（前置未达成但已解锁为可接取），持久化
    pub unlocked: Mutex<std::collections::HashSet<String>>,
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
    /// 读取坐标后是否删除截图（默认 true，保留原有行为）
    pub delete_screenshots: bool,
}

impl Default for AppSettings {
    fn default() -> Self {
        let screenshots = std::env::var("USERPROFILE")
            .map(|home| format!("{home}\\Documents\\Escape from Tarkov\\Screenshots"))
            .unwrap_or_default();
        Self {
            log_dir: "E:\\Tarkov\\Logs".to_string(),
            screenshot_dir: screenshots,
            profile: PlayerProfile::default(),
            delete_screenshots: true,
        }
    }
}

fn settings_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    Ok(dir.join("settings.json"))
}

fn read_settings(app: &tauri::AppHandle) -> AppSettings {
    match settings_path(app) {
        Ok(p) => std::fs::read_to_string(p)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default(),
        Err(_) => AppSettings::default(),
    }
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
) -> Result<AppSettings, String> {
    if !Path::new(&log_dir).is_dir() {
        return Err(format!("日志目录不存在：{log_dir}"));
    }
    // 以现有设置为基底合并，未传字段保持原值
    let mut s = read_settings(&app);
    s.log_dir = log_dir;
    s.screenshot_dir = screenshot_dir;
    if let Some(d) = delete_screenshots {
        s.delete_screenshots = d;
    }
    if let Some(p) = profile {
        s.profile = p;
    }
    let p = settings_path(&app)?;
    if let Some(parent) = p.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_string_pretty(&s).map_err(|e| e.to_string())?;
    std::fs::write(&p, json).map_err(|e| e.to_string())?;
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
#[serde(tag = "type", rename_all = "camelCase")]
pub enum QuestEvent {
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
    },
    Complete {
        quest_id: String,
        name: String,
        timestamp: String,
        via: String,
        source: String,
    },
    Progress {
        timestamp: String,
        endpoint: String,
        source: String,
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
    let path = dir.unwrap_or_else(|| "E:\\Tarkov\\Logs".to_string());
    {
        let binding = app.state::<AppState>();
        let mut w = binding.watcher.lock().unwrap();
        if let Some(h) = w.take() {
            h.stop();
        }
    }
    // 加载上次持久化的任务状态与扫描偏移（替代 clear + 全量重扫）：
    // 重启后仅扫描偏移之后的新增日志，历史任务进度从数据库恢复。
    {
        let persisted = persist::load(&app);
        let binding = app.state::<AppState>();
        let mut store = binding.store.lock().unwrap();
        store.quests = persisted.quests;
        store.activity = persisted.activity;
        store.current_map_nameid = persisted.current_map;
        let mut offsets = binding.offsets.lock().unwrap();
        *offsets = persisted.offsets;
        let mut unlocked = binding.unlocked.lock().unwrap();
        *unlocked = persisted.unlocked.iter().cloned().collect();
    }
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
    match screenshots::scan_latest(Path::new(&dir)) {
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
    }
}

#[tauri::command]
fn get_state(app: tauri::AppHandle) -> WatcherStatePayload {
    let st = app.state::<AppState>();
    let w = st.watcher.lock().unwrap();
    let store = st.store.lock().unwrap();
    WatcherStatePayload {
        watching: w.is_some(),
        log_dir: store.log_dir.clone(),
        sessions: store.sessions,
        last_scan: store.last_scan.clone(),
        error: store.error.clone(),
    }
}

#[tauri::command]
fn get_stats(app: tauri::AppHandle) -> StatsPayload {
    let binding = app.state::<AppState>();
    let st = binding.store.lock().unwrap();
    let (in_progress, completed) = st.stats();
    StatsPayload {
        in_progress,
        completed,
    }
}

#[tauri::command]
fn get_player_quests(app: tauri::AppHandle) -> Vec<store::PlayerQuest> {
    let binding = app.state::<AppState>();
    let st = binding.store.lock().unwrap();
    let mut out: Vec<store::PlayerQuest> = Vec::new();
    for (qid, entry) in &st.quests {
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
        });
    }
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
    let st = binding.store.lock().unwrap();
    st.activity.clone()
}

/// 返回手动解锁的任务集合（持久化于 quest_state.json）
#[tauri::command]
fn get_unlocked(app: tauri::AppHandle) -> Vec<String> {
    let binding = app.state::<AppState>();
    let u = binding.unlocked.lock().unwrap();
    u.iter().cloned().collect()
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
    {
        let mut store = binding.store.lock().unwrap();
        let mut unlocked = binding.unlocked.lock().unwrap();
        match action.as_str() {
            "unlock" => {
                // 目标本身 + 所有前置（传递闭包）；前置中未完成的才需要解锁
                let mut to_unlock: Vec<String> = vec![quest_id.clone()];
                for pid in data::prereqs_closure(&quest_id) {
                    let completed = store
                        .quests
                        .get(&pid)
                        .map(|e| e.completed_at.is_some())
                        .unwrap_or(false);
                    if !completed {
                        to_unlock.push(pid);
                    }
                }
                for id in to_unlock {
                    unlocked.insert(id.clone());
                    store.push_activity(store::ActivityRow {
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
                    let e = store.quests.entry(pid.clone()).or_default();
                    if e.completed_at.is_none() {
                        e.accepted_at = Some(ts.clone());
                        e.completed_at = Some(ts.clone());
                        store.push_activity(store::ActivityRow {
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
                let e = store.quests.entry(quest_id.clone()).or_default();
                if e.accepted_at.is_none() {
                    e.accepted_at = Some(ts.clone());
                }
                store.push_activity(store::ActivityRow {
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
                let e = store.quests.entry(quest_id.clone()).or_default();
                if e.accepted_at.is_none() {
                    e.accepted_at = Some(ts.clone());
                }
                e.completed_at = Some(ts.clone());
                store.push_activity(store::ActivityRow {
                    id: format!("cmp|{quest_id}|manual|{ts}"),
                    ts: ts.clone(),
                    kind: "complete".to_string(),
                    quest_id: quest_id.clone(),
                    quest_name: data::resolve_name(&quest_id),
                    text: format!("手动完成：{}", data::resolve_name(&quest_id)),
                    wiki: None,
                });
            }
            other => return Err(format!("未知操作：{other}")),
        }
    }
    persist::save(&app);

    // 重建返回数据
    let binding2 = app.state::<AppState>();
    let store = binding2.store.lock().unwrap();
    let mut out: Vec<store::PlayerQuest> = Vec::new();
    for (qid, entry) in &store.quests {
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
        });
    }
    out.sort_by(|a, b| {
        let pa = a.accepted_at.clone().unwrap_or_default();
        let pb = b.accepted_at.clone().unwrap_or_default();
        pb.cmp(&pa)
    });
    let unlocked = binding2.unlocked.lock().unwrap();
    let unlocked_vec: Vec<String> = unlocked.iter().cloned().collect();
    Ok(StatusResult {
        quests: out,
        unlocked: unlocked_vec,
    })
}

/// 重新读取日志：清空持久化文件与内存状态（含扫描偏移），再从零全量扫描日志重新生成。
/// 初始扫描 emit=false，仅重建内存与落盘，不会向前端刷历史活动。
#[tauri::command]
fn reset_and_rescan(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(p) = persist::state_path(&app) {
        let _ = std::fs::remove_file(p);
    }
    {
        let binding = app.state::<AppState>();
        let mut store = binding.store.lock().unwrap();
        store.quests.clear();
        store.activity.clear();
        store.current_map_nameid = None;
        let mut offsets = binding.offsets.lock().unwrap();
        offsets.clear();
        let mut unlocked = binding.unlocked.lock().unwrap();
        unlocked.clear();
    }
    let dir = read_settings(&app).log_dir;
    start_watching(app, Some(dir))
}

/// 导出数据：把当前内存状态 + 扫描偏移写入指定路径（JSON 文件）
#[tauri::command]
fn export_data(app: tauri::AppHandle, path: String) -> Result<(), String> {
    persist::save_to_path(&app, Path::new(&path))
}

/// 导入数据：读取指定路径的 quest_state.json，覆盖持久化文件并载入内存，
/// 随后重启监控（按导入的偏移增量续读，不全量重扫）。
#[tauri::command]
fn import_data(app: tauri::AppHandle, path: String) -> Result<(), String> {
    let content = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let parsed: persist::Persisted =
        serde_json::from_str(&content).map_err(|e| format!("文件格式错误：{e}"))?;
    if let Some(p) = persist::state_path(&app) {
        if let Some(parent) = p.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        std::fs::write(&p, &content).map_err(|e| e.to_string())?;
    }
    {
        let binding = app.state::<AppState>();
        let mut store = binding.store.lock().unwrap();
        store.quests = parsed.quests;
        store.activity = parsed.activity;
        store.current_map_nameid = parsed.current_map;
        let mut offsets = binding.offsets.lock().unwrap();
        *offsets = parsed.offsets;
        let mut unlocked = binding.unlocked.lock().unwrap();
        *unlocked = parsed.unlocked.iter().cloned().collect();
    }
    let dir = read_settings(&app).log_dir;
    start_watching(app, Some(dir))
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
    let s = st.store.lock().unwrap();
    s.current_map_nameid.clone()
}

#[tauri::command]
fn get_maps() -> Vec<data::MapInfo> {
    data::get_maps()
}

#[tauri::command]
fn open_url(url: String) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("cmd")
            .args(["/c", "start", "", &url])
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(not(target_os = "windows"))]
    {
        std::process::Command::new("xdg-open")
            .arg(&url)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

pub(crate) fn emit_state(app: &tauri::AppHandle) {
    let st = app.state::<AppState>();
    let w = st.watcher.lock().unwrap();
    let store = st.store.lock().unwrap();
    let payload = WatcherStatePayload {
        watching: w.is_some(),
        log_dir: store.log_dir.clone(),
        sessions: store.sessions,
        last_scan: store.last_scan.clone(),
        error: store.error.clone(),
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
    };
    let _ = app.emit("quest-event", ev);
}

pub(crate) fn emit_progress(app: &tauri::AppHandle, endpoint: &str, timestamp: &str, source: &str) {
    let ev = QuestEvent::Progress {
        timestamp: timestamp.to_string(),
        endpoint: endpoint.to_string(),
        source: source.to_string(),
    };
    let _ = app.emit("quest-event", ev);
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            app.manage(AppState {
                store: Mutex::new(store::QuestStore::new()),
                watcher: Mutex::new(None),
                screenshot: Mutex::new(None),
                offsets: Mutex::new(HashMap::new()),
                unlocked: Mutex::new(std::collections::HashSet::new()),
            });
            data::load();
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
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
            get_maps,
            open_url,
            reset_and_rescan,
            export_data,
            import_data,
            get_unlocked,
            set_quest_status
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
