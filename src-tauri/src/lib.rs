mod data;
mod parser;
mod store;
mod watcher;

use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::{Emitter, Manager};

pub struct AppState {
    pub store: Mutex<store::QuestStore>,
    pub watcher: Mutex<Option<watcher::WatcherHandle>>,
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
}

impl Default for PlayerProfile {
    fn default() -> Self {
        Self {
            level: 1,
            loyalty: std::collections::HashMap::new(),
        }
    }
}

#[derive(Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AppSettings {
    pub log_dir: String,
    pub screenshot_dir: String,
    pub profile: PlayerProfile,
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
    profile: Option<PlayerProfile>,
) -> Result<AppSettings, String> {
    if !Path::new(&log_dir).is_dir() {
        return Err(format!("日志目录不存在：{log_dir}"));
    }
    // 以现有设置为基底合并，未传字段保持原值
    let mut s = read_settings(&app);
    s.log_dir = log_dir;
    s.screenshot_dir = screenshot_dir;
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
    // 开始读取日志前先清空旧数据（防止热重载/重复读取残留）。
    // 注意：必须在 watcher::start 之前——initial_scan 是同步执行的，start 后再清会抹掉刚扫出的历史。
    {
        let binding = app.state::<AppState>();
        binding.store.lock().unwrap().clear();
    }
    let handle = watcher::start(&app, &path).map_err(|e| e.to_string())?;
    {
        let binding = app.state::<AppState>();
        let mut w = binding.watcher.lock().unwrap();
        w.replace(handle);
    }
    emit_state(&app);
    Ok(())
}

#[tauri::command]
fn stop_watching(app: tauri::AppHandle) -> Result<(), String> {
    let binding = app.state::<AppState>();
    let mut w = binding.watcher.lock().unwrap();
    if let Some(h) = w.take() {
        h.stop();
    }
    drop(w);
    emit_state(&app);
    Ok(())
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
            open_url
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
