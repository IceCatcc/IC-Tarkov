//! 任务状态持久化：把解析出的任务进度与每文件扫描偏移落盘，
//! 避免每次启动都全量重扫日志；下次启动仅扫描偏移之后的新增内容。

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::Manager;

use crate::store::{ActivityRow, QuestEntry};
use crate::AppState;

/// 落盘结构：任务进度 + 当前地图 + 每文件扫描字节偏移（key = 文件完整路径字符串）
/// + 手动解锁的任务集合（前置未达成但已被用户解锁为可接取）
#[derive(Serialize, Deserialize, Default)]
pub struct Persisted {
    pub quests: HashMap<String, QuestEntry>,
    pub activity: Vec<ActivityRow>,
    pub current_map: Option<String>,
    pub offsets: HashMap<String, u64>,
    #[serde(default)]
    pub unlocked: Vec<String>,
    /// 收藏家已收集物品 id（导出/导入携带；运行期的真值源是 collected.json）
    #[serde(default)]
    pub collected: Vec<String>,
}

/// 收藏进度单独文件：<data_root>/collected.json
/// 与 quest_state.json 分开：避免「重新读取日志」清空玩家手动记录的收集进度。
pub fn collected_path(app: &tauri::AppHandle) -> Option<PathBuf> {
    crate::data_root(app).ok().map(|d| d.join("collected.json"))
}

pub fn load_collected(app: &tauri::AppHandle) -> Vec<String> {
    if let Some(p) = collected_path(app) {
        if let Ok(s) = std::fs::read_to_string(p) {
            if let Ok(v) = serde_json::from_str::<Vec<String>>(&s) {
                return v;
            }
        }
    }
    Vec::new()
}

pub fn save_collected(app: &tauri::AppHandle, ids: &[String]) {
    if let Some(path) = collected_path(app) {
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        if let Ok(json) = serde_json::to_string(ids) {
            let _ = std::fs::write(&path, json);
        }
    }
}

pub fn state_path(app: &tauri::AppHandle) -> Option<PathBuf> {
    crate::data_root(app).ok().map(|d| d.join("quest_state.json"))
}

/// 读取上次持久化的状态；文件不存在/损坏则返回空（等效首次启动）
pub fn load(app: &tauri::AppHandle) -> Persisted {
    if let Some(p) = state_path(app) {
        if let Ok(s) = std::fs::read_to_string(p) {
            if let Ok(v) = serde_json::from_str::<Persisted>(&s) {
                return v;
            }
        }
    }
    Persisted::default()
}

/// 把内存中的任务状态与扫描偏移写入磁盘（在每次扫描后调用，代价很小）
pub fn save(app: &tauri::AppHandle) {
    let st = app.state::<AppState>();
    let store = st.store.lock().unwrap();
    let offsets = st.offsets.lock().unwrap();
    let snapshot = Persisted {
        quests: store.quests.clone(),
        activity: store.activity.clone(),
        current_map: store.current_map_nameid.clone(),
        offsets: offsets.clone(),
        unlocked: st.unlocked.lock().unwrap().iter().cloned().collect(),
        collected: st.collected.lock().unwrap().iter().cloned().collect(),
    };
    drop(store);
    drop(offsets);

    if let Some(path) = state_path(app) {
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        if let Ok(json) = serde_json::to_string(&snapshot) {
            let _ = std::fs::write(&path, json);
        }
    }
}

/// 把当前内存状态 + 扫描偏移导出到任意路径（「导出数据」用）
pub fn save_to_path(app: &tauri::AppHandle, path: &Path) -> Result<(), String> {
    let st = app.state::<AppState>();
    let store = st.store.lock().unwrap();
    let offsets = st.offsets.lock().unwrap();
    let snapshot = Persisted {
        quests: store.quests.clone(),
        activity: store.activity.clone(),
        current_map: store.current_map_nameid.clone(),
        offsets: offsets.clone(),
        unlocked: st.unlocked.lock().unwrap().iter().cloned().collect(),
        collected: st.collected.lock().unwrap().iter().cloned().collect(),
    };
    drop(store);
    drop(offsets);

    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let json = serde_json::to_string(&snapshot).map_err(|e| e.to_string())?;
    std::fs::write(path, json).map_err(|e| e.to_string())?;
    Ok(())
}
