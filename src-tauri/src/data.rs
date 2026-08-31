//! 任务图谱 / 任务详情的对外接口。
//!
//! 数据不再来自离线生成的 quest_index.json，而是由 dataset 模块从
//! tarkov.dev 原始 API JSON 在运行时构建（可被软件端刷新替换）。

use serde::Serialize;
use std::collections::HashSet;
use std::sync::Arc;

use crate::dataset;

/// 启动时装载数据集；返回失败时数据集为空（界面仍可用，只是没有任务名）
pub fn init(app: &tauri::AppHandle) {
    match dataset::rebuild(app) {
        Ok((quests, maps)) => {
            println!("[data] 数据集已装载：{quests} 个任务 / {maps} 张地图");
        }
        Err(e) => eprintln!("[data] 数据集装载失败：{e}"),
    }
}

fn store() -> Arc<dataset::Store> {
    dataset::store()
}

// —— 给前端用的结构 ——
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ItemPayload {
    pub id: String,
    pub name: String,
    pub count: Option<i64>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ObjectivePayload {
    pub description: String,
    pub items: Vec<ItemPayload>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RewardPayload {
    pub name: String,
    pub count: i64,
}

/// 商人贸易条件（level=忠诚等级 LL / reputation=好感值）
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TraderReqPayload {
    pub trader_id: String,
    pub trader_name: String,
    pub req_type: String,
    pub value: i64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphNode {
    pub id: String,
    pub name: String,
    pub trader_id: String,
    pub trader_name: String,
    pub prereqs: Vec<String>,
    pub min_level: Option<u32>,
    pub map: Option<String>,
    /// 地图展示名（官方中文）
    pub map_name: Option<String>,
    /// 任务涉及的所有地图 id（map 字段 + 目标/奖励文本提取）
    pub maps: Vec<String>,
    /// 贸易条件（商人忠诚等级/好感）
    pub trader_reqs: Vec<TraderReqPayload>,
    pub special: bool,
    /// 是否为旧任务（当前赛季已移除）
    pub legacy: bool,
    /// PVE 模式下的前置（与 prereqs 不同时非空）
    pub prereqs_pve: Vec<String>,
    /// 任务可用模式：pvp / pve
    pub modes: Vec<String>,
    /// 需要提交的物品（全部目标中出现的物品扁平化）
    pub turn_ins: Vec<ItemPayload>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphEdge {
    pub from: String,
    pub to: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QuestGraph {
    pub nodes: Vec<GraphNode>,
    pub edges: Vec<GraphEdge>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrereqInfo {
    pub id: String,
    pub name: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QuestDetail {
    pub id: String,
    pub name: String,
    pub trader_name: String,
    pub min_level: Option<u32>,
    pub wiki: String,
    pub map: Option<String>,
    /// 地图展示名（官方中文）
    pub map_name: Option<String>,
    pub objectives: Vec<ObjectivePayload>,
    pub rewards: Vec<RewardPayload>,
    pub prereqs: Vec<PrereqInfo>,
    pub trader_reqs: Vec<TraderReqPayload>,
    pub legacy: bool,
    pub special: bool,
    /// PVE 模式下的前置（与 prereqs 不同时非空）
    pub prereqs_pve: Vec<String>,
    /// 任务可用模式：pvp / pve
    pub modes: Vec<String>,
}

/// 接取事件所需信息（watcher 使用）
pub struct AcceptInfo {
    pub name: String,
    pub trader_id: String,
    pub trader_name: String,
    pub objectives: Vec<ObjectivePayload>,
    pub wiki: String,
    pub min_level: Option<u32>,
}

/// 地图展示名：优先官方中文，缺失时回退 normalizedName
pub fn map_display_name(map_id: &str) -> Option<String> {
    store().maps.get(map_id).map(|m| {
        if m.zh.is_empty() {
            m.nn.clone()
        } else {
            m.zh.clone()
        }
    })
}

/// 供前端「角色」页管理地图解锁用的全部地图列表（id + 展示名）
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MapInfo {
    pub id: String,
    pub name: String,
}

pub fn get_maps() -> Vec<MapInfo> {
    let s = store();
    let mut v: Vec<MapInfo> = s
        .maps
        .iter()
        .map(|(id, m)| MapInfo {
            id: id.clone(),
            name: if m.zh.is_empty() { m.nn.clone() } else { m.zh.clone() },
        })
        .collect();
    v.sort_by(|a, b| a.name.cmp(&b.name));
    v
}

fn trader_reqs_payload(n: &dataset::QuestNode, trader_names: &std::collections::HashMap<String, String>) -> Vec<TraderReqPayload> {
    n.trader_reqs
        .iter()
        .filter_map(|r| {
            let tid = r.trader_id.clone()?;
            Some(TraderReqPayload {
                trader_name: trader_names
                    .get(&tid)
                    .cloned()
                    .unwrap_or_else(|| tid.clone()),
                trader_id: tid,
                req_type: r.req_type.clone().unwrap_or_else(|| "level".into()),
                value: r.value.unwrap_or(0),
            })
        })
        .collect()
}

fn flatten_turn_ins(n: &dataset::QuestNode) -> Vec<ItemPayload> {
    let mut out = Vec::new();
    for o in &n.objectives {
        for it in &o.items {
            out.push(ItemPayload {
                id: it.id.clone(),
                name: it.name.clone(),
                count: it.count,
            });
        }
    }
    out
}

fn objectives_payload(n: &dataset::QuestNode) -> Vec<ObjectivePayload> {
    n.objectives
        .iter()
        .map(|o| ObjectivePayload {
            description: o.description.clone(),
            items: o
                .items
                .iter()
                .map(|it| ItemPayload {
                    id: it.id.clone(),
                    name: it.name.clone(),
                    count: it.count,
                })
                .collect(),
        })
        .collect()
}

/// 任务涉及的地图 id 列表
pub fn quest_maps(quest_id: &str) -> Vec<String> {
    store()
        .quests
        .get(quest_id)
        .map(|n| n.maps.clone())
        .unwrap_or_default()
}

pub fn resolve_accept(quest_id: &str) -> AcceptInfo {
    let s = store();
    match s.quests.get(quest_id) {
        Some(n) => AcceptInfo {
            name: n.name.clone(),
            trader_id: n.trader_id.clone(),
            trader_name: n.trader_name.clone(),
            objectives: objectives_payload(n),
            wiki: n.wiki.clone(),
            min_level: n.min_level,
        },
        None => AcceptInfo {
            name: quest_id.to_string(),
            trader_id: String::new(),
            trader_name: String::new(),
            objectives: vec![],
            wiki: format!("https://www.eftarkov.com/news/id/{quest_id}.html"),
            min_level: None,
        },
    }
}

pub fn resolve_name(quest_id: &str) -> String {
    store()
        .quests
        .get(quest_id)
        .map(|n| n.name.clone())
        .unwrap_or_else(|| quest_id.to_string())
}

/// 返回某任务的所有「传递性前置任务」（不含自身），已做环路保护。
/// 用于手动「接取 / 解锁」时沿任务链递归处理前置。
pub fn prereqs_closure(quest_id: &str) -> Vec<String> {
    let s = store();
    let mut out = Vec::new();
    let mut seen = HashSet::new();
    let mut stack: Vec<String> = s
        .quests
        .get(quest_id)
        .map(|n| n.prereqs.clone())
        .unwrap_or_default();
    while let Some(id) = stack.pop() {
        if !seen.insert(id.clone()) {
            continue;
        }
        out.push(id.clone());
        if let Some(n) = s.quests.get(&id) {
            for p in &n.prereqs {
                stack.push(p.clone());
            }
        }
    }
    out
}

/// 全量任务图谱（不含玩家状态，前端按 id 合并）。
/// 边取 pvp/pve 两套前置的并集：模式专属边的一端节点会被前端按模式隐藏，绘制时自动跳过。
pub fn get_graph() -> QuestGraph {
    let s = store();
    let mut nodes = Vec::with_capacity(s.quests.len());
    let mut edges = Vec::new();
    for (id, n) in s.quests.iter() {
        nodes.push(GraphNode {
            id: id.clone(),
            name: n.name.clone(),
            trader_id: n.trader_id.clone(),
            trader_name: n.trader_name.clone(),
            prereqs: n.prereqs.clone(),
            min_level: n.min_level,
            map: n.map.clone(),
            map_name: n.map.as_deref().and_then(map_display_name),
            maps: n.maps.clone(),
            trader_reqs: trader_reqs_payload(n, &s.trader_names),
            legacy: n.legacy,
            special: n.special,
            prereqs_pve: n.prereqs_pve.clone(),
            modes: n.modes.clone(),
            turn_ins: flatten_turn_ins(n),
        });
        for p in &n.prereqs {
            edges.push(GraphEdge {
                from: p.clone(),
                to: id.clone(),
            });
        }
        // pve 专属前置边（仅当与 pvp 前置不同）
        for p in &n.prereqs_pve {
            if !n.prereqs.contains(p) {
                edges.push(GraphEdge {
                    from: p.clone(),
                    to: id.clone(),
                });
            }
        }
    }
    QuestGraph { nodes, edges }
}

pub fn get_detail(quest_id: &str) -> Option<QuestDetail> {
    let s = store();
    let n = s.quests.get(quest_id)?;
    Some(QuestDetail {
        id: quest_id.to_string(),
        name: n.name.clone(),
        trader_name: n.trader_name.clone(),
        min_level: n.min_level,
        wiki: n.wiki.clone(),
        map: n.map.clone(),
        map_name: n.map.as_deref().and_then(map_display_name),
        objectives: objectives_payload(n),
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
        trader_reqs: trader_reqs_payload(n, &s.trader_names),
        legacy: n.legacy,
        special: n.special,
        prereqs_pve: n.prereqs_pve.clone(),
        modes: n.modes.clone(),
    })
}
