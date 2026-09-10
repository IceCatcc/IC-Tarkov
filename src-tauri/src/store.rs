use std::collections::{HashMap, HashSet};

use serde::{Deserialize, Serialize};

#[derive(Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivityRow {
    pub id: String,
    pub ts: String,
    pub kind: String, // "accept" | "complete" | "progress"
    pub quest_id: String,
    pub quest_name: String,
    pub text: String,
    pub wiki: Option<String>,
}

#[derive(Default, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuestEntry {
    pub accepted_at: Option<String>,
    pub completed_at: Option<String>,
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlayerQuest {
    pub quest_id: String,
    pub name: String,
    pub trader_id: String,
    pub trader_name: String,
    pub accepted_at: Option<String>,
    pub completed_at: Option<String>,
    pub status: String, // "in_progress" | "completed"
    pub wiki: String,
    pub min_level: Option<u32>,
    /// 任务涉及的地图 id（normalizedName，来自任务索引）
    #[serde(default)]
    pub maps: Vec<String>,
}

// ---------------- 任务模式（PVP / PVPS / PVE） ----------------

/// 三种任务模式：PVP（常驻）/ PVPS（PvP 赛季）/ PVE。
/// 任务进度、扫描偏移、手动解锁、收藏家进度都按模式各存一份，互不干扰。
pub const MODES: [&str; 3] = ["pvp", "pvps", "pve"];

/// 规范化模式名（未知值一律回退到 pvp）
pub fn norm_mode(m: &str) -> String {
    match m.trim().to_ascii_lowercase().as_str() {
        "pvps" => "pvps".to_string(),
        "pve" => "pve".to_string(),
        _ => "pvp".to_string(),
    }
}

/// 监控状态：与任务模式无关的全局信息（日志目录、会话数、最后扫描、错误）
#[derive(Default)]
pub struct WatchStatus {
    pub log_dir: String,
    pub sessions: usize,
    pub last_scan: Option<String>,
    pub error: Option<String>,
}

/// 单个任务模式（PVP / PVPS / PVE）的全部数据，可直接序列化落盘。
/// 其中 current_map（当前所在地图）与 current_mode（会话模式）只对「正在写入的模式」有意义。
#[derive(Default, Clone, Serialize, Deserialize)]
pub struct ModeData {
    #[serde(default)]
    pub quests: HashMap<String, QuestEntry>,
    #[serde(default)]
    pub activity: Vec<ActivityRow>,
    /// 每文件扫描字节偏移（key = 文件完整路径字符串）
    #[serde(default)]
    pub offsets: HashMap<String, u64>,
    /// 手动解锁的任务集合（前置未达成但已解锁为可接取）
    #[serde(default)]
    pub unlocked: HashSet<String>,
    /// 收藏家已收集的物品 id
    #[serde(default)]
    pub collected: HashSet<String>,
    /// 当前所在地图（游戏内部 location id，如 Sandbox_start / factory4_day）
    #[serde(default)]
    pub current_map: Option<String>,
}

const ACTIVITY_CAP: usize = 800;

impl ModeData {
    pub fn new() -> Self {
        Self::default()
    }

    pub(crate) fn push_activity(&mut self, row: ActivityRow) {
        // 确定性 id 天然去重：开发热重载反复读取日志时，同一事件只记录一次
        if self.activity.iter().any(|a| a.id == row.id) {
            return;
        }
        self.activity.insert(0, row);
        if self.activity.len() > ACTIVITY_CAP {
            self.activity.truncate(ACTIVITY_CAP);
        }
    }

    /// 开始监控前清空旧数据（避免热重载/换目录后的残留与重复）
    pub fn clear(&mut self) {
        self.quests.clear();
        self.activity.clear();
    }

    pub fn apply_accept(&mut self, quest_id: &str, name: &str, ts: &str) {
        let e = self.quests.entry(quest_id.to_string()).or_default();
        e.accepted_at = Some(ts.to_string());
        self.push_activity(ActivityRow {
            id: format!("acc|{quest_id}"),
            ts: ts.to_string(),
            kind: "accept".into(),
            quest_id: quest_id.into(),
            quest_name: name.into(),
            text: format!("接取任务：{name}"),
            wiki: None,
        });
    }

    pub fn apply_complete(&mut self, quest_id: &str, name: &str, ts: &str) {
        let e = self.quests.entry(quest_id.to_string()).or_default();
        e.completed_at = Some(ts.to_string());
        self.push_activity(ActivityRow {
            id: format!("cmp|{quest_id}"),
            ts: ts.to_string(),
            kind: "complete".into(),
            quest_id: quest_id.into(),
            quest_name: name.into(),
            text: format!("完成任务：{name}"),
            wiki: None,
        });
    }

    /// 任务列表同步等进度事件：仅向前端发事件，不再计入活动流（实时/历史均不显示）
    pub fn apply_progress(&mut self, _endpoint: &str, _ts: &str) {}

    /// 更新当前所在地图；返回是否发生变化（变化时前端需要 emit map-changed）
    pub fn apply_location(&mut self, location_id: &str) -> bool {
        let changed = self.current_map.as_deref() != Some(location_id);
        if changed {
            self.current_map = Some(location_id.to_string());
        }
        changed
    }

    pub fn stats(&self) -> (u32, u32) {
        let mut in_progress = 0u32;
        let mut completed = 0u32;
        for e in self.quests.values() {
            if e.completed_at.is_some() {
                completed += 1;
            } else if e.accepted_at.is_some() {
                in_progress += 1;
            }
        }
        (in_progress, completed)
    }
}
