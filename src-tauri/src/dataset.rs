//! 由 tarkov.dev 原始 API JSON 派生的运行时数据集。
//!
//! 原始 JSON 只做「读进来 + 建索引」，所有派生结构（任务索引、地图元数据、
//! 地图标记、任务区域、Boss 刷新率）都在这里构建，替代原先离线脚本生成的
//! quest_index.json / map_meta.json / map-markers.json / quest-zones.json /
//! map-bosses.json。数据更新只需替换缓存里的原始 JSON 后重新 build 一次。

use serde_json::{Map, Value};
use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::{Arc, OnceLock, RwLock};

use crate::apidata;

const EMPTY_ARR: &[Value] = &[];

// ---------------- 派生结构 ----------------

#[derive(Clone)]
pub struct MapEntry {
    /// normalizedName（如 customs）
    pub nn: String,
    /// 官方中文名，缺失时为空
    pub zh: String,
}

#[derive(Clone)]
pub struct ItemRef {
    pub id: String,
    pub name: String,
    pub count: Option<i64>,
    /// 是否必须在战局内拾取（目标级 foundInRaid，收藏家类任务全为 true）
    pub found_in_raid: bool,
    /// 物品主类型中文名（如「医疗」「钥匙」）；数据包缺少物品类别文件时为空
    pub category: Option<String>,
}

#[derive(Clone)]
pub struct Objective {
    /// 目标 id（上游 objective id；缺失时用「任务id#序号」兜底），用于单独标记目标完成
    pub id: String,
    pub description: String,
    pub items: Vec<ItemRef>,
}

#[derive(Clone)]
pub struct Reward {
    pub name: String,
    pub count: i64,
}

#[derive(Clone)]
pub struct TraderReq {
    pub trader_id: Option<String>,
    pub req_type: Option<String>,
    pub value: Option<i64>,
    /// 比较方式（compareMethod）：>= / <= / < / > 等。
    /// 不能一律按「≥」判定——例如 Fence 的「亡羊补牢」系列要求好感 **小于** 阈值。
    pub compare: Option<String>,
}

#[derive(Clone)]
pub struct QuestNode {
    pub name: String,
    pub trader_id: String,
    pub trader_name: String,
    pub prereqs: Vec<String>,
    /// PVE 模式下的前置（与 prereqs 不同时才非空）
    pub prereqs_pve: Vec<String>,
    pub trader_reqs: Vec<TraderReq>,
    pub min_level: Option<u32>,
    pub map: Option<String>,
    /// 任务涉及的所有地图 id（map 字段 + 目标/奖励文本提取）
    pub maps: Vec<String>,
    pub wiki: String,
    pub objectives: Vec<Objective>,
    pub rewards: Vec<Reward>,
    /// 旧任务（不在当前赛季任务列表中）
    pub legacy: bool,
    pub special: bool,
    /// 可用模式：pvp / pve
    pub modes: Vec<String>,
    /// 转生（Prestige）等级：该任务是第 N 次转生的门槛任务时为 Some(N)
    pub prestige_level: Option<u32>,
    /// 互斥任务：这些任务「已完成」时本任务即失败（上游 failConditions 里的 taskStatus/complete，
    /// 如海关的「大客户」「化学品-4」三选一，交了其中一个另外两个就失败）
    pub fail_on_done: Vec<String>,
}

/// 全部派生数据；整体不可变，更新时整体替换
pub struct Store {
    pub quests: HashMap<String, QuestNode>,
    pub maps: HashMap<String, MapEntry>,
    /// trader_id -> 商人中文名
    pub trader_names: HashMap<String, String>,
    /// 地图标记（等价原 public/data/map-markers.json）
    pub markers: Value,
    /// 任务目标区域（等价原 public/data/quest-zones.json）
    pub zones: Value,
    /// Boss 刷新率（等价原 public/data/map-bosses.json）
    pub bosses: Value,
    /// 地图骨架（随包分发，运行时补中文名）
    pub skeleton: Value,
    /// 反向索引：任务 id -> 「因它完成而失败」的任务 id 列表（互斥任务，由 fail_on_done 反推）
    pub fail_map: HashMap<String, Vec<String>>,
}

impl Store {
    fn empty() -> Self {
        Store {
            quests: HashMap::new(),
            maps: HashMap::new(),
            trader_names: HashMap::new(),
            markers: Value::Object(Map::new()),
            zones: Value::Object(Map::new()),
            bosses: Value::Object(Map::new()),
            skeleton: Value::Object(Map::new()),
            fail_map: HashMap::new(),
        }
    }
}

static STORE: OnceLock<RwLock<Arc<Store>>> = OnceLock::new();

pub fn store() -> Arc<Store> {
    STORE
        .get_or_init(|| RwLock::new(Arc::new(Store::empty())))
        .read()
        .unwrap()
        .clone()
}

fn install(s: Store) {
    *STORE
        .get_or_init(|| RwLock::new(Arc::new(Store::empty())))
        .write()
        .unwrap() = Arc::new(s);
}

// ---------------- JSON 小工具 ----------------

fn s<'a>(v: &'a Value, k: &str) -> Option<&'a str> {
    v.get(k).and_then(|x| x.as_str())
}

fn arr<'a>(v: &'a Value, k: &str) -> &'a [Value] {
    v.get(k)
        .and_then(|x| x.as_array())
        .map(|a| a.as_slice())
        .unwrap_or(EMPTY_ARR)
}

fn obj_map<'a>(v: &'a Value, k: &str) -> Option<&'a Map<String, Value>> {
    v.get(k).and_then(|x| x.as_object())
}

fn num(v: Option<&Value>) -> Value {
    match v {
        Some(x) if x.is_number() => x.clone(),
        _ => Value::Null,
    }
}

/// 数字或字符串原样保留（地图 players 字段形如 "10-14"）
fn num_or_str(v: Option<&Value>) -> Value {
    match v {
        Some(x) if x.is_number() || x.is_string() => x.clone(),
        _ => Value::Null,
    }
}

fn pos_val(v: Option<&Value>) -> Value {
    match v {
        Some(p) if p.is_object() => serde_json::json!({
            "x": p.get("x").and_then(|n| n.as_f64()).unwrap_or(0.0),
            "y": p.get("y").and_then(|n| n.as_f64()).unwrap_or(0.0),
            "z": p.get("z").and_then(|n| n.as_f64()).unwrap_or(0.0),
        }),
        _ => Value::Null,
    }
}

// ---------------- 原始数据 ----------------

pub struct Raw {
    pub tasks_regular: HashMap<String, Value>,
    pub tasks_pve: HashMap<String, Value>,
    pub tasks_season: HashMap<String, Value>,
    /// 转生档位（data.prestige 数组：每档 conditions 里带 taskStatus 门槛任务）
    pub prestige: Vec<Value>,
    pub zh_tasks: HashMap<String, String>,
    pub zh_tasks_pve: HashMap<String, String>,
    pub maps: HashMap<String, Value>,
    pub mobs: HashMap<String, Value>,
    pub loot_containers: HashMap<String, Value>,
    pub stationary_weapons: HashMap<String, Value>,
    pub zh_maps: HashMap<String, String>,
    pub traders: HashMap<String, Value>,
    pub zh_traders: HashMap<String, String>,
    pub zh_items: HashMap<String, String>,
    /// 物品 id -> 主类型中文名（来自 items 的 types 字段；数据包缺少该文件时为空）
    pub item_types: HashMap<String, String>,
}

fn read_json(dir: &Path, file: &str) -> Result<Value, String> {
    let p = dir.join(file);
    let text = std::fs::read_to_string(&p).map_err(|e| format!("读取 {} 失败：{e}", file))?;
    serde_json::from_str(&text).map_err(|e| format!("解析 {} 失败：{e}", file))
}

fn as_str_map(v: &Value) -> HashMap<String, String> {
    let mut out = HashMap::new();
    if let Some(o) = v.as_object() {
        for (k, val) in o {
            if let Some(t) = val.as_str() {
                out.insert(k.clone(), t.to_string());
            }
        }
    }
    out
}

fn as_val_map(v: Option<&Value>) -> HashMap<String, Value> {
    let mut out = HashMap::new();
    if let Some(o) = v.and_then(|x| x.as_object()) {
        for (k, val) in o {
            out.insert(k.clone(), val.clone());
        }
    }
    out
}

impl Raw {
    pub fn from_dir(dir: &Path) -> Result<Raw, String> {
        let tasks_doc = read_json(dir, "regular_tasks.json")?;
        let pve_doc = read_json(dir, "pve_tasks.json")?;
        let season_doc = read_json(dir, "season_tasks.json")?;
        let zh_tasks_doc = read_json(dir, "regular_tasks_zh.json")?;
        let zh_tasks_pve_doc = read_json(dir, "pve_tasks_zh.json")?;
        let maps_doc = read_json(dir, "regular_maps.json")?;
        let zh_maps_doc = read_json(dir, "regular_maps_zh.json")?;
        let traders_doc = read_json(dir, "regular_traders.json")?;
        let zh_traders_doc = read_json(dir, "regular_traders_zh.json")?;
        let zh_items_doc = read_json(dir, "regular_items_zh.json")?;
        // 物品类别：可选数据（老数据包没有该文件时不报错，仅「按类型排序」退化）
        let item_types = read_json(dir, "regular_items.json")
            .ok()
            .map(|doc| build_item_types(&doc))
            .unwrap_or_default();

        let maps_data = maps_doc.get("data").cloned().unwrap_or(Value::Null);

        Ok(Raw {
            tasks_regular: as_val_map(obj_map(&tasks_doc, "data").and_then(|d| d.get("tasks"))),
            tasks_pve: as_val_map(obj_map(&pve_doc, "data").and_then(|d| d.get("tasks"))),
            tasks_season: as_val_map(obj_map(&season_doc, "data").and_then(|d| d.get("tasks"))),
            prestige: tasks_doc
                .pointer("/data/prestige")
                .and_then(|v| v.as_array())
                .cloned()
                .unwrap_or_default(),
            zh_tasks: as_str_map(zh_tasks_doc.get("data").unwrap_or(&Value::Null)),
            zh_tasks_pve: as_str_map(zh_tasks_pve_doc.get("data").unwrap_or(&Value::Null)),
            maps: as_val_map(maps_data.get("maps")),
            mobs: as_val_map(maps_data.get("mobs")),
            loot_containers: as_val_map(maps_data.get("lootContainers")),
            stationary_weapons: as_val_map(maps_data.get("stationaryWeapons")),
            zh_maps: as_str_map(zh_maps_doc.get("data").unwrap_or(&Value::Null)),
            traders: as_val_map(traders_doc.get("data")),
            zh_traders: as_str_map(zh_traders_doc.get("data").unwrap_or(&Value::Null)),
            zh_items: as_str_map(zh_items_doc.get("data").unwrap_or(&Value::Null)),
            item_types,
        })
    }
}

// ---------------- 任务索引 ----------------

/// 特殊商人（无常规任务链）
const SPECIAL_TRADERS: &[&str] = &[
    "fence",
    "lightkeeper",
    "btr-driver",
    "ref",
    "mr-kerman",
    "voevoda",
    "taran",
    "radio-station",
    "survivor",
];

/// 任务文本里出现、但 map_meta 中没有对应中文/英文名的地图别名
const EXTRA_NAMES: &[(&str, &str)] = &[
    ("塔科夫街区", "5714dc692459777137212e12"),
    ("街区", "5714dc692459777137212e12"),
    ("储备站", "5704e5fad2720bc05b8b4567"),
    ("实验室", "5b0fc42d86f7744a585f9105"),
    ("中心区", "653e6760052c01c1c805532f"),
    ("中心区 21+", "65b8d6f5cdde2479cb2a3125"),
    ("夜间工厂", "59fc81d786f774390775787e"),
    ("破冰船", "69af492a4819ea4ba10a69c5"),
    ("码头", "65cc8f81a9aac3e77d0cfd3e"),
    ("迷宫", "6733700029c367a3d40b02af"),
    ("streets-of-tarkov", "5714dc692459777137212e12"),
    ("streets", "5714dc692459777137212e12"),
    ("reserve", "5704e5fad2720bc05b8b4567"),
    ("the-lab", "5b0fc42d86f7744a585f9105"),
    ("ground-zero", "653e6760052c01c1c805532f"),
    ("ground-zero-21", "65b8d6f5cdde2479cb2a3125"),
    ("night-factory", "59fc81d786f774390775787e"),
    ("icebreaker", "69af492a4819ea4ba10a69c5"),
    ("terminal", "65cc8f81a9aac3e77d0cfd3e"),
    ("labyrinth", "6733700029c367a3d40b02af"),
];

const ROUBLES_ID: &str = "5449016a4bdc2d6f028b456f";

/// 无独立官方底图的地图变体（location id -> 归并到哪张图）
const NAME_ID_FALLBACK: &[(&str, &str)] = &[
    ("Sandbox_start", "ground-zero"),
    ("Sandbox_high", "ground-zero"),
    ("factory4_night", "factory"),
    ("laboratory_dark", "the-lab"),
];

/// 任务区域按底图归并（无独立底图的变体）
const NN_MERGE: &[(&str, &str)] = &[
    ("ground-zero-21", "ground-zero"),
    ("ground-zero-tutorial", "ground-zero"),
    ("night-factory", "factory"),
    ("the-lab-dark", "the-lab"),
];

fn item_name(raw: &Raw, id: &str) -> String {
    raw.zh_items
        .get(&format!("{id} Name"))
        .cloned()
        .unwrap_or_else(|| id.to_string())
}

/// 物品类型（tarkov.dev 的 `types` 标签）-> 中文名。
/// 只收录常见类型；未收录的标签不参与分类（前端归入「其它」）。
const ITEM_TYPE_ZH: &[(&str, &str)] = &[
    ("gun", "武器"),
    ("melee", "近战武器"),
    ("knife", "近战武器"),
    ("ammo", "弹药"),
    ("ammoBox", "弹药"),
    ("magazine", "弹匣"),
    ("mods", "武器配件"),
    ("grenade", "投掷物"),
    ("throwable", "投掷物"),
    ("armor", "护甲"),
    ("rig", "胸挂"),
    ("backpack", "背包"),
    ("headwear", "头盔"),
    ("visor", "头盔"),
    ("meds", "医疗"),
    ("injectors", "医疗"),
    ("provisions", "食物与饮料"),
    ("keys", "钥匙"),
    ("keyMechanical", "钥匙"),
    ("map", "地图"),
    ("info", "情报"),
    ("dogtag", "狗牌"),
    ("questItem", "任务物品"),
    ("barter", "交易品"),
    ("mobility", "工具"),
    ("tools", "工具"),
    ("electronics", "电子"),
    ("household", "家用品"),
    ("specialSlot", "特殊物品"),
];

fn item_type_zh(t: &str) -> Option<&'static str> {
    ITEM_TYPE_ZH
        .iter()
        .find(|(k, _)| *k == t)
        .map(|(_, v)| *v)
}

/// 从 items 数据里提取「物品 id -> 主类型中文名」。
/// 一件物品可能有多个 types（如护甲同时是 rig），取第一个能映射到中文的标签。
fn build_item_types(doc: &Value) -> HashMap<String, String> {
    let mut out = HashMap::new();
    let Some(items) = doc.pointer("/data/items").and_then(|v| v.as_object()) else {
        return out;
    };
    for (id, it) in items {
        let Some(types) = it.get("types").and_then(|v| v.as_array()) else {
            continue;
        };
        for t in types.iter().filter_map(|x| x.as_str()) {
            if let Some(zh) = item_type_zh(t) {
                out.insert(id.clone(), zh.to_string());
                break;
            }
        }
    }
    out
}

fn trader_name(raw: &Raw, trader_id: &str) -> String {
    let entry = match raw.traders.get(trader_id) {
        Some(e) => e,
        None => return trader_id.to_string(),
    };
    let key = s(entry, "name").unwrap_or("");
    if let Some(zh) = raw.zh_traders.get(key) {
        if !zh.trim().is_empty() {
            return zh.trim().to_string();
        }
    }
    s(entry, "normalizedName")
        .unwrap_or(trader_id)
        .to_string()
}

fn build_map_meta(raw: &Raw) -> HashMap<String, MapEntry> {
    raw.maps
        .iter()
        .map(|(id, m)| {
            let nn = s(m, "normalizedName").unwrap_or("").to_string();
            let zh = raw
                .zh_maps
                .get(&format!("{id} Name"))
                .cloned()
                .unwrap_or_default();
            (id.clone(), MapEntry { nn, zh })
        })
        .collect()
}

fn build_quests(raw: &Raw, maps: &HashMap<String, MapEntry>) -> HashMap<String, QuestNode> {
    // 1) 商人忠诚等级全局变量 -> 商人（上游把这些条件放在 otherRequirements 里）
    let mut var_to_trader: HashMap<String, String> = HashMap::new();
    for src in [&raw.tasks_regular, &raw.tasks_season] {
        for t in src.values() {
            let Some(trd) = s(t, "trader") else { continue };
            for o in arr(t, "otherRequirements") {
                if s(o, "type") == Some("globalVariable") {
                    if let Some(vid) = s(o, "variableId") {
                        var_to_trader
                            .entry(vid.to_string())
                            .or_insert_with(|| trd.to_string());
                    }
                }
            }
        }
    }

    // 1b) 转生（Prestige）等级 -> 门槛任务：data.prestige[] 每档 conditions 里
    //     type=taskStatus 的任务即该档的门槛任务。同一任务出现在多档时取最低档
    //     （玩家最早可达成的转生等级）。
    let mut prestige_of: HashMap<String, u32> = HashMap::new();
    {
        let mut entries: Vec<&Value> = raw.prestige.iter().collect();
        entries.sort_by_key(|p| p.get("prestigeLevel").and_then(|v| v.as_u64()).unwrap_or(0));
        for p in entries {
            let Some(lv) = p.get("prestigeLevel").and_then(|v| v.as_u64()) else {
                continue;
            };
            for c in arr(p, "conditions") {
                if s(c, "type") != Some("taskStatus") {
                    continue;
                }
                if let Some(tid) = s(c, "task") {
                    prestige_of.entry(tid.to_string()).or_insert(lv as u32);
                }
            }
        }
    }

    // 2) 任务文本中提取地图用的名称表（长名优先，避免子串误吞）
    let mut map_names: Vec<(String, String)> = Vec::new();
    for (id, e) in maps {
        if !e.zh.is_empty() {
            map_names.push((e.zh.clone(), id.clone()));
        }
        if !e.nn.is_empty() {
            map_names.push((e.nn.clone(), id.clone()));
        }
    }
    for (name, id) in EXTRA_NAMES {
        map_names.push((name.to_string(), id.to_string()));
    }
    map_names.sort_by(|a, b| b.0.chars().count().cmp(&a.0.chars().count()));
    let map_names: Vec<(String, String)> = map_names
        .into_iter()
        .map(|(n, id)| (n.to_lowercase(), id))
        .collect();

    let mut index: HashMap<String, QuestNode> = HashMap::new();

    // 3) regular 集合：PVP 与 PVPS 的任务集完全相同（两者只有进度数据独立），
    //    同时出现在 PVE 集合里的任务也属于 PVE
    for (qid, t) in &raw.tasks_regular {
        let mut modes = vec!["pvp".to_string(), "pvps".to_string()];
        if raw.tasks_pve.contains_key(qid) {
            modes.push("pve".to_string());
        }
        index.insert(
            qid.clone(),
            build_one(raw, qid, t, &raw.zh_tasks, &modes, &var_to_trader, &map_names, &prestige_of),
        );
    }
    // 4) PVE 独有任务
    for (qid, t) in &raw.tasks_pve {
        if raw.tasks_regular.contains_key(qid) {
            continue;
        }
        index.insert(
            qid.clone(),
            build_one(raw, qid, t, &raw.zh_tasks_pve, &["pve".to_string()], &var_to_trader, &map_names, &prestige_of),
        );
    }
    // 4b) 赛季独有任务（不在 PVP 常驻集合里）
    for (qid, t) in &raw.tasks_season {
        if raw.tasks_regular.contains_key(qid) {
            continue;
        }
        let mut modes = vec!["pvps".to_string()];
        if raw.tasks_pve.contains_key(qid) {
            modes.push("pve".to_string());
        }
        index.insert(
            qid.clone(),
            build_one(raw, qid, t, &raw.zh_tasks, &modes, &var_to_trader, &map_names, &prestige_of),
        );
    }
    // 5) 共有任务在 PVE 下前置不同时单独存一份
    for qid in raw
        .tasks_regular
        .keys()
        .filter(|k| raw.tasks_pve.contains_key(*k))
    {
        let pp: Vec<String> = arr(&raw.tasks_pve[qid], "taskRequirements")
            .iter()
            .filter_map(|r| s(r, "task").map(|v| v.to_string()))
            .collect();
        if let Some(node) = index.get_mut(qid) {
            if pp != node.prereqs {
                node.prereqs_pve = pp;
            }
        }
    }
    index
}

fn build_one(
    raw: &Raw,
    qid: &str,
    t: &Value,
    zh: &HashMap<String, String>,
    modes: &[String],
    var_to_trader: &HashMap<String, String>,
    map_names: &[(String, String)],
    prestige_of: &HashMap<String, u32>,
) -> QuestNode {
    let tz = |key: &str| -> String {
        match zh.get(key) {
            Some(v) => v.clone(),
            None => key.to_string(),
        }
    };

    let prereqs: Vec<String> = arr(t, "taskRequirements")
        .iter()
        .filter_map(|r| s(r, "task").map(|v| v.to_string()))
        .collect();

    // 商人条件：traderRequirements + otherRequirements 中的忠诚等级全局变量
    let mut trader_reqs: Vec<TraderReq> = Vec::new();
    for r in arr(t, "traderRequirements") {
        trader_reqs.push(TraderReq {
            trader_id: s(r, "trader").map(|v| v.to_string()),
            req_type: Some(s(r, "requirementType").unwrap_or("level").to_string()),
            value: r.get("value").and_then(|v| v.as_i64()),
            compare: s(r, "compareMethod").map(|v| v.to_string()),
        });
    }
    for o in arr(t, "otherRequirements") {
        if s(o, "type") != Some("globalVariable") {
            continue;
        }
        if let Some(trd) = s(o, "variableId").and_then(|v| var_to_trader.get(v)) {
            trader_reqs.push(TraderReq {
                trader_id: Some(trd.clone()),
                // 这里的 value 是全局变量阈值，不等于忠诚等级数字，仅作「存在额外商人条件」提示
                req_type: Some("variable".to_string()),
                value: o.get("value").and_then(|v| v.as_i64()),
                compare: s(o, "compareMethod").map(|v| v.to_string()),
            });
        }
    }
    // 去重（商人 + 类型 + 值）
    let mut seen: Vec<(String, String, Option<i64>)> = Vec::new();
    trader_reqs.retain(|r| {
        let key = (
            r.trader_id.clone().unwrap_or_default(),
            r.req_type.clone().unwrap_or_default(),
            r.value,
        );
        if seen.contains(&key) {
            false
        } else {
            seen.push(key);
            true
        }
    });

    let rewards: Vec<Reward> = t
        .get("finishRewards")
        .and_then(|v| v.get("items"))
        .and_then(|v| v.as_array())
        .map(|a| a.as_slice())
        .unwrap_or(EMPTY_ARR)
        .iter()
        .map(|it| Reward {
            name: item_name(raw, s(it, "item").unwrap_or("")),
            count: it.get("count").and_then(|v| v.as_i64()).unwrap_or(0),
        })
        .collect();

    let mut objectives: Vec<Objective> = Vec::new();
    for (oi, o) in arr(t, "objectives").iter().enumerate() {
        // 上游 objective 的 description 字段值即目标 id（中文化靠 zh 映射表按该 id 查）
        let raw_desc = s(o, "description").unwrap_or("");
        let desc = tz(raw_desc);
        if desc.is_empty() {
            continue;
        }
        let oid = match s(o, "id") {
            Some(x) if !x.is_empty() => x.to_string(),
            _ if !raw_desc.is_empty() => raw_desc.to_string(),
            _ => format!("{qid}#{oi}"),
        };
        let count = o.get("count").and_then(|v| v.as_i64());
        // 目标级「必须战局内找到」标记（foundInRaid），上传类任务据此提示玩家
        let found_in_raid = o.get("foundInRaid").and_then(|v| v.as_bool()).unwrap_or(false);
        let items = arr(o, "items")
            .iter()
            .filter_map(|v| v.as_str())
            .map(|iid| ItemRef {
                id: iid.to_string(),
                name: item_name(raw, iid),
                count,
                found_in_raid,
                category: raw.item_types.get(iid).cloned(),
            })
            .collect();
        objectives.push(Objective {
            id: oid,
            description: desc,
            items,
        });
    }

    // 涉及地图：官方 map 字段 + 目标/奖励文本
    let mut texts: Vec<String> = Vec::new();
    for o in arr(t, "objectives") {
        if let Some(d) = s(o, "description") {
            texts.push(tz(d));
        }
        if let Some(m) = s(o, "map") {
            texts.push(m.to_string());
        }
    }
    for it in rewards.iter() {
        texts.push(it.name.clone());
    }
    texts.push(tz(s(t, "name").unwrap_or("")));
    let text = texts.join(" ").to_lowercase();
    let mut maps_found: Vec<String> = Vec::new();
    if let Some(m) = s(t, "map") {
        maps_found.push(m.to_string());
    }
    for (name, id) in map_names {
        if text.contains(name.as_str()) && !maps_found.contains(id) {
            maps_found.push(id.clone());
        }
    }
    maps_found.sort();

    let trader_id = s(t, "trader").unwrap_or("").to_string();
    let main_map = s(t, "map")
        .map(|v| v.to_string())
        .or_else(|| maps_found.first().cloned());

    let trader_norm = raw
        .traders
        .get(&trader_id)
        .and_then(|e| s(e, "normalizedName"))
        .unwrap_or("")
        .to_string();

    // 互斥任务：failConditions 里「某任务达到 complete」= 交了那个任务本任务就失败
    let mut fail_on_done: Vec<String> = Vec::new();
    for fc in arr(t, "failConditions") {
        if s(fc, "type") != Some("taskStatus") {
            continue;
        }
        let completed_cond = fc
            .get("status")
            .and_then(|v| v.as_array())
            .map(|a| a.iter().any(|x| x.as_str() == Some("complete")))
            .unwrap_or(false);
        if !completed_cond {
            continue;
        }
        if let Some(other) = s(fc, "task") {
            if !other.is_empty() && !fail_on_done.iter().any(|x| x == other) {
                fail_on_done.push(other.to_string());
            }
        }
    }

    QuestNode {
        name: tz(s(t, "name").unwrap_or("")),
        trader_id: trader_id.clone(),
        trader_name: trader_name(raw, &trader_id),
        prereqs,
        prereqs_pve: Vec::new(),
        trader_reqs,
        min_level: t.get("minPlayerLevel").and_then(|v| v.as_u64()).map(|v| v as u32),
        map: main_map,
        maps: maps_found,
        wiki: format!("https://www.eftarkov.com/news/id/{qid}.html"),
        objectives,
        rewards,
        // 转生（Prestige）任务不算「往期赛季任务」：上游 pvp-season 列表并未收录全部转生任务
        // （转生 2/3/4 就不在其中），按原判定会被当作旧任务而默认隐藏，这里显式排除。
        legacy: !raw.tasks_season.contains_key(qid) && prestige_of.get(qid).is_none(),
        special: SPECIAL_TRADERS.contains(&trader_norm.as_str()),
        modes: modes.to_vec(),
        prestige_level: prestige_of.get(qid).copied(),
        fail_on_done,
    }
}

// ---------------- 地图标记 ----------------

fn zh_of(raw: &Raw, candidates: &[Option<&str>]) -> Option<String> {
    for c in candidates.iter().flatten() {
        if let Some(v) = raw.zh_maps.get(*c) {
            if !v.trim().is_empty() {
                return Some(v.trim().to_string());
            }
        }
    }
    None
}

/// 开关 / 拉杆（switches）的中文名。
/// 上游 zh_maps 里 switch 条目存的其实是「英文可读名」（如 Med Elevator Power Button），
/// 没有中文；这里按那个英文名补一份手工翻译。查不到时保留英文原名（新开关也不会变「未命名」）。
const SWITCH_ZH: &[(&str, &str)] = &[
    ("ZB-013 Power Switch", "ZB-013 电源开关"),
    ("Lightkeeper Switch", "灯塔守护者开关"),
    ("Bunker Hermetic Door Power Switch", "地堡密封门电源开关"),
    ("D-2 Power Switch", "D-2 电源开关"),
    ("D-2 Door Switch", "D-2 门开关"),
    ("Mall Main Power Switch", "商场主电源开关"),
    ("Non-Kiba Alarms Switch", "非 Kiba 警报开关"),
    ("Alarms Switch", "警报开关"),
    ("Alarm Switch", "警报开关"),
    ("Saferoom Exfil Switch", "保险室撤离开关"),
    ("Saferoom Exfil Unlock Switch", "保险室撤离解锁开关"),
    ("Object 14 Container Switch", "14 号设施集装箱开关"),
    ("Med Elevator Power Button", "医疗区电梯电源按钮"),
    ("Med Elevator Call Button", "医疗区电梯呼叫按钮"),
    ("Med Elevator Extract Button", "医疗区电梯撤离按钮"),
    ("Main Elevator Power Button", "主电梯电源按钮"),
    ("Main Elevator Call Button", "主电梯呼叫按钮"),
    ("Main Elevator Extract Button", "主电梯撤离按钮"),
    ("Cargo Elevator Power Button", "货运电梯电源按钮"),
    ("Cargo Elevator Call Button", "货运电梯呼叫按钮"),
    ("Cargo Elevator Extract Button", "货运电梯撤离按钮"),
    ("Hangar Gate Switch", "机库闸门开关"),
    ("Parking Gate Switch", "停车场闸门开关"),
    ("Water Level Switch", "水位开关"),
    ("Sewage Conduit Pump Button", "污水管道水泵按钮"),
    ("Containment Block Power Switch", "隔离区电源开关"),
    ("Sealed Door", "密封门"),
    ("Fire Trap Switch", "火焰陷阱开关"),
    ("Toxic Pool Trap Switch", "毒池陷阱开关"),
    ("Toxic Puddle Trap Switch", "毒水洼陷阱开关"),
    ("Shotgun Trap Switch", "霰弹枪陷阱开关"),
    ("Steam Trap Switch", "蒸汽陷阱开关"),
];

fn switch_zh(name_en: &str) -> Option<String> {
    let key = name_en.trim();
    if key.is_empty() {
        return None;
    }
    SWITCH_ZH
        .iter()
        .find(|(k, _)| k.eq_ignore_ascii_case(key))
        .map(|(_, v)| v.to_string())
}

fn entry_val(e: &Value, raw: &Raw) -> Value {
    let name = s(e, "name");
    let name_zh = name.and_then(|n| zh_of(raw, &[Some(n)]));
    let mut m = Map::new();
    m.insert(
        "id".into(),
        s(e, "id").map(|v| Value::String(v.to_string())).unwrap_or(Value::Null),
    );
    m.insert(
        "name".into(),
        name.map(|v| Value::String(v.to_string())).unwrap_or(Value::Null),
    );
    m.insert(
        "nameZh".into(),
        name_zh.map(Value::String).unwrap_or(Value::Null),
    );
    // 坐标：多数集合用嵌套的 position 对象，但部分集合（如 btrStops）是扁平的 x / y / z。
    // 缺少回退时这些标记会因 position 为 null 被前端整条跳过（BTR 勾选后不显示的根因）。
    let pos_src = match e.get("position") {
        Some(p) if p.is_object() => Some(p.clone()),
        _ => {
            if e.get("x").is_some() && e.get("z").is_some() {
                Some(e.clone())
            } else {
                None
            }
        }
    };
    m.insert("position".into(), pos_val(pos_src.as_ref()));
    m.insert("top".into(), num(e.get("top")));
    m.insert("bottom".into(), num(e.get("bottom")));
    // zoneName：狙击 AI 的唯一可靠标识——数据中它们的 categories 仅为 ["bot"]，
    // 是靠 zoneName 里的 Snipe/Sniper 区分的（如海关 ZoneSnipeTower、中心区 ZoneSandSnipeCenter）
    m.insert(
        "zoneName".into(),
        s(e, "zoneName")
            .map(|v| Value::String(v.to_string()))
            .unwrap_or(Value::Null),
    );
    Value::Object(m)
}

/// 撤离要求：开关 / 付费 / 提交物品。
/// `ignore_switch`：上游脏数据兜底——整张图所有撤离点共用同一个开关 id 时传 true，
/// 一律视为不需要开关（2026-09 起 json.tarkov.dev 曾把海关/实验室全部撤离点填成同一开关 id）。
fn extract_requirements(x: &Value, zh_items: &HashMap<String, String>, ignore_switch: bool) -> Vec<Value> {
    let mut reqs: Vec<Value> = Vec::new();
    // switch 字段可能是布尔，也可能是开关 id（非空字符串），两者都表示「需要先开开关」
    let needs_switch = !ignore_switch
        && match x.get("switch") {
            Some(Value::Bool(b)) => *b,
            Some(Value::String(s)) => !s.is_empty(),
            _ => false,
        };
    if needs_switch {
        reqs.push(serde_json::json!({ "type": "switch", "value": null }));
    }
    if let Some(ti) = x.get("transferItem") {
        let iid = s(ti, "item").unwrap_or("");
        if !iid.is_empty() {
            let cnt = ti.get("count").and_then(|v| v.as_i64()).unwrap_or(0);
            let name = zh_items
                .get(&format!("{iid} Name"))
                .cloned()
                .unwrap_or_else(|| iid.to_string());
            if iid == ROUBLES_ID {
                reqs.push(serde_json::json!({
                    "type": "payment", "value": format!("{cnt} ₽"),
                    "itemId": iid, "name": name, "count": cnt,
                }));
            } else {
                reqs.push(serde_json::json!({
                    "type": "itemRequired", "value": format!("{name} ×{cnt}"),
                    "itemId": iid, "name": name, "count": cnt,
                }));
            }
        }
    }
    reqs
}

fn build_markers(raw: &Raw, map_meta: &HashMap<String, MapEntry>) -> Value {
    let mut name_ids = Map::new();
    for m in raw.maps.values() {
        if let (Some(nid), Some(nn)) = (s(m, "nameId"), s(m, "normalizedName")) {
            name_ids.insert(nid.to_string(), Value::String(nn.to_string()));
        }
    }

    // 地图 id -> (normalizedName, 中文名)：转移点（transits）的 map 字段指向**目标地图的 id**
    let mut mid_to: HashMap<String, (String, String)> = HashMap::new();
    for (mid, m) in &raw.maps {
        if let Some(nn) = s(m, "normalizedName").filter(|v| !v.is_empty()) {
            let zh = map_meta
                .get(mid)
                .map(|e| if e.zh.is_empty() { e.nn.clone() } else { e.zh.clone() })
                .unwrap_or_else(|| nn.to_string());
            mid_to.insert(mid.to_string(), (nn.to_string(), zh));
        }
    }

    let mut maps_out = Map::new();
    for (mid, m) in &raw.maps {
        let nn = match s(m, "normalizedName") {
            Some(v) if !v.is_empty() => v.to_string(),
            _ => continue,
        };
        let _map_zh = map_meta
            .get(mid)
            .map(|e| if e.zh.is_empty() { e.nn.clone() } else { e.zh.clone() })
            .unwrap_or_else(|| nn.clone());
        let mut out = Map::new();

        let extracts_raw = arr(m, "extracts");
        // 上游脏数据兜底：所有撤离点共用同一个非空 switch 值时，视为无效（真实开关只作用于个别撤离点）
        let mut switch_vals: Vec<String> = extracts_raw
            .iter()
            .filter_map(|x| match x.get("switch") {
                Some(Value::Bool(true)) => Some("true".into()),
                Some(Value::String(s)) if !s.is_empty() => Some(s.clone()),
                _ => None,
            })
            .collect();
        switch_vals.sort();
        switch_vals.dedup();
        let ignore_switch = extracts_raw.len() > 1 && switch_vals.len() == 1;

        let extracts: Vec<Value> = extracts_raw
            .iter()
            .map(|x| {
                let mut e = entry_val(x, raw);
                if let Some(o) = e.as_object_mut() {
                    o.insert(
                        "faction".into(),
                        s(x, "faction").map(|v| Value::String(v.to_string())).unwrap_or(Value::Null),
                    );
                    o.insert(
                        "wiki".into(),
                        s(x, "wiki").map(|v| Value::String(v.to_string())).unwrap_or(Value::Null),
                    );
                    o.insert(
                        "requirements".into(),
                        Value::Array(extract_requirements(x, &raw.zh_items, ignore_switch)),
                    );
                }
                e
            })
            .collect();
        if !extracts.is_empty() {
            out.insert("extracts".into(), Value::Array(extracts));
        }

        let spawns: Vec<Value> = arr(m, "spawns")
            .iter()
            .map(|sp| {
                let mut d = entry_val(sp, raw);
                if let Some(o) = d.as_object_mut() {
                    let cats: Vec<Value> = arr(sp, "categories")
                        .iter()
                        .filter_map(|v| v.as_str())
                        .map(|v| Value::String(v.to_string()))
                        .collect();
                    o.insert("categories".into(), Value::Array(cats));
                }
                d
            })
            .collect();
        if !spawns.is_empty() {
            out.insert("spawns".into(), Value::Array(spawns));
        }

        // Boss 出生点：原始数据的单个 boss 条目没有 position 字段，坐标藏在
        // spawnLocations（区域 -> 多个坐标）里。原先直接下发整条，前端因缺坐标会整条跳过，
        // 地图上的 Boss 出生点实际只来自 spawns（那批点没有 Boss 名）。
        // 这里按「区域 -> 坐标」展开成多个点，每点都带上 Boss 名与刷新率，
        // 地图上就能直接显示「Boss 名 + 刷新率」（对齐 tarkov.dev 的展示）。
        let mut bosses: Vec<Value> = Vec::new();
        for b in arr(m, "bosses") {
            let d = entry_val(b, raw);
            let mob_id = s(b, "mob").or_else(|| s(b, "id")).unwrap_or("");
            let mob = raw.mobs.get(mob_id);
            let name = mob.and_then(|x| s(x, "name")).or_else(|| s(b, "name"));
            let name_zh = zh_of(raw, &[name, mob.and_then(|x| s(x, "normalizedName"))])
                .or_else(|| d.get("nameZh").and_then(|v| v.as_str()).map(|v| v.to_string()))
                .or_else(|| name.map(|v| v.to_string()));
            let spawn_chance = b.get("spawnChance").and_then(|v| v.as_f64()).unwrap_or(0.0);
            let escs: Vec<Value> = b
                .get("escapes")
                .or_else(|| b.get("escorts"))
                .and_then(|v| v.as_array())
                .map(|a| a.as_slice())
                .unwrap_or(EMPTY_ARR)
                .iter()
                .map(|es| {
                    let mut ed = entry_val(es, raw);
                    let emob = raw.mobs.get(s(es, "mob").unwrap_or(""));
                    let ename = emob.and_then(|x| s(x, "name")).or_else(|| s(es, "name"));
                    let ezh = zh_of(raw, &[emob.and_then(|x| s(x, "normalizedName"))]).or_else(|| {
                        ed.get("nameZh").and_then(|v| v.as_str()).map(|v| v.to_string())
                    });
                    if let Some(o) = ed.as_object_mut() {
                        o.insert(
                            "name".into(),
                            ename.map(|v| Value::String(v.to_string())).unwrap_or(Value::Null),
                        );
                        if let Some(z) = ezh {
                            o.insert("nameZh".into(), Value::String(z));
                        }
                    }
                    ed
                })
                .collect();
            for loc in b
                .get("spawnLocations")
                .and_then(|v| v.as_array())
                .map(|a| a.as_slice())
                .unwrap_or(EMPTY_ARR)
            {
                let loc_name = s(loc, "name").unwrap_or("");
                let loc_chance = loc.get("chance").and_then(|v| v.as_f64()).unwrap_or(0.0);
                for p in loc
                    .get("positions")
                    .and_then(|v| v.as_array())
                    .map(|a| a.as_slice())
                    .unwrap_or(EMPTY_ARR)
                {
                    if !p.is_object() {
                        continue;
                    }
                    bosses.push(serde_json::json!({
                        "id": mob_id,
                        "name": name,
                        "nameZh": name_zh,
                        "type": "boss",
                        "categories": ["boss"],
                        "position": pos_val(Some(p)),
                        // 该 Boss 在这个地图出现的概率（0~1）
                        "spawnChance": spawn_chance,
                        "locationName": loc_name,
                        // 落在这个区域的概率（0~1）
                        "locationChance": loc_chance,
                        "escorts": escs,
                    }));
                }
            }
        }
        if !bosses.is_empty() {
            out.insert("bosses".into(), Value::Array(bosses));
        }

        let locks: Vec<Value> = arr(m, "locks")
            .iter()
            .map(|l| {
                let mut d = entry_val(l, raw);
                if let Some(o) = d.as_object_mut() {
                    // 锁本身不带名称（只有 lockType + 钥匙 id），直接用钥匙的中文名命名：
                    // 前端按名称把「同一把钥匙的几个门」归为一组，此前全都显示成「未命名」
                    if let Some(kid) = s(l, "key") {
                        let kn = item_name(raw, kid);
                        if o.get("nameZh").map(|v| v.is_null()).unwrap_or(true) {
                            o.insert("nameZh".into(), Value::String(kn.clone()));
                        }
                        if o.get("name").map(|v| v.is_null()).unwrap_or(true) {
                            o.insert("name".into(), Value::String(kn));
                        }
                    }
                    o.insert(
                        "keyName".into(),
                        s(l, "key").map(|v| Value::String(v.to_string())).unwrap_or(Value::Null),
                    );
                    o.insert(
                        "lockType".into(),
                        s(l, "lockType")
                            .map(|v| Value::String(v.to_string()))
                            .unwrap_or(Value::Null),
                    );
                }
                d
            })
            .collect();
        if !locks.is_empty() {
            out.insert("locks".into(), Value::Array(locks));
        }

        let hazards: Vec<Value> = arr(m, "hazards")
            .iter()
            .map(|h| {
                let mut d = entry_val(h, raw);
                if let Some(o) = d.as_object_mut() {
                    o.insert(
                        "kind".into(),
                        s(h, "kind").map(|v| Value::String(v.to_string())).unwrap_or(Value::Null),
                    );
                }
                d
            })
            .collect();
        if !hazards.is_empty() {
            out.insert("hazards".into(), Value::Array(hazards));
        }

        let containers: Vec<Value> = arr(m, "lootContainers")
            .iter()
            .map(|c| {
                let mut d = entry_val(c, raw);
                let cid = s(c, "lootContainer").or_else(|| s(c, "containerId")).unwrap_or("");
                let info = raw.loot_containers.get(cid);
                let name = info.and_then(|x| s(x, "name"));
                let nn = info.and_then(|x| s(x, "normalizedName")).unwrap_or("");
                let name_zh = zh_of(raw, &[Some(nn), name]).or_else(|| {
                    d.get("nameZh").and_then(|v| v.as_str()).map(|v| v.to_string())
                });
                if let Some(o) = d.as_object_mut() {
                    o.insert(
                        "name".into(),
                        name.map(|v| Value::String(v.to_string())).unwrap_or(Value::Null),
                    );
                    o.insert(
                        "nameZh".into(),
                        name_zh.map(Value::String).unwrap_or(Value::Null),
                    );
                    o.insert("icon".into(), Value::String(nn.replace(' ', "-")));
                }
                d
            })
            .collect();
        if !containers.is_empty() {
            out.insert("lootContainers".into(), Value::Array(containers));
        }

        let switches: Vec<Value> = arr(m, "switches")
            .iter()
            .map(|s2| {
                let mut d = entry_val(s2, raw);
                // switch 的中文映射表里存的是英文可读名，再套一层手工翻译表
                if let Some(o) = d.as_object_mut() {
                    let key = o
                        .get("nameZh")
                        .and_then(|v| v.as_str())
                        .or_else(|| o.get("name").and_then(|v| v.as_str()))
                        .map(|x| x.to_string());
                    if let Some(k) = key.and_then(|k| switch_zh(&k)) {
                        o.insert("nameZh".into(), Value::String(k));
                    }
                }
                d
            })
            .collect();
        if !switches.is_empty() {
            out.insert("switches".into(), Value::Array(switches));
        }

        let weapons: Vec<Value> = arr(m, "stationaryWeapons")
            .iter()
            .map(|w| {
                let mut d = entry_val(w, raw);
                let wid = s(w, "stationaryWeapon").unwrap_or("");
                let info = raw.stationary_weapons.get(wid);
                let name = info
                    .and_then(|x| s(x, "shortName"))
                    .or_else(|| info.and_then(|x| s(x, "name")));
                let name_zh = zh_of(raw, &[name]).or_else(|| {
                    d.get("nameZh").and_then(|v| v.as_str()).map(|v| v.to_string())
                });
                if let Some(o) = d.as_object_mut() {
                    o.insert(
                        "name".into(),
                        name.map(|v| Value::String(v.to_string())).unwrap_or(Value::Null),
                    );
                    o.insert(
                        "nameZh".into(),
                        name_zh.map(Value::String).unwrap_or(Value::Null),
                    );
                }
                d
            })
            .collect();
        if !weapons.is_empty() {
            out.insert("stationaryWeapons".into(), Value::Array(weapons));
        }

        let btr: Vec<Value> = arr(m, "btrStops").iter().map(|b| entry_val(b, raw)).collect();
        if !btr.is_empty() {
            out.insert("btrStops".into(), Value::Array(btr));
        }

        // 地图间转移点：description 是本地化 key（如 LAB_TRANSIT_8_DESC），
        // 中文表里存的就是目的地名；map 字段指向目标地图的 id。
        let transits: Vec<Value> = arr(m, "transits")
            .iter()
            .filter_map(|t| {
                let pos = t.get("position").filter(|p| p.is_object())?;
                let dest_key = s(t, "description").unwrap_or("");
                let (to_nn, to_zh) = mid_to.get(s(t, "map").unwrap_or("")).cloned().unwrap_or_default();
                Some(serde_json::json!({
                    "id": num_or_str(t.get("id")),
                    "position": pos_val(Some(pos)),
                    "destKey": dest_key,
                    "destZh": raw.zh_maps.get(dest_key).cloned(),
                    "toMap": to_nn,
                    "toMapZh": to_zh,
                }))
            })
            .collect();
        if !transits.is_empty() {
            out.insert("transits".into(), Value::Array(transits));
        }

        out.insert(
            "_meta".into(),
            serde_json::json!({
                "raidDuration": num_or_str(m.get("raidDuration")),
                "players": num_or_str(m.get("players")),
            }),
        );
        maps_out.insert(nn, Value::Object(out));
    }

    let mut fallback = Map::new();
    for (k, v) in NAME_ID_FALLBACK {
        fallback.insert(k.to_string(), Value::String(v.to_string()));
    }

    serde_json::json!({
        "version": 1,
        "source": "json.tarkov.dev",
        "maps": Value::Object(maps_out),
        "nameIds": Value::Object(name_ids),
        "nameIdFallback": Value::Object(fallback),
    })
}

// ---------------- 任务区域 ----------------

/// 往目标的 zone 列表里追加一个点：同一地图里的重复 zone 只保留第一个。
/// 上游同一个 zone 常有 day/night 两份副本（NN_MERGE 后 nn 相同，如工厂），坐标也可能有
/// 微小出入，只按坐标去重会漏；带 zone id 时按 id 去重，否则退回按坐标。
/// 不去重会在地图上画出两个图标——勾选/取消时它们又一起变，看着像「同一目标画了两份」。
fn push_zone_dedup(zones: &mut Vec<Value>, seen: &mut HashSet<String>, v: Value) {
    let key = match (
        v.get("nn").and_then(|x| x.as_str()),
        v.get("zid").and_then(|x| x.as_str()),
    ) {
        (Some(nn), Some(zid)) if !zid.is_empty() => format!("{nn}|{zid}"),
        (Some(nn), _) => match v.get("position") {
            Some(p) => format!("{nn}|{p}"),
            None => String::new(),
        },
        _ => String::new(),
    };
    if key.is_empty() || seen.insert(key) {
        zones.push(v);
    }
}

fn build_zones(raw: &Raw) -> Value {
    let mut name_ids: HashMap<String, String> = HashMap::new();
    for m in raw.maps.values() {
        if let (Some(nid), Some(nn)) = (s(m, "nameId"), s(m, "normalizedName")) {
            name_ids.insert(nid.to_string(), nn.to_string());
        }
    }
    let merge = |nn: &str| -> String {
        match NN_MERGE.iter().find(|(k, _)| *k == nn) {
            Some((_, v)) => v.to_string(),
            None => nn.to_string(),
        }
    };
    let nn_of_loc = |loc: &str| -> Option<String> {
        if loc.is_empty() {
            return None;
        }
        if let Some(m) = raw.maps.get(loc) {
            if let Some(nn) = s(m, "normalizedName") {
                return Some(nn.to_string());
            }
        }
        NAME_ID_FALLBACK
            .iter()
            .find(|(k, _)| *k == loc)
            .map(|(_, v)| v.to_string())
            .or_else(|| name_ids.get(loc).cloned())
    };

    let mut tasks_out = Map::new();
    for (tid, t) in &raw.tasks_regular {
        let mut objs_out: Vec<Value> = Vec::new();
        for (oi, o) in arr(t, "objectives").iter().enumerate() {
            let mut zones: Vec<Value> = Vec::new();
            let mut seen_zones: HashSet<String> = HashSet::new();
            for z in arr(o, "zones") {
                let Some(znn) = s(z, "map").and_then(&nn_of_loc).map(|n| merge(&n)) else {
                    continue;
                };
                let position = match z.get("position") {
                    Some(p) if p.is_object() => p,
                    _ => continue,
                };
                let mut outline: Vec<Value> = Vec::new();
                for pt in arr(z, "outline") {
                    if let (Some(x), Some(zz)) = (pt.get("x").and_then(|v| v.as_f64()), pt.get("z").and_then(|v| v.as_f64())) {
                        outline.push(serde_json::json!({ "x": x, "z": zz }));
                    }
                }
                if outline.is_empty() {
                    if let Some(size) = z.get("size") {
                        let sx = size.get("x").and_then(|v| v.as_f64()).unwrap_or(0.0);
                        let sz = size.get("z").and_then(|v| v.as_f64()).unwrap_or(0.0);
                        let cx = position.get("x").and_then(|v| v.as_f64()).unwrap_or(0.0);
                        let cz = position.get("z").and_then(|v| v.as_f64()).unwrap_or(0.0);
                        outline = vec![
                            serde_json::json!({ "x": cx - sx / 2.0, "z": cz - sz / 2.0 }),
                            serde_json::json!({ "x": cx + sx / 2.0, "z": cz - sz / 2.0 }),
                            serde_json::json!({ "x": cx + sx / 2.0, "z": cz + sz / 2.0 }),
                            serde_json::json!({ "x": cx - sx / 2.0, "z": cz + sz / 2.0 }),
                        ];
                    }
                }
                push_zone_dedup(
                    &mut zones,
                    &mut seen_zones,
                    serde_json::json!({
                        "nn": znn,
                        // 上游 zone id：day/night 副本共用同一个 id，去重靠它
                        "zid": s(z, "id").unwrap_or(""),
                        "position": pos_val(Some(position)),
                        "top": num(z.get("top")),
                        "bottom": num(z.get("bottom")),
                        "outline": Value::Array(outline),
                    }),
                );
            }
            // possibleLocations：另一批目标位置来源（如『在 X 找到物品』的多个可能刷新点）。
            // 结构 {map, positions:[{x,y,z},...]}，map 为地图 id。每个 position 派生为一个 zone 点。
            for pl in arr(o, "possibleLocations") {
                let Some(plnn) = s(pl, "map").and_then(&nn_of_loc).map(|n| merge(&n)) else {
                    continue;
                };
                for p in arr(pl, "positions") {
                    if !p.is_object() {
                        continue;
                    }
                    push_zone_dedup(
                        &mut zones,
                        &mut seen_zones,
                        serde_json::json!({
                            "nn": plnn,
                            "position": pos_val(Some(p)),
                            "top": Value::Null,
                            "bottom": Value::Null,
                            "outline": Value::Array(vec![]),
                        }),
                    );
                }
            }
            let mut obj_maps: Vec<String> = Vec::new();
            for loc in arr(o, "maps") {
                let Some(loc) = loc.as_str() else { continue };
                if let Some(nn) = nn_of_loc(loc).map(|n| merge(&n)) {
                    if !obj_maps.contains(&nn) {
                        obj_maps.push(nn);
                    }
                }
            }
            for z in &zones {
                if let Some(nn) = z.get("nn").and_then(|v| v.as_str()) {
                    if !obj_maps.iter().any(|x| x == nn) {
                        obj_maps.push(nn.to_string());
                    }
                }
            }
            if zones.is_empty() && obj_maps.is_empty() {
                continue;
            }
            let desc = s(o, "description").unwrap_or("");
            // 目标 id（与 dataset::Objective.id 同源）：地图弹窗据此单独标记该目标完成
            let oid = match s(o, "id") {
                Some(x) if !x.is_empty() => x.to_string(),
                _ if !desc.is_empty() => desc.to_string(),
                _ => format!("{tid}#{oi}"),
            };
            objs_out.push(serde_json::json!({
                "id": oid,
                // 目标在任务 objectives 里的原始序号：地图图标上显示「#n」用，
                // 与任务详情里的目标顺序一致（objs_out 会跳过无坐标的目标，不能直接用它下标）
                "idx": oi,
                "type": s(o, "type").map(|v| Value::String(v.to_string())).unwrap_or(Value::Null),
                "optional": o.get("optional").and_then(|v| v.as_bool()).unwrap_or(false),
                "descZh": raw.zh_tasks.get(desc).cloned().map(Value::String).unwrap_or(Value::Null),
                "maps": obj_maps,
                "zones": Value::Array(zones),
            }));
        }
        if objs_out.is_empty() {
            continue;
        }
        let name_key = s(t, "name").unwrap_or("");
        tasks_out.insert(
            tid.clone(),
            serde_json::json!({
                "name": name_key,
                "nameZh": raw.zh_tasks.get(name_key).cloned().unwrap_or_else(|| name_key.to_string()),
                "wiki": format!("https://www.eftarkov.com/news/id/{}.html", tid),
                "objectives": Value::Array(objs_out),
            }),
        );
    }

    serde_json::json!({
        "version": 1,
        "source": "json.tarkov.dev",
        "tasks": Value::Object(tasks_out),
    })
}

// ---------------- Boss 刷新率 ----------------

fn build_bosses(raw: &Raw) -> Value {
    let mut out = Map::new();
    for m in raw.maps.values() {
        let nn = match s(m, "normalizedName") {
            Some(v) if !v.is_empty() => v,
            _ => continue,
        };
        let mut merged: Vec<Value> = Vec::new();
        for b in arr(m, "bosses") {
            let mob = match s(b, "mob") {
                Some(v) if !v.is_empty() => v,
                _ => continue,
            };
            let chance = b.get("spawnChance").and_then(|v| v.as_f64()).unwrap_or(0.0);
            let locations = arr(b, "spawnLocations").len();
            let name_zh = raw
                .zh_maps
                .get(mob)
                .cloned()
                .unwrap_or_else(|| mob.to_string());
            match merged.iter_mut().find(|x| x.get("id").and_then(|v| v.as_str()) == Some(mob)) {
                Some(cur) => {
                    if let Some(o) = cur.as_object_mut() {
                        let old = o.get("chance").and_then(|v| v.as_f64()).unwrap_or(0.0);
                        o.insert("chance".into(), serde_json::json!(old.max(chance)));
                        let old_loc = o.get("locations").and_then(|v| v.as_u64()).unwrap_or(0);
                        o.insert("locations".into(), serde_json::json!(old_loc + locations as u64));
                    }
                }
                None => merged.push(serde_json::json!({
                    "id": mob,
                    "name": mob,
                    "nameZh": name_zh,
                    "chance": chance,
                    "locations": locations,
                })),
            }
        }
        if !merged.is_empty() {
            merged.sort_by(|a, b| {
                let ca = a.get("chance").and_then(|v| v.as_f64()).unwrap_or(0.0);
                let cb = b.get("chance").and_then(|v| v.as_f64()).unwrap_or(0.0);
                cb.partial_cmp(&ca).unwrap_or(std::cmp::Ordering::Equal)
            });
            out.insert(nn.to_string(), Value::Array(merged));
        }
    }
    serde_json::json!({
        "version": 1,
        "source": "json.tarkov.dev",
        "maps": Value::Object(out),
    })
}

// ---------------- 地图骨架 ----------------

fn build_skeleton(path: Option<&Path>, map_meta: &HashMap<String, MapEntry>) -> Value {
    let Some(path) = path else {
        eprintln!("[dataset] 未找到随包地图骨架 maps-skeleton.json");
        return serde_json::json!({ "version": 1, "groups": [] });
    };
    let text = match std::fs::read_to_string(path) {
        Ok(t) => t,
        Err(e) => {
            eprintln!("[dataset] 读取地图骨架失败：{e}");
            return serde_json::json!({ "version": 1, "groups": [] });
        }
    };
    let mut doc: Value = match serde_json::from_str(&text) {
        Ok(v) => v,
        Err(e) => {
            eprintln!("[dataset] 解析地图骨架失败：{e}");
            return serde_json::json!({ "version": 1, "groups": [] });
        }
    };
    let zh_by_nn: HashMap<String, String> = map_meta
        .values()
        .map(|e| (e.nn.clone(), if e.zh.is_empty() { e.nn.clone() } else { e.zh.clone() }))
        .collect();
    if let Some(groups) = doc.get_mut("groups").and_then(|v| v.as_array_mut()) {
        for g in groups.iter_mut() {
            let nn = s(g, "normalizedName").unwrap_or("").to_string();
            let zh = zh_by_nn.get(&nn).cloned().unwrap_or_else(|| nn.clone());
            if let Some(o) = g.as_object_mut() {
                o.insert("nameZh".into(), Value::String(zh));
            }
        }
    }
    doc
}

// ---------------- 入口 ----------------

/// 用指定目录里的原始 JSON 构建全部派生数据（不装载）
pub fn build_from_dir(dir: &Path, skeleton: Option<&Path>) -> Result<Store, String> {
    let raw = Raw::from_dir(dir)?;
    let map_meta = build_map_meta(&raw);
    let quests = build_quests(&raw, &map_meta);
    let mut trader_names: HashMap<String, String> = HashMap::new();
    for n in quests.values() {
        trader_names
            .entry(n.trader_id.clone())
            .or_insert_with(|| n.trader_name.clone());
    }
    let markers = build_markers(&raw, &map_meta);
    let zones = build_zones(&raw);
    let bosses = build_bosses(&raw);
    let skeleton = build_skeleton(skeleton, &map_meta);
    // 互斥关系反向索引：别人完成了会让谁失败
    let mut fail_map: HashMap<String, Vec<String>> = HashMap::new();
    for (qid, n) in &quests {
        for other in &n.fail_on_done {
            fail_map
                .entry(other.clone())
                .or_default()
                .push(qid.clone());
        }
    }
    Ok(Store {
        quests,
        maps: map_meta,
        trader_names,
        markers,
        zones,
        bosses,
        skeleton,
        fail_map,
    })
}

/// 从缓存目录重建全部派生数据并装载
pub fn rebuild(app: &tauri::AppHandle) -> Result<(usize, usize), String> {
    let dir = apidata::ensure_cache(app)?;
    // ensure_cache 会把 maps-skeleton.json 物化进缓存目录（Android 走 assets 回退），
    // 这里依次找：随包文件系统 → 缓存目录副本
    let skeleton = apidata::bundled_file(app, "maps-skeleton.json").or_else(|| {
        let p = dir.join("maps-skeleton.json");
        p.is_file().then_some(p)
    });
    let store = build_from_dir(&dir, skeleton.as_deref())?;
    let qn = store.quests.len();
    let mn = store.maps.len();
    install(store);
    Ok((qn, mn))
}
