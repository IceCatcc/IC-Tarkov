//! 任务进度持久化（按任务模式 PVP / PVPS / PVE 分文件）：
//!   <data_root>/quest_state.{mode}.json   —— 任务进度 + 活动流 + 扫描偏移 + 手动解锁 + 当前地图
//!   <data_root>/collected.{mode}.json     —— 收藏家进度
//! 两者分开是为了避免「重新读取日志」清空玩家手动记录的收集进度。
//! 旧版单套文件（quest_state.json / collected.json）在首次读取 PVP 时由 rename 迁入，天然只执行一次。

use std::collections::HashMap;
use std::path::PathBuf;

use tauri::Manager;

use crate::store::{norm_mode, ModeData, MODES};

pub fn state_path_for(app: &tauri::AppHandle, mode: &str) -> Option<PathBuf> {
    crate::data_root(app)
        .ok()
        .map(|d| d.join(format!("quest_state.{}.json", norm_mode(mode))))
}

pub fn collected_path_for(app: &tauri::AppHandle, mode: &str) -> Option<PathBuf> {
    crate::data_root(app)
        .ok()
        .map(|d| d.join(format!("collected.{}.json", norm_mode(mode))))
}

/// 旧版单套数据迁移到 PVP（rename 后旧文件消失，重复调用无副作用）
pub fn migrate_legacy(app: &tauri::AppHandle) {
    let Ok(root) = crate::data_root(app) else {
        return;
    };
    for (old, new) in [
        ("quest_state.json", "quest_state.pvp.json"),
        ("collected.json", "collected.pvp.json"),
    ] {
        let o = root.join(old);
        let n = root.join(new);
        if o.exists() && !n.exists() {
            let _ = std::fs::rename(&o, &n);
        }
    }
}

/// 读取某个模式的数据（文件缺失/损坏即视为该模式尚未有进度）
pub fn load_mode(app: &tauri::AppHandle, mode: &str) -> ModeData {
    let m = norm_mode(mode);
    if m == "pvp" {
        migrate_legacy(app);
    }
    let mut data = ModeData::default();
    if let Some(p) = state_path_for(app, &m) {
        if let Ok(s) = std::fs::read_to_string(&p) {
            if let Ok(v) = serde_json::from_str::<ModeData>(&s) {
                data = v;
            }
        }
    }
    // 收藏进度独立文件，覆盖状态文件里的副本（以独立文件为准）
    if let Some(p) = collected_path_for(app, &m) {
        if let Ok(s) = std::fs::read_to_string(&p) {
            if let Ok(v) = serde_json::from_str::<Vec<String>>(&s) {
                data.collected = v.into_iter().collect();
            }
        }
    }
    data
}

/// 落盘某个模式的进度
pub fn save_mode(app: &tauri::AppHandle, mode: &str, data: &ModeData) {
    let m = norm_mode(mode);
    if let Some(path) = state_path_for(app, &m) {
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        if let Ok(json) = serde_json::to_string(data) {
            let _ = std::fs::write(&path, json);
        }
    }
    if let Some(path) = collected_path_for(app, &m) {
        if let Ok(json) = serde_json::to_string(&data.collected) {
            let _ = std::fs::write(&path, json);
        }
    }
}

/// 启动时载入全部模式
pub fn load_all(app: &tauri::AppHandle) -> HashMap<String, ModeData> {
    MODES
        .iter()
        .map(|m| (m.to_string(), load_mode(app, m)))
        .collect()
}

/// 全部落盘
pub fn save_all(app: &tauri::AppHandle, modes: &HashMap<String, ModeData>) {
    for (m, d) in modes.iter() {
        save_mode(app, m, d);
    }
}

/// 从 AppState 取出三套数据整体落盘（扫描后 / 改动后调用）
pub fn save_all_from(app: &tauri::AppHandle) {
    let st = app.state::<crate::AppState>();
    let g = st.modes.lock().unwrap();
    save_all(app, &g);
}

/// 删除全部模式的进度文件（「重新读取日志」重置用）
pub fn remove_all(app: &tauri::AppHandle) {
    for m in MODES {
        if let Some(p) = state_path_for(app, m) {
            let _ = std::fs::remove_file(p);
        }
    }
}
