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
    #[serde(default)]
    maps: Vec<String>,
    wiki: String,
    objectives: Vec<RawObjective>,
    rewards: Vec<RawReward>,
    #[serde(default)]
    legacy: bool,
    #[serde(default)]
    special: bool,
}

#[derive(Deserialize)]
struct RawObjective {
    #[serde(default)]
    description: String,
    #[allow(dead_code)]
    #[serde(default)]
    r#type: String,
    #[serde(default)]
    items: Vec<RawItem>,
}

#[derive(Deserialize)]
struct RawItem {
    id: String,
    name: String,
    #[serde(default)]
    count: Option<i64>,
}

#[derive(Deserialize)]
struct RawTraderReq {
    #[allow(dead_code)]
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

// 地图元数据（缓存自 /regular/maps 与 /regular/maps_zh 端点，见 quest_analysis/gen_maps_meta.py）
#[derive(Deserialize)]
struct MapMetaFile {
    maps: HashMap<String, RawMapEntry>,
}

#[derive(Deserialize)]
struct RawMapEntry {
    nn: String,
    zh: String,
}

static MAP_META: Lazy<HashMap<String, RawMapEntry>> = Lazy::new(|| {
    match serde_json::from_str::<MapMetaFile>(include_str!("../resources/map_meta.json")) {
        Ok(f) => f.maps,
        Err(e) => {
            eprintln!("map_meta parse error: {e}");
            Default::default()
        }
    }
});

/// 地图展示名：优先官方中文，缺失时回退 normalizedName
pub fn map_display_name(map_id: &str) -> Option<String> {
    MAP_META.get(map_id).map(|m| {
        if m.zh.is_empty() {
            m.nn.clone()
        } else {
            m.zh.clone()
        }
    })
}

/// 供前端「角色」页管理地图解锁用的全部地图列表（id + 展示名）
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MapInfo {
    pub id: String,
    pub name: String,
}

pub fn get_maps() -> Vec<MapInfo> {
    let mut v: Vec<MapInfo> = MAP_META
        .iter()
        .map(|(id, m)| MapInfo {
            id: id.clone(),
            name: if m.zh.is_empty() { m.nn.clone() } else { m.zh.clone() },
        })
        .collect();
    v.sort_by(|a, b| a.name.cmp(&b.name));
    v
}

/// trader_id -> trader_name（取索引中该商人的第一个任务的名字）
static TRADER_NAMES: Lazy<HashMap<String, String>> = Lazy::new(|| {
    let mut m = HashMap::new();
    for n in INDEX.values() {
        m.entry(n.trader_id.clone())
            .or_insert_with(|| n.trader_name.clone());
    }
    m
});

fn trader_reqs_payload(n: &RawNode) -> Vec<TraderReqPayload> {
    n.trader_reqs
        .iter()
        .filter_map(|r| {
            let tid = r.trader_id.clone()?;
            Some(TraderReqPayload {
                trader_name: TRADER_NAMES
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

// —— 给前端用的结构 ——
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ItemPayload {
    pub id: String,
    pub name: String,
    pub count: Option<i64>,
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ObjectivePayload {
    pub description: String,
    pub items: Vec<ItemPayload>,
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RewardPayload {
    pub name: String,
    pub count: i64,
}

/// 商人贸易条件（level=忠诚等级 LL / reputation=好感值）
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TraderReqPayload {
    pub trader_id: String,
    pub trader_name: String,
    pub req_type: String,
    pub value: i64,
}

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
    /// 地图展示名（官方中文）
    pub map_name: Option<String>,
    /// 任务涉及的所有地图 id（map 字段 + 目标/奖励文本提取）
    pub maps: Vec<String>,
    /// 贸易条件（商人忠诚等级/好感）
    pub trader_reqs: Vec<TraderReqPayload>,
    pub special: bool,
    /// 是否为旧任务（当前赛季已移除）
    pub legacy: bool,
    /// 需要提交的物品（全部目标中出现的物品扁平化）
    pub turn_ins: Vec<ItemPayload>,
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
    /// 地图展示名（官方中文）
    pub map_name: Option<String>,
    pub objectives: Vec<ObjectivePayload>,
    pub rewards: Vec<RewardPayload>,
    pub prereqs: Vec<PrereqInfo>,
    pub trader_reqs: Vec<TraderReqPayload>,
    pub legacy: bool,
    pub special: bool,
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

fn flatten_turn_ins(n: &RawNode) -> Vec<ItemPayload> {
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

fn objectives_payload(n: &RawNode) -> Vec<ObjectivePayload> {
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

pub fn resolve_accept(quest_id: &str) -> AcceptInfo {
    match INDEX.get(quest_id) {
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
    INDEX
        .get(quest_id)
        .map(|n| n.name.clone())
        .unwrap_or_else(|| quest_id.to_string())
}

/// 返回某任务的所有「传递性前置任务」（不含自身），已做环路保护。
/// 用于手动「接取 / 解锁」时沿任务链递归处理前置。
pub fn prereqs_closure(quest_id: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut seen = std::collections::HashSet::new();
    let mut stack: Vec<String> = INDEX
        .get(quest_id)
        .map(|n| n.prereqs.clone())
        .unwrap_or_default();
    while let Some(id) = stack.pop() {
        if !seen.insert(id.clone()) {
            continue;
        }
        out.push(id.clone());
        if let Some(n) = INDEX.get(&id) {
            for p in &n.prereqs {
                stack.push(p.clone());
            }
        }
    }
    out
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
            map_name: n.map.as_deref().and_then(map_display_name),
            maps: n.maps.clone(),
            trader_reqs: trader_reqs_payload(n),
            legacy: n.legacy,
            special: n.special,
            turn_ins: flatten_turn_ins(n),
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
        trader_reqs: trader_reqs_payload(n),
        legacy: n.legacy,
        special: n.special,
    })
}
