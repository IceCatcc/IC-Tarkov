use std::collections::HashMap;

#[derive(Clone, serde::Serialize)]
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

#[derive(Default, Clone, serde::Serialize)]
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
}

pub struct QuestStore {
    pub quests: HashMap<String, QuestEntry>,
    pub activity: Vec<ActivityRow>,
    pub log_dir: String,
    pub sessions: usize,
    pub last_scan: Option<String>,
    pub error: Option<String>,
}

const ACTIVITY_CAP: usize = 800;

impl QuestStore {
    pub fn new() -> Self {
        Self {
            quests: HashMap::new(),
            activity: Vec::new(),
            log_dir: String::new(),
            sessions: 0,
            last_scan: None,
            error: None,
        }
    }

    fn push_activity(&mut self, row: ActivityRow) {
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
        self.last_scan = None;
        self.error = None;
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

    pub fn apply_progress(&mut self, endpoint: &str, ts: &str) {
        self.push_activity(ActivityRow {
            id: format!("prg|{ts}|{endpoint}"),
            ts: ts.to_string(),
            kind: "progress".into(),
            quest_id: String::new(),
            quest_name: String::new(),
            text: endpoint.into(),
            wiki: None,
        });
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
