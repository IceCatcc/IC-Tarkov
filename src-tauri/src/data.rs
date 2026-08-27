use once_cell::sync::Lazy;
use serde::Deserialize;
use std::collections::HashMap;

// —— 索引原始结构（来自 resources/quest_index.json）——
#[derive(Deserialize)]
struct RawNode {
    name: String,
    trader_id: String,
    trader_name: String,
    prereqs: Vec<String>,
    #[allow(dead_code)]
    trader_reqs: Vec<RawTraderReq>,
    min_level: Option<u32>,
    map: Option<String>,
    wiki: String,
    objectives: Vec<String>,
    rewards: Vec<RawReward>,
}

#[derive(Deserialize)]
struct RawTraderReq {
    trader_id: Option<String>,
    #[allow(dead_code)]
    req_type: Option<String>,
    value: Option<i64>,
}

#[derive(Deserialize)]
struct RawReward {
    name: String,
    count: i64,
}

static INDEX: Lazy<HashMap<String, RawNode>> = Lazy::new(load_index);

// —— 给前端用的结构 ——
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphNode {
    pub id: String,
    pub name: String,
    pub trader_id: String,
    pub trader_name: String,
    pub prereqs: Vec<String>,
    pub min_level: Option<u32>,
    pub map: Option<String>,
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphEdge {
    pub from: String,
    pub to: String,
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QuestGraph {
    pub nodes: Vec<GraphNode>,
    pub edges: Vec<GraphEdge>,
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrereqInfo {
    pub id: String,
    pub name: String,
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QuestDetail {
    pub id: String,
    pub name: String,
    pub trader_name: String,
    pub min_level: Option<u32>,
    pub wiki: String,
    pub map: Option<String>,
    pub objectives: Vec<String>,
    pub rewards: Vec<RewardPayload>,
    pub prereqs: Vec<PrereqInfo>,
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RewardPayload {
    pub name: String,
    pub count: i64,
}

fn load_index() -> HashMap<String, RawNode> {
    let json = include_str!("../resources/quest_index.json");
    match serde_json::from_str(json) {
        Ok(m) => m,
        Err(e) => {
            eprintln!("quest_index parse error: {e}");
            HashMap::new()
        }
    }
}

/// 启动时强制初始化索引（尽早暴露解析错误）
pub fn load() {
    let _ = &*INDEX;
}

pub fn resolve_accept(
    quest_id: &str,
) -> (
    String,       // name
    String,       // trader_id
    String,       // trader_name
    Vec<String>,  // objectives
    Vec<(String, i64)>, // rewards
    String,       // wiki
    Option<u32>,  // min_level
) {
    match INDEX.get(quest_id) {
        Some(n) => (
            n.name.clone(),
            n.trader_id.clone(),
            n.trader_name.clone(),
            n.objectives.clone(),
            n.rewards.iter().map(|r| (r.name.clone(), r.count)).collect(),
            n.wiki.clone(),
            n.min_level,
        ),
        None => (
            quest_id.to_string(),
            String::new(),
            String::new(),
            vec![],
            vec![],
            format!("https://www.eftarkov.com/news/id/{quest_id}.html"),
            None,
        ),
    }
}

pub fn resolve_name(quest_id: &str) -> String {
    INDEX
        .get(quest_id)
        .map(|n| n.name.clone())
        .unwrap_or_else(|| quest_id.to_string())
}

/// 全量任务图谱（不含玩家状态，前端按 id 合并）
pub fn get_graph() -> QuestGraph {
    let mut nodes = Vec::with_capacity(INDEX.len());
    let mut edges = Vec::new();
    for (id, n) in INDEX.iter() {
        nodes.push(GraphNode {
            id: id.clone(),
            name: n.name.clone(),
            trader_id: n.trader_id.clone(),
            trader_name: n.trader_name.clone(),
            prereqs: n.prereqs.clone(),
            min_level: n.min_level,
            map: n.map.clone(),
        });
        for p in &n.prereqs {
            edges.push(GraphEdge {
                from: p.clone(),
                to: id.clone(),
            });
        }
    }
    QuestGraph { nodes, edges }
}

pub fn get_detail(quest_id: &str) -> Option<QuestDetail> {
    let n = INDEX.get(quest_id)?;
    Some(QuestDetail {
        id: quest_id.to_string(),
        name: n.name.clone(),
        trader_name: n.trader_name.clone(),
        min_level: n.min_level,
        wiki: n.wiki.clone(),
        map: n.map.clone(),
        objectives: n.objectives.clone(),
        rewards: n
            .rewards
            .iter()
            .map(|r| RewardPayload {
                name: r.name.clone(),
                count: r.count,
            })
            .collect(),
        prereqs: n
            .prereqs
            .iter()
            .map(|p| PrereqInfo {
                id: p.clone(),
                name: resolve_name(p),
            })
            .collect(),
    })
}
