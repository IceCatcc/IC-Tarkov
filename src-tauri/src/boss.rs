//! 本地战局 Boss 监控（参考 seongjin-lab/tarkov-boss 的思路）。
//!
//! 数据来源是本机游戏日志：
//! - `application_*.log`：`MatchingCompleted:` / `RaidId:...Locations:...` 判定战局与地图
//! - `aiData_*.log`：`Init Boss wave:... ShallSpawn:...`（生成判定，roll）、
//!   `Bot activate ... role:... pos:(...)`（实际刷新）、`Group set boss.`（刷新区域）、
//!   `bot dispose` + `BotDied`（死亡配对）
//! - `backend_*.log`：`client/match/local/end` 判定战局结束
//!
//! 其中 **生成判定** 与 **实际刷新** 是两件事：roll 决定本局这只有没有刷，
//! Bot activate 才代表它真的进了局内。两者分开记录，所以能区分
//! 「本局不刷」与「刷了但还没激活」。
//!
//! 详细 AI 记录默认不会写进日志，需要把游戏安装目录下 `Logging.config` 里
//! `aiData` 规则的 `minLevel` 调到 `Trace` 并重启游戏；本模块提供一键修改，
//! 以及固定写回原始级别 `Error` 的还原操作（不记录原值、也不需要备份）。
//! 注意：本功能只读日志 + 改日志级别，不碰游戏进程内存，但**无法保证**不会被
//! 反作弊判定 —— 是否使用由用户自行承担风险。

use std::collections::{HashMap, HashSet};
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant};

use once_cell::sync::Lazy;
use regex::Regex;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};

use crate::AppState;

/// 快照变化时广播给前端的事件名
pub const EVENT: &str = "boss-monitor";
const SETTINGS_FILE: &str = "boss-monitor.json";
const CONFIG_NAME: &str = "Logging.config";
/// 游戏 `Logging.config` 里 `aiData` 的原始级别：固定为 `Error`。
/// 本工具只会把它提到 `Trace`，还原时直接写回 `Error`，
/// 因此不需要记录修改前的值，也不需要备份整份配置文件。
const ORIGINAL_AI_LEVEL: &str = "Error";
/// 自动清理 AI 日志的触发大小：aiData 超过它才截断。
/// 不设成每轮都清，是为了减少「刚读完、还没来得及清」这段窗口里丢行的概率。
const CLEAN_LIMIT: u64 = 16 * 1024 * 1024;

/* ---------------- 日志行匹配 ---------------- */

/// `RaidId:6728..., Count:0, Locations:bigmap -> factory4_day -> `
static RE_RAID: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"RaidId:([^,]+),.*Locations:([^\r\n]*)").unwrap());
/// 只有地图链、没有可用 RaidId 时的兜底（行内字段顺序不同 / 缺逗号等情况）。
/// 口径与 `parser.rs` 的 `RE_LOCATION` 一致：只取 `Locations:` 后的地图链。
static RE_LOCATION: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"Locations:([A-Za-z0-9_\-]*(?:\s*->\s*[A-Za-z0-9_\-]*)*)").unwrap()
});
/// `Init Boss wave:bossKilla ShallSpawn:True BossChance:30`
static RE_PLAN: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"Init Boss wave:(\w+) ShallSpawn:(True|False)(?:[^\r\n]*?BossChance:(\d+))?")
        .unwrap()
});
static RE_ROLE: Lazy<Regex> = Lazy::new(|| Regex::new(r"\brole:(\w+)").unwrap());
static RE_POS: Lazy<Regex> = Lazy::new(|| Regex::new(r"\bpos:\(([^)]+)\)").unwrap());
static RE_BOT_ID: Lazy<Regex> = Lazy::new(|| Regex::new(r"\bid:(\d+)").unwrap());
static RE_DISPOSE: Lazy<Regex> = Lazy::new(|| Regex::new(r"\bbot dispose:(\d+)").unwrap());
/// `Group set boss. groupName:Zone_... [Boss] botBoss.Id:123 bossType:bossKilla`
static RE_ZONE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"\bgroupName:(\S+)\s+\[Boss\]\s+botBoss\.Id:(\d+)\s+bossType:(\w+)").unwrap()
});
/// 旧版回退：`Add enemy groupId:Zone_... [Boss] _defWildSpawnType:bossKilla cause:initial`
static RE_ZONE_OLD: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"\bgroupId:(\w+)\s+\[Boss\]\s+_defWildSpawnType:(\w+)\s+cause:initial").unwrap()
});
/// 本局护卫数量：`SpawnWave   BornZone:ZoneScavBase, ShallSpawn:True, EscortCount:4,
/// BossType:bossBully, EscortType:followerBully`
/// （`ShallSpawn:False` 的行也会输出，但它不是本局实际刷的，忽略）
static RE_ESCORT: Lazy<Regex> = Lazy::new(|| {
    Regex::new(
        r"SpawnWave\s+BornZone:([^,]*),\s*ShallSpawn:(True|False),\s*EscortCount:(\d+),\s*BossType:(\w+),\s*EscortType:(\w*)",
    )
    .unwrap()
});
/// `Logging.config` 里 aiData 规则：fileName 在前
static RE_AI_LEVEL: Lazy<Regex> =
    Lazy::new(|| Regex::new(r#""fileName"\s*:\s*"aiData"[^{}]*?"minLevel"\s*:\s*"([^"]*)""#).unwrap());
/// 少数配置文件把 minLevel 写在 fileName 之前
static RE_AI_LEVEL_ALT: Lazy<Regex> =
    Lazy::new(|| Regex::new(r#""minLevel"\s*:\s*"([^"]*)"[^{}]*?"fileName"\s*:\s*"aiData""#).unwrap());

/* ---------------- 持久化设置 ---------------- */

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct BossSettings {
    /// 监控总开关
    pub enabled: bool,
    /// 确认刷新时是否弹顶部悬浮通知
    pub notify: bool,
    /// 解析后是否自动清理 aiData 日志内容（只清 AI 详细日志，其它日志一律不动）
    pub clean_ai: bool,
    /// 游戏安装目录（含 EscapeFromTarkov.exe / Logging.config）
    pub game_root: String,
    /// 上次定位到的 Logging.config（自动探测结果也记在这里）
    pub config_path: String,
}

impl Default for BossSettings {
    fn default() -> Self {
        Self {
            enabled: false,
            notify: true,
            clean_ai: false,
            game_root: String::new(),
            config_path: String::new(),
        }
    }
}

/* ---------------- 对前端下发的结构 ---------------- */

#[derive(Clone, Debug, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct BossSpawnState {
    /// 日志里的角色名（= tarkov.dev 的 mob id，如 bossKilla）
    pub role: String,
    /// unknown / planned（预计刷新）/ not_planned（本局不刷）/ confirmed（已刷新）/ dead
    pub status: String,
    /// 生成判定行里的 BossChance
    pub chance: Option<u32>,
    /// 该状态对应的日志时间
    pub at: Option<String>,
    /// 首次激活时的坐标原文 `(x, y, z)`（不是当前位置）
    pub position: Option<String>,
    /// 首次刷新的区域名（日志里的 groupName，不是当前位置）
    pub zone: Option<String>,
    /// 累计确认的实例数
    pub count: u32,
    /// 存活估计（以日志的存活名单为准，名单没覆盖到时用激活 / 死亡配对推算）
    pub alive: u32,
    pub died_at: Option<String>,
    /// 本局该 Boss 的护卫类型（日志 `SpawnWave ... EscortType:followerBully`）
    pub escort_type: Option<String>,
    /// 本局该 Boss 的护卫总数（日志 `SpawnWave ... EscortCount:4`）
    pub escort_total: u32,
    /// 护卫剩余存活（按存活名单里该护卫角色的实时数量统计）
    pub escort_alive: u32,
}

#[derive(Clone, Debug, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct BossMonitorPayload {
    pub enabled: bool,
    pub notify: bool,
    /// 解析后是否自动清理 aiData 日志
    pub clean_ai: bool,
    /// 最近一次自动清理的结果（界面提示用；没清理过为空）
    pub clean_note: String,
    pub game_root: String,
    pub config_path: String,
    /// 当前使用的日志目录（settings.json 里配置的那个）
    pub log_dir: String,
    /// 正在读取的会话目录名（log_yyyy.MM.dd_H-mm-ss_xxx）
    pub session: String,
    /// 当前地图（tarkov.dev 的 normalizedName，如 customs / factory）
    pub map: String,
    /// 当前地图中文名
    pub map_name: String,
    pub raid_id: String,
    pub in_raid: bool,
    pub ended: bool,
    pub started_at: Option<String>,
    /// 是否读到过 aiData 行（说明详细 AI 日志已生效）
    pub has_ai_data: bool,
    /// 会话目录里是否存在 aiData 日志文件
    pub ai_log_found: bool,
    /// 面向用户的诊断文案
    pub diagnostic: String,
    pub bosses: Vec<BossSpawnState>,
    /// BTR 装甲车：日志里的实体状态 + 发车 / 叫车信号
    pub btr: BossBtrState,
    pub updated_at: Option<String>,
}

/// BTR（`shooterBTR`）状态。
/// 日志里 BTR 和 Boss 走同一套「生成判定 / 实际激活」，另外还有两个专属信号：
/// - `OnReadyToDeparture(BtrReadyToDepartureEvent)`：BTR 即将发车的音频控制事件
/// - `Service PlayerTaxi has already been purchased!`：玩家买了 BTR 运送
#[derive(Clone, Debug, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct BossBtrState {
    /// unknown / planned / not_planned / confirmed / dead（取 shooterBTR 的状态）
    pub status: String,
    pub chance: Option<u32>,
    /// 生成判定 / 首次激活时间
    pub at: Option<String>,
    /// 首次激活坐标原文
    pub position: Option<String>,
    /// 出发准备信号时间（按先后顺序）
    pub ready_at: Vec<String>,
    /// 购买 BTR 运送的时间
    pub taxi_at: Vec<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoggingStatus {
    pub config_path: String,
    pub found: bool,
    /// aiData 当前的 minLevel（找不到规则时为空）
    pub ai_data_level: String,
    /// aiData 是否已经是 Trace
    pub patched: bool,
    /// 还原时会写回的原始级别（固定为 Error）
    pub restore_target: String,
    pub game_root: String,
    pub error: Option<String>,
}

/* ---------------- 运行时状态 ---------------- */

#[derive(Clone, Copy, PartialEq, Eq)]
enum FileKind {
    Application,
    Ai,
    Backend,
}

#[derive(Default)]
struct Raid {
    map: String,
    raid_id: String,
    started_at: Option<String>,
    in_raid: bool,
    ended: bool,
    bosses: Vec<BossSpawnState>,
}

struct Runtime {
    settings: BossSettings,
    log_dir: String,
    session: String,
    offsets: HashMap<String, u64>,
    tails: HashMap<String, String>,
    raid: Raid,
    has_ai_data: bool,
    ai_log_found: bool,
    diagnostic: String,
    updated_at: Option<String>,
    /// 上一次广播出去的内容（不含 updatedAt），用于避免每秒无脑 emit
    last_emit: String,
    /// botId -> role（Bot activate 建立，死亡配对用）
    bot_role: HashMap<String, String>,
    /// role -> 刷新区域（Zone 行先于 / 后于激活都能对上）
    zone_by_role: HashMap<String, String>,
    /// 已计数过的激活（同一 bot 重复 activate 不重复加实例）
    seen_bots: HashSet<String>,
    /// 在「存活名单」里出现过的角色：它们缺席时才能断定「全灭」，
    /// 从没进过名单的角色（还没刷 / 远处未激活）不能据此清零
    seen_in_list: HashSet<String>,
    /// 最近一次 `bot dispose` 的 botId（紧随其后的 BotDied 与之配对）
    pending_dispose: Option<String>,
    /// BTR 出发准备信号时间（`OnReadyToDeparture`）
    btr_ready: Vec<String>,
    /// BTR 运送购买时间（`Service PlayerTaxi ...`）
    btr_taxi: Vec<String>,
    /// 最后处理过的进图行（`Locations` / `MatchingCompleted`）的日志时间。
    /// 兜底检查据此判断「尾部那条进图记录是不是已经处理过」，同时也保证不倒退回旧局。
    last_entry_ts: String,
    /// 兜底检查用：上次看到的 application 日志签名（文件名 + 大小 + mtime）
    fallback_sig: String,
    /// 兜底检查用：上次执行时间（节流）
    fallback_at: Option<Instant>,
    /// 最近一次自动清理 aiData 日志的结果（给界面看；不随 reset_scan 清空）
    clean_note: String,
}

impl Default for Runtime {
    fn default() -> Self {
        Self {
            settings: BossSettings::default(),
            log_dir: String::new(),
            session: String::new(),
            offsets: HashMap::new(),
            tails: HashMap::new(),
            raid: Raid::default(),
            has_ai_data: false,
            ai_log_found: false,
            diagnostic: "监控已关闭".into(),
            updated_at: None,
            last_emit: String::new(),
            bot_role: HashMap::new(),
            zone_by_role: HashMap::new(),
            seen_bots: HashSet::new(),
            seen_in_list: HashSet::new(),
            pending_dispose: None,
            btr_ready: Vec::new(),
            btr_taxi: Vec::new(),
            last_entry_ts: String::new(),
            fallback_sig: String::new(),
            fallback_at: None,
            clean_note: String::new(),
        }
    }
}

impl Runtime {
    fn reset_scan(&mut self) {
        self.session.clear();
        self.offsets.clear();
        self.tails.clear();
        self.raid = Raid::default();
        self.has_ai_data = false;
        self.ai_log_found = false;
        self.bot_role.clear();
        self.zone_by_role.clear();
        self.seen_bots.clear();
        self.seen_in_list.clear();
        self.pending_dispose = None;
        self.btr_ready.clear();
        self.btr_taxi.clear();
        self.last_entry_ts.clear();
        self.fallback_sig.clear();
        self.fallback_at = None;
    }

    /// 记下已处理的进图行时间（只增不减，兜底检查靠它避免重复 / 回退）
    fn note_entry(&mut self, ts: &str) {
        if ts > self.last_entry_ts.as_str() {
            self.last_entry_ts = ts.to_string();
        }
    }

    /// `MatchingCompleted:` = 匹配完成，准备进图。
    ///
    /// **只在「当前没有有效战局」时开新局**：日志里 `Locations:` 行有时早于这一行，
    /// 早先按「5 秒内不重置」判断，一旦两行间隔超过 5 秒就会把刚识别的战局清空
    /// （表现为「进图漏了 / 地图变回未进入战局」）。现在改看战局本身是否存在：
    /// 已有地图且未结束就认为还是同一局，换局交给 RaidId 变化判定。
    fn on_matching_completed(&mut self, ts: &str) {
        let stale = self.raid.map.is_empty() || self.raid.ended;
        if stale {
            self.begin_raid(ts);
        }
        self.raid.in_raid = true;
        if self.raid.started_at.is_none() {
            self.raid.started_at = Some(ts.to_string());
        }
        self.note_entry(ts);
    }

    /// `RaidId:..., Locations:<链>`（或仅 `Locations:<链>`）：进图 / 转移。
    /// 地图链取**最后一个**非空段（转移时是「源 -> 目标」）。
    fn on_locations(&mut self, line: &str, ts: &str) {
        let (raid_id, chain) = match RE_RAID.captures(line) {
            Some(c) => (Some(c[1].trim().to_string()), c[2].to_string()),
            // 兜底：拿不到 RaidId 时只用地图链（字段顺序不同 / 缺逗号的老版本）
            None => match RE_LOCATION.captures(line) {
                Some(c) => (None, c[1].to_string()),
                None => return,
            },
        };
        let current = chain
            .split("->")
            .map(|s| s.trim())
            .filter(|s| !s.is_empty())
            .last()
            .unwrap_or("");
        if current.is_empty() {
            return;
        }
        if let Some(id) = &raid_id {
            // 同一会话里换了 RaidId：上一局已结束，开新局
            if !self.raid.raid_id.is_empty() && self.raid.raid_id != *id {
                self.begin_raid(ts);
            }
            self.raid.raid_id = id.clone();
        }
        if self.raid.started_at.is_none() {
            self.raid.started_at = Some(ts.to_string());
        }
        self.raid.map = canon_map(current);
        self.raid.ended = false;
        self.raid.in_raid = true;
        self.note_entry(ts);
    }

    /// 新战局边界：清空 Boss / BTR 状态，只保留本局起点时间
    fn begin_raid(&mut self, ts: &str) {
        self.raid = Raid {
            started_at: Some(ts.to_string()),
            ..Raid::default()
        };
        self.bot_role.clear();
        self.zone_by_role.clear();
        self.seen_bots.clear();
        self.seen_in_list.clear();
        self.pending_dispose = None;
        self.btr_ready.clear();
        self.btr_taxi.clear();
    }

    /// 用日志里的「存活名单」刷新各角色的存活数。
    ///
    /// 行形如：`[checklist] [AllAlivePotentialEnemiesPlayers] [SelectPoints.baseCase] for assault
    /// hard allAlivePlayersList: 15:bossBully, 17:pmcBEAR, 26:followerBully, ...`
    ///
    /// 只覆盖名单里出现的角色；某角色一旦在名单里出现过，后续缺席才视为全灭
    /// （从未出现过 = 还没刷 / 不在本局，不能清零）。
    fn on_alive_list(&mut self, line: &str) {
        let Some(list) = line.split("allAlivePlayersList:").nth(1) else {
            return;
        };
        let mut counts: HashMap<String, u32> = HashMap::new();
        for part in list.split(',') {
            let Some((_, role)) = part.trim().split_once(':') else {
                continue;
            };
            let role = role.trim().to_ascii_lowercase();
            if !role.is_empty() {
                *counts.entry(role).or_insert(0) += 1;
            }
        }
        if counts.is_empty() {
            return;
        }
        for role in counts.keys() {
            self.seen_in_list.insert(role.clone());
        }
        let seen = &self.seen_in_list;
        for b in self.raid.bosses.iter_mut() {
            let role = b.role.to_ascii_lowercase();
            if let Some(&n) = counts.get(&role) {
                b.alive = n;
            } else if seen.contains(&role) {
                b.alive = 0;
            }
            // 名单里又出现说明还活着（之前死亡配对错了 / 同局复活）
            if b.alive > 0 && b.status == "dead" {
                b.status = "confirmed".into();
                b.died_at = None;
            }
        }
    }

    fn boss_index(&mut self, role: &str) -> usize {
        if let Some(i) = self
            .raid
            .bosses
            .iter()
            .position(|b| b.role.eq_ignore_ascii_case(role))
        {
            return i;
        }
        self.raid.bosses.push(BossSpawnState {
            role: role.to_string(),
            status: "unknown".into(),
            ..BossSpawnState::default()
        });
        self.raid.bosses.len() - 1
    }

    /// 解析一行日志并更新状态。`kind` 由文件名决定，避免逐行判断来源。
    fn handle_line(&mut self, kind: FileKind, line: &str) {
        let ts = timestamp_of(line);

        // BTR 专属信号（与 Boss 判定无关，任何日志文件里出现都记录）：
        // - 出发准备信号：音频控制器的 OnReadyToDeparture 事件（这行往往没有时间戳，用当前时间兜底）
        // - 购买运送：玩家已购买 PlayerTaxi 服务
        if line.contains("OnReadyToDeparture(BtrReadyToDepartureEvent)") {
            push_recent(&mut self.btr_ready, ts.clone());
        }
        if line.contains("Service PlayerTaxi has already been purchased!") {
            push_recent(&mut self.btr_taxi, ts.clone());
        }

        match kind {
            FileKind::Application => {
                // 战局边界：匹配完成 → 新的一局（已有有效战局时只当作「已进图」）
                if line.contains("MatchingCompleted:") {
                    self.on_matching_completed(&ts);
                    return;
                }
                // 进图 / 地图转移：`RaidId:..., Locations:<链>`
                if line.contains("Locations:") {
                    self.on_locations(line, &ts);
                }
                if line.contains("GameStarted:") {
                    self.raid.in_raid = true;
                }
            }
            FileKind::Ai => {
                // 只有出现「详细 AI 记录」特征行才认为级别已生效：
                // 空文件 / 只写了启动噪音时不能给用户虚假的「已连接」
                if line.contains("|Trace|")
                    || line.contains("Init Boss wave:")
                    || line.contains("Bot activate")
                {
                    self.has_ai_data = true;
                }

                // 0) 存活名单：每只 AI 决策时都会打印一份「全部存活敌人」（id:role），
                //    这是存活数最准的来源（`bot dispose` 与 `BotDied` 不一定成对，
                //    缺一条就会把死掉的算成还活着，护卫剩余数尤其明显）。
                if line.contains("allAlivePlayersList:") {
                    self.on_alive_list(line);
                    return;
                }

                // 0) 本局护卫数量：`SpawnWave   BornZone:ZoneScavBase, ShallSpawn:True,
                //    EscortCount:4, BossType:bossBully, EscortType:followerBully`
                //    `ShallSpawn:False` 的行也输出，但它不是本局实际刷的，忽略。
                if let Some(c) = RE_ESCORT.captures(line) {
                    if c[2].eq_ignore_ascii_case("True") {
                        let zone = c[1].trim().to_string();
                        let total: u32 = c[3].parse().unwrap_or(0);
                        let role = c[4].to_string();
                        let escort = c[5].to_string();
                        let i = self.boss_index(&role);
                        let b = &mut self.raid.bosses[i];
                        if !escort.is_empty() {
                            b.escort_type = Some(escort);
                        }
                        // 同一 Boss 可能有多条波次行：取最大，避免后面的 0 把已确认的数量抹掉
                        b.escort_total = b.escort_total.max(total);
                        if b.zone.is_none() && !zone.is_empty() {
                            b.zone = Some(zone);
                        }
                    }
                    return;
                }

                // 1) 生成判定（roll）：本局这只有没有刷
                if let Some(c) = RE_PLAN.captures(line) {
                    let role = c[1].to_string();
                    let shall = c[2].eq_ignore_ascii_case("True");
                    let chance = c.get(3).and_then(|m| m.as_str().parse::<u32>().ok());
                    // 三 Goons 只有 Knight 有判定行，展开到两个护卫（与参考实现一致）
                    let roles: Vec<String> = if role.eq_ignore_ascii_case("bossKnight") {
                        vec![
                            "bossKnight".into(),
                            "followerBigPipe".into(),
                            "followerBirdEye".into(),
                        ]
                    } else {
                        vec![role]
                    };
                    for r in roles {
                        let i = self.boss_index(&r);
                        let b = &mut self.raid.bosses[i];
                        if b.status == "confirmed" || b.status == "dead" {
                            continue; // 已确认的状态不被后续判定覆盖
                        }
                        b.status = if shall { "planned".into() } else { "not_planned".into() };
                        b.at = Some(ts.clone());
                        if chance.is_some() {
                            b.chance = chance;
                        }
                    }
                    return;
                }

                // 2) 实际激活：Boss 真的进局了
                if line.contains("Bot activate") {
                    if let Some(c) = RE_ROLE.captures(line) {
                        let role = c[1].to_string();
                        let pos = RE_POS.captures(line).map(|m| m[1].to_string());
                        let bot = RE_BOT_ID.captures(line).map(|m| m[1].to_string());
                        if let Some(bot) = bot.clone() {
                            self.bot_role.insert(bot, role.clone());
                        }
                        let first_seen = match &bot {
                            Some(b) => self.seen_bots.insert(b.clone()),
                            None => true,
                        };
                        let zone = self.zone_by_role.get(&role).cloned();
                        let i = self.boss_index(&role);
                        let b = &mut self.raid.bosses[i];
                        if b.status != "dead" {
                            if b.position.is_none() {
                                b.position = pos;
                            }
                            if b.zone.is_none() {
                                b.zone = zone;
                            }
                            if b.at.is_none() || b.status != "confirmed" {
                                b.at = Some(ts.clone());
                            }
                            b.status = "confirmed".into();
                        }
                        if first_seen {
                            b.count += 1;
                            b.alive += 1;
                            // 同局内复活 / 重新激活：从「已确认死亡」回到「已刷新」
                            if b.status == "dead" {
                                b.status = "confirmed".into();
                                b.died_at = None;
                            }
                        }
                    }
                    return;
                }

                // 3) 死亡配对：bot dispose 紧跟 BotDied（同文件、时间差极小）
                if let Some(c) = RE_DISPOSE.captures(line) {
                    self.pending_dispose = Some(c[1].to_string());
                    return;
                }
                if line.contains("BotDied") {
                    if let Some(bot) = self.pending_dispose.take() {
                        if let Some(role) = self.bot_role.get(&bot).cloned() {
                            if let Some(i) = self
                                .raid
                                .bosses
                                .iter()
                                .position(|b| b.role.eq_ignore_ascii_case(&role))
                            {
                                let b = &mut self.raid.bosses[i];
                                b.alive = b.alive.saturating_sub(1);
                                if b.alive == 0 {
                                    b.status = "dead".into();
                                    b.died_at = Some(ts.clone());
                                }
                            }
                        }
                    }
                    return;
                }

                // 4) 刷新区域（新版 group set boss / 旧版 Add enemy）
                if let Some(c) = RE_ZONE.captures(line) {
                    let zone = c[1].to_string();
                    let role = c[3].to_string();
                    self.zone_by_role.insert(role.clone(), zone.clone());
                    if let Some(i) = self
                        .raid
                        .bosses
                        .iter()
                        .position(|b| b.role.eq_ignore_ascii_case(&role))
                    {
                        let b = &mut self.raid.bosses[i];
                        if b.zone.is_none() {
                            b.zone = Some(zone);
                        }
                    }
                    return;
                }
                if let Some(c) = RE_ZONE_OLD.captures(line) {
                    let zone = c[1].to_string();
                    let role = c[2].to_string();
                    self.zone_by_role.insert(role.clone(), zone.clone());
                    if let Some(i) = self
                        .raid
                        .bosses
                        .iter()
                        .position(|b| b.role.eq_ignore_ascii_case(&role))
                    {
                        let b = &mut self.raid.bosses[i];
                        if b.zone.is_none() {
                            b.zone = Some(zone);
                        }
                    }
                }
            }
            FileKind::Backend => {
                if line.contains("---> Request") && line.contains("client/match/local/end") {
                    self.raid.ended = true;
                    self.raid.in_raid = false;
                }
            }
        }
    }

    fn snapshot(&self) -> BossMonitorPayload {
        // 护卫剩余存活：按「该 Boss 的护卫角色」在当前存活名单里的数量实时汇总
        let mut bosses = self.raid.bosses.clone();
        for b in bosses.iter_mut() {
            if let Some(t) = b.escort_type.clone() {
                b.escort_alive = self
                    .raid
                    .bosses
                    .iter()
                    .filter(|x| x.role.eq_ignore_ascii_case(&t))
                    .map(|x| x.alive)
                    .sum();
            }
        }
        BossMonitorPayload {
            enabled: self.settings.enabled,
            notify: self.settings.notify,
            clean_ai: self.settings.clean_ai,
            clean_note: self.clean_note.clone(),
            game_root: self.settings.game_root.clone(),
            config_path: self.settings.config_path.clone(),
            log_dir: self.log_dir.clone(),
            session: self.session.clone(),
            map_name: map_zh(&self.raid.map),
            map: self.raid.map.clone(),
            raid_id: self.raid.raid_id.clone(),
            in_raid: self.raid.in_raid,
            ended: self.raid.ended,
            started_at: self.raid.started_at.clone(),
            has_ai_data: self.has_ai_data,
            ai_log_found: self.ai_log_found,
            diagnostic: self.diagnostic.clone(),
            bosses,
            btr: self.btr_state(),
            updated_at: self.updated_at.clone(),
        }
    }

    fn btr_state(&self) -> BossBtrState {
        let btr = self
            .raid
            .bosses
            .iter()
            .find(|b| b.role.eq_ignore_ascii_case("shooterBTR"));
        BossBtrState {
            status: btr
                .map(|b| b.status.clone())
                .unwrap_or_else(|| "unknown".into()),
            chance: btr.and_then(|b| b.chance),
            at: btr.and_then(|b| b.at.clone()),
            position: btr.and_then(|b| b.position.clone()),
            ready_at: self.btr_ready.clone(),
            taxi_at: self.btr_taxi.clone(),
        }
    }

    /// 内容有变化才广播（每秒轮询也不会刷屏）
    fn emit_if_changed(&mut self, app: &AppHandle) {
        let mut p = self.snapshot();
        let mut cmp = p.clone();
        cmp.updated_at = None;
        let key = serde_json::to_string(&cmp).unwrap_or_default();
        if key == self.last_emit {
            return;
        }
        self.last_emit = key;
        self.updated_at = Some(now());
        p.updated_at = self.updated_at.clone();
        let _ = app.emit(EVENT, &p);
    }
}

/* ---------------- 轮询 ---------------- */

pub fn init(app: &AppHandle) {
    let rt = runtime().clone();
    // 读取上次保存的设置（开关 / 通知 / 游戏目录）
    if let Some(p) = settings_path(app) {
        if let Ok(text) = std::fs::read_to_string(&p) {
            if let Ok(s) = serde_json::from_str::<BossSettings>(&text) {
                rt.lock().unwrap().settings = s;
            }
        }
    }
    let app_c = app.clone();
    thread::spawn(move || loop {
        {
            let mut g = rt.lock().unwrap();
            poll(&app_c, &mut g);
        }
        thread::sleep(Duration::from_millis(1000));
    });
}

fn poll(app: &AppHandle, rt: &mut Runtime) {
    rt.log_dir = {
        let st = app.state::<AppState>();
        let w = st.watch.lock().unwrap();
        w.log_dir.clone()
    };
    if !rt.settings.enabled {
        if !rt.session.is_empty() || !rt.raid.bosses.is_empty() || rt.diagnostic != "监控已关闭" {
            rt.reset_scan();
            rt.diagnostic = "监控已关闭".into();
        }
        rt.emit_if_changed(app);
        return;
    }

    if rt.log_dir.trim().is_empty() {
        rt.diagnostic = "请先在「设置」里配置日志目录".into();
        rt.emit_if_changed(app);
        return;
    }

    let (dir, session) = match pick_session(Path::new(&rt.log_dir)) {
        Ok(v) => v,
        Err(msg) => {
            rt.diagnostic = msg;
            rt.emit_if_changed(app);
            return;
        }
    };
    if session != rt.session {
        rt.reset_scan();
        rt.session = session;
    }

    let mut files: Vec<(FileKind, PathBuf)> = Vec::new();
    if let Ok(rd) = std::fs::read_dir(&dir) {
        for e in rd.flatten() {
            let p = e.path();
            if !p.is_file() {
                continue;
            }
            let name = p
                .file_name()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_default();
            match kind_of(&name) {
                Some(k) => files.push((k, p)),
                None => continue,
            }
        }
    }
    files.sort_by(|a, b| a.1.cmp(&b.1));
    rt.ai_log_found = files.iter().any(|(k, _)| *k == FileKind::Ai);

    let mut batches: Vec<(FileKind, Vec<String>)> = Vec::new();
    for (kind, path) in files {
        let lines = read_new_lines(rt, &path);
        if !lines.is_empty() {
            batches.push((kind, lines));
        }
    }
    replay_in_order(rt, batches);

    // 兜底检查：application 日志变了就再看一眼尾部有没有漏掉的进图记录
    // （先开游戏再开程序、日志轮转、会话切换、进图行间隔过远等情况）
    let sig = app_sig(&dir);
    if sig != rt.fallback_sig
        && rt
            .fallback_at
            .map_or(true, |t| t.elapsed().as_secs() >= FALLBACK_SECS)
    {
        rt.fallback_at = Some(Instant::now());
        rt.fallback_sig = sig;
        fallback_entry_check(rt, &dir);
    }

    // 自动清理：本轮解析完之后按需截断 aiData 日志（其它日志不动）
    maybe_clean_ai(rt, &dir);

    rt.diagnostic = if !rt.ai_log_found {
        "未找到 aiData 日志：请先在下方一键修改日志配置，然后重启游戏".into()
    } else if !rt.has_ai_data {
        "已找到 aiData 日志，但还没有 AI 记录（改完日志配置需重启游戏才生效）".into()
    } else if rt.raid.map.is_empty() {
        if rt.raid.in_raid {
            "已检测到进图信号 · 日志里还没有地图（Locations）信息".into()
        } else {
            "日志已连接 · 等待进入战局".into()
        }
    } else if rt.raid.ended {
        "战局已结束 · 等待下一局".into()
    } else {
        "日志已连接 · 正在监控当前战局".into()
    };

    rt.emit_if_changed(app);
}

/// 把一次轮询里多个日志文件的新行**按日志时间合并**后投递。
///
/// 文件是按名字分类读出来的（application / aiData / backend），如果按文件依次投递，
/// 一次回放就会把「本会话所有战局」的 AI 行都算到最后一次战局头上。
/// 归并后各局状态互相独立，最后一次战局即「最近一次进图记录」。
/// 每轮只取一小段（`CHUNK`），避免回放几百 MB 日志时把内存打爆。
fn replay_in_order(rt: &mut Runtime, batches: Vec<(FileKind, Vec<String>)>) {
    const CHUNK: usize = 4096;
    if batches.len() < 2 {
        // 只有一个文件时不必归并
        if let Some((kind, lines)) = batches.into_iter().next() {
            for line in lines {
                rt.handle_line(kind, &line);
            }
        }
        return;
    }
    let mut cursors = vec![0usize; batches.len()];
    loop {
        let mut window: Vec<(String, FileKind, String)> = Vec::new();
        for (i, (kind, lines)) in batches.iter().enumerate() {
            let start = cursors[i];
            if start >= lines.len() {
                continue;
            }
            let end = (start + CHUNK).min(lines.len());
            // 没有时间戳的行（如 BTR 发车信号）沿用同文件上一行的时间作为排序键
            let mut ts = if start == 0 {
                String::new()
            } else {
                ts_key(&lines[start - 1]).unwrap_or("").to_string()
            };
            for line in &lines[start..end] {
                if let Some(t) = ts_key(line) {
                    ts = t.to_string();
                }
                window.push((ts.clone(), *kind, line.clone()));
            }
            cursors[i] = end;
        }
        if window.is_empty() {
            break;
        }
        window.sort_by(|a, b| a.0.cmp(&b.0));
        for (_, kind, line) in window {
            rt.handle_line(kind, &line);
        }
    }
}

/// 读取文件新增的完整行；不完整的一行留在 tail 里等下次拼接。
fn read_new_lines(rt: &mut Runtime, path: &Path) -> Vec<String> {
    let key = path.display().to_string();
    let Ok(meta) = std::fs::metadata(path) else {
        return Vec::new();
    };
    let size = meta.len();
    let offset = rt.offsets.get(&key).copied().unwrap_or(0);
    let start = if offset > size {
        // 文件被截断 / 轮转：从头读，丢弃残留的半行
        rt.tails.remove(&key);
        0
    } else {
        offset
    };
    if start == size {
        return Vec::new();
    }
    let Ok(mut f) = std::fs::File::open(path) else {
        return Vec::new();
    };
    if f.seek(SeekFrom::Start(start)).is_err() {
        return Vec::new();
    }
    let mut buf = Vec::new();
    if f.read_to_end(&mut buf).is_err() {
        return Vec::new();
    }
    rt.offsets.insert(key.clone(), size);

    let mut text = rt.tails.remove(&key).unwrap_or_default();
    text.push_str(&String::from_utf8_lossy(&buf));
    // 自动清理把文件截断成 0 后，若游戏不是以「追加」模式写（保留自己的文件指针），
    // 下一批写入前会留下一段全 0 的空洞。这里直接抹掉 NUL，避免残片污染解析。
    if text.contains('\0') {
        text = text.replace('\0', "");
    }
    let mut lines: Vec<String> = text
        .split('\n')
        .map(|s| s.trim_end_matches('\r').to_string())
        .collect();
    let tail = if text.ends_with('\n') {
        String::new()
    } else {
        lines.pop().unwrap_or_default()
    };
    // 畸形的超长行（没有换行）直接丢弃，避免无限增长
    rt.tails.insert(key, if tail.len() > 2_000_000 { String::new() } else { tail });
    lines.retain(|l| !l.is_empty());
    lines
}

/* ---------------- 自动清理 AI 日志 ---------------- */

/// 解析完新行后按需清理 `aiData` 日志：**只截断 AI 详细日志，其它日志一字不动**。
///
/// 游戏对日志文件是以「追加」方式打开的，并且带写共享，因此进程外可以
/// `set_len(0)` 清空；万一被独占锁住（open 失败）就跳过，备注里写明原因，
/// 下一轮继续尝试。清空后把该文件的读取偏移归零并丢掉半行残留，
/// 下一轮从 0 开始读——游戏的下一次写入会从文件头继续。
fn maybe_clean_ai(rt: &mut Runtime, dir: &Path) {
    if !rt.settings.clean_ai {
        return;
    }
    let Ok(rd) = std::fs::read_dir(dir) else {
        return;
    };
    for e in rd.flatten() {
        let p = e.path();
        if !p.is_file() {
            continue;
        }
        let name = p
            .file_name()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_default();
        if kind_of(&name) != Some(FileKind::Ai) {
            continue;
        }
        let Ok(meta) = std::fs::metadata(&p) else {
            continue;
        };
        if meta.len() < CLEAN_LIMIT {
            continue;
        }
        let key = p.display().to_string();
        match truncate_to_empty(&p) {
            Ok(freed) => {
                rt.offsets.insert(key.clone(), 0);
                rt.tails.remove(&key);
                rt.clean_note = format!("已清理 aiData 日志（释放 {}）", mb(freed));
            }
            Err(e) => rt.clean_note = format!("aiData 日志暂时清不掉（{e}），下一轮重试"),
        }
    }
}

/// 把文件截断为 0 字节，返回释放的字节数。
/// Rust 的 `OpenOptions` 在 Windows 上默认带读 / 写 / 删除三种共享标志，
/// 所以只要游戏本身不是独占打开，这里就能拿到写句柄。
fn truncate_to_empty(path: &Path) -> std::io::Result<u64> {
    let f = std::fs::OpenOptions::new().write(true).open(path)?;
    let len = f.metadata()?.len();
    f.set_len(0)?;
    Ok(len)
}

fn mb(n: u64) -> String {
    format!("{:.1} MB", n as f64 / (1024.0 * 1024.0))
}

/* ---------------- 兜底检查 ---------------- */

/// 兜底检查的最小间隔（秒）：避免每秒都去读日志尾部
const FALLBACK_SECS: u64 = 3;
/// 兜底检查每次往回读的块大小 / 最多回看多少字节
const FALLBACK_CHUNK: u64 = 2 * 1024 * 1024;
const FALLBACK_MAX: u64 = 16 * 1024 * 1024;

/// application 日志的「文件名 + 大小 + mtime」签名。没变化就不用重复兜底检查。
fn app_sig(dir: &Path) -> String {
    let mut parts: Vec<String> = Vec::new();
    if let Ok(rd) = std::fs::read_dir(dir) {
        for e in rd.flatten() {
            let p = e.path();
            let name = p
                .file_name()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_default();
            if kind_of(&name) != Some(FileKind::Application) {
                continue;
            }
            let meta = std::fs::metadata(&p).ok();
            let len = meta.as_ref().map(|m| m.len()).unwrap_or(0);
            let mtime = meta
                .and_then(|m| m.modified().ok())
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_millis())
                .unwrap_or(0);
            parts.push(format!("{name}:{len}:{mtime}"));
        }
    }
    parts.sort();
    parts.join("|")
}

/// 日志里最后一条进图记录（`Locations:` 或 `MatchingCompleted:`）。
/// 从文件末尾往前分块读（`FALLBACK_CHUNK`），最多回看 `FALLBACK_MAX`，
/// 起点落在行中间时丢掉残行。
fn tail_last_entry(path: &Path) -> Option<String> {
    let mut f = std::fs::File::open(path).ok()?;
    let size = f.metadata().ok()?.len();
    let mut end = size;
    let mut scanned = 0u64;
    while end > 0 && scanned < FALLBACK_MAX {
        let start = end.saturating_sub(FALLBACK_CHUNK);
        f.seek(SeekFrom::Start(start)).ok()?;
        let mut buf = Vec::new();
        f.by_ref().take(end - start).read_to_end(&mut buf).ok()?;
        let text = String::from_utf8_lossy(&buf).into_owned();
        // 起点可能落在行中间：丢掉首个残行（除非已经读到文件开头）
        let body = if start == 0 {
            text.as_str()
        } else {
            text.split_once('\n').map(|x| x.1).unwrap_or("")
        };
        for line in body.lines().rev() {
            if line.contains("Locations:") || line.contains("MatchingCompleted:") {
                return Some(line.to_string());
            }
        }
        scanned += end - start;
        end = start;
    }
    None
}

/// 兜底检查：不依赖增量偏移，直接看 application 日志**末尾**的最后一条进图记录。
///
/// 增量读取本身不会丢行，但下面这些情况仍会让状态与实际脱节：
/// 日志轮转后偏移失效、程序打开得太晚（先开游戏再开本程序）、会话目录被换掉、
/// `Locations` 与 `MatchingCompleted` 相隔太久等。
/// 只在「比已处理的那条更新」时才采纳（`last_entry_ts` 单调），
/// 因此重复执行不会把上一局重新灌回来，也不会清掉「已结束」标记。
fn fallback_entry_check(rt: &mut Runtime, dir: &Path) {
    let mut apps: Vec<PathBuf> = Vec::new();
    if let Ok(rd) = std::fs::read_dir(dir) {
        for e in rd.flatten() {
            let p = e.path();
            let name = p
                .file_name()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_default();
            if kind_of(&name) == Some(FileKind::Application) {
                apps.push(p);
            }
        }
    }
    if apps.is_empty() {
        return;
    }
    // 轮转后的文件带序号（application_000.log / _001.log …），按名字排最后的最新
    apps.sort();
    let Some(path) = apps.last() else { return };
    let Some(line) = tail_last_entry(path) else {
        return;
    };
    let ts = timestamp_of(&line);
    // 只采纳「比已处理的那条更新」的记录：既不重复，也不回退到上一局
    if ts > rt.last_entry_ts {
        rt.handle_line(FileKind::Application, &line);
    }
}

/// 找到最新会话目录（`log_yyyy.MM.dd_H-mm-ss_xxx`）。
/// 按目录修改时间取最新（正在写入的那个），时间取不到时退回目录名字典序
/// —— 目录名里的小时可能是 1 位（`9-03-41`），纯字典序跨小时会排错。
/// 也兼容用户在设置里直接选中了某个会话目录。
fn pick_session(root: &Path) -> Result<(PathBuf, String), String> {
    if !root.is_dir() {
        return Err(format!("日志目录不存在：{}", root.display()));
    }
    let mut best: Option<(u128, String, PathBuf)> = None;
    if let Ok(rd) = std::fs::read_dir(root) {
        for e in rd.flatten() {
            let p = e.path();
            if !p.is_dir() {
                continue;
            }
            let name = p
                .file_name()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_default();
            if !name.starts_with("log_") {
                continue;
            }
            let mtime = std::fs::metadata(&p)
                .and_then(|m| m.modified())
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_millis())
                .unwrap_or(0);
            let newer = match &best {
                None => true,
                Some((m, n, _)) => mtime > *m || (mtime == *m && name > *n),
            };
            if newer {
                best = Some((mtime, name, p));
            }
        }
    }
    if let Some((_, name, path)) = best {
        return Ok((path, name));
    }
    // 直接选中了会话目录
    if has_log_files(root) {
        let name = root
            .file_name()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_default();
        return Ok((root.to_path_buf(), name));
    }
    Err("等待游戏创建日志会话…".into())
}

fn has_log_files(dir: &Path) -> bool {
    std::fs::read_dir(dir)
        .map(|rd| {
            rd.flatten().any(|e| {
                e.path()
                    .extension()
                    .and_then(|x| x.to_str())
                    .map_or(false, |x| x.eq_ignore_ascii_case("log"))
            })
        })
        .unwrap_or(false)
}

/// 按文件名分类。游戏会话目录里的日志名可能带时间戳前缀
/// （`... application_000.log`），所以用包含判断而不是前缀。
fn kind_of(name: &str) -> Option<FileKind> {
    let lower = name.to_ascii_lowercase();
    if !lower.ends_with(".log") {
        return None;
    }
    if lower.contains("aidata") {
        Some(FileKind::Ai)
    } else if lower.contains("application") {
        Some(FileKind::Application)
    } else if lower.contains("backend") {
        Some(FileKind::Backend)
    } else {
        None
    }
}

/// 追加一条时间记录：同一时间点只留一条（防止同一行被重复投递），最多保留 50 条
fn push_recent(v: &mut Vec<String>, ts: String) {
    if v.last() == Some(&ts) {
        return;
    }
    v.push(ts);
    if v.len() > 50 {
        v.remove(0);
    }
}

/// 行首的日志时间戳（`yyyy-MM-dd HH:mm:ss.fff`），没有则 None
fn ts_key(line: &str) -> Option<&str> {
    if line.len() >= 23 && line.as_bytes().get(4) == Some(&b'-') {
        line.get(..23)
    } else {
        None
    }
}

fn timestamp_of(line: &str) -> String {
    ts_key(line).map(|s| s.to_string()).unwrap_or_else(now)
}

fn now() -> String {
    chrono::Local::now()
        .format("%Y-%m-%d %H:%M:%S")
        .to_string()
}

/// 日志里的 location id（bigmap / factory4_day …）→ tarkov.dev 的 normalizedName
fn canon_map(loc: &str) -> String {
    match loc.trim().to_ascii_lowercase().as_str() {
        "bigmap" | "customs" => "customs",
        "factory4_day" | "factory4_night" | "factory" | "night-factory" => "factory",
        "interchange" => "interchange",
        "laboratory" | "laboratory_dark" | "the-lab" | "lab" => "the-lab",
        "lighthouse" => "lighthouse",
        "rezervbase" | "reserve" => "reserve",
        "sandbox" | "sandbox_high" | "sandbox_start" | "ground-zero" | "ground-zero-21"
        | "ground-zero-tutorial" => "ground-zero",
        "shoreline" => "shoreline",
        "tarkovstreets" | "streets" | "streets-of-tarkov" => "streets-of-tarkov",
        "woods" | "wood" => "woods",
        "labyrinth" | "the-labyrinth" => "the-labyrinth",
        "icebreaker" => "icebreaker",
        "terminal" => "terminal",
        other => other,
    }
    .to_string()
}

/// 地图中文名：取自地图骨架（随包数据的 nameZh），取不到就退化为 nn
fn map_zh(nn: &str) -> String {
    if nn.is_empty() {
        return String::new();
    }
    let s = crate::dataset::store();
    if let Some(groups) = s.skeleton.get("groups").and_then(|v| v.as_array()) {
        for g in groups {
            if g.get("normalizedName").and_then(|v| v.as_str()) == Some(nn) {
                if let Some(zh) = g.get("nameZh").and_then(|v| v.as_str()) {
                    if !zh.is_empty() {
                        return zh.to_string();
                    }
                }
                break;
            }
        }
    }
    nn.to_string()
}

/* ---------------- 命令 ---------------- */

fn runtime() -> &'static Arc<Mutex<Runtime>> {
    static RT: OnceLock<Arc<Mutex<Runtime>>> = OnceLock::new();
    RT.get_or_init(|| Arc::new(Mutex::new(Runtime::default())))
}

fn settings_path(app: &AppHandle) -> Option<PathBuf> {
    crate::data_root(app).ok().map(|r| r.join(SETTINGS_FILE))
}

fn save_settings(app: &AppHandle, s: &BossSettings) -> Result<(), String> {
    let p = settings_path(app).ok_or("无法确定数据目录")?;
    if let Some(parent) = p.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let text = serde_json::to_string_pretty(s).map_err(|e| e.to_string())?;
    std::fs::write(&p, text).map_err(|e| format!("保存 Boss 监控设置失败：{e}"))
}

/// 当前快照。`force` = 清掉增量偏移，从会话日志开头重新回放
/// （进图检测漏了时的手动兜底；也能立刻把「最近一次进图记录」捞回来）。
#[tauri::command]
pub fn boss_get_state(app: AppHandle, force: Option<bool>) -> BossMonitorPayload {
    let rt = runtime();
    let mut g = rt.lock().unwrap();
    if force.unwrap_or(false) {
        g.reset_scan();
    }
    poll(&app, &mut g);
    g.snapshot()
}

#[tauri::command]
pub fn boss_set_enabled(app: AppHandle, enabled: bool) -> Result<BossMonitorPayload, String> {
    let rt = runtime();
    let mut g = rt.lock().unwrap();
    g.settings.enabled = enabled;
    if enabled {
        g.diagnostic = "正在连接日志…".into();
        // 启用监控 = 需要详细 AI 日志：顺手把 Logging.config 的 aiData 调到 Trace。
        // 失败不阻断启用（可能没配游戏目录 / 没有写权限），前端会按配置状态给出提示。
        let _ = apply_logging_inner(&app, &mut g.settings);
    } else {
        g.reset_scan();
        g.diagnostic = "监控已关闭".into();
        // 关闭监控 = 不再需要详细日志：把 aiData 改回原始级别 Error
        let _ = restore_logging_inner(&app, &mut g.settings);
    }
    g.last_emit.clear();
    save_settings(&app, &g.settings)?;
    poll(&app, &mut g);
    Ok(g.snapshot())
}

#[tauri::command]
pub fn boss_set_notify(app: AppHandle, notify: bool) -> Result<BossMonitorPayload, String> {
    let rt = runtime();
    let mut g = rt.lock().unwrap();
    g.settings.notify = notify;
    save_settings(&app, &g.settings)?;
    g.last_emit.clear();
    poll(&app, &mut g);
    Ok(g.snapshot())
}

/// 解析后是否自动清理 aiData 日志（只清 AI 详细日志，不动其它日志）。
#[tauri::command]
pub fn boss_set_clean(app: AppHandle, clean: bool) -> Result<BossMonitorPayload, String> {
    let rt = runtime();
    let mut g = rt.lock().unwrap();
    g.settings.clean_ai = clean;
    if !clean {
        g.clean_note.clear();
    }
    save_settings(&app, &g.settings)?;
    g.last_emit.clear();
    poll(&app, &mut g);
    Ok(g.snapshot())
}

#[tauri::command]
pub fn boss_logging_status(app: AppHandle) -> LoggingStatus {
    let rt = runtime();
    let mut g = rt.lock().unwrap();
    let st = build_status(&app, &g.settings);
    remember_config(&app, &mut g.settings, &st);
    st
}

#[tauri::command]
pub fn boss_set_game_root(app: AppHandle, path: String) -> Result<LoggingStatus, String> {
    let p = PathBuf::from(path.trim().trim_matches('"'));
    if !p.exists() {
        return Err(format!("目录不存在：{}", p.display()));
    }
    let rt = runtime();
    let mut g = rt.lock().unwrap();
    if p.is_file() {
        g.settings.config_path = p.display().to_string();
        if let Some(parent) = p.parent() {
            g.settings.game_root = parent.display().to_string();
        }
    } else {
        g.settings.game_root = p.display().to_string();
        let cfg = p.join(CONFIG_NAME);
        g.settings.config_path = if cfg.is_file() {
            cfg.display().to_string()
        } else {
            String::new()
        };
    }
    save_settings(&app, &g.settings)?;
    let st = build_status(&app, &g.settings);
    remember_config(&app, &mut g.settings, &st);
    g.last_emit.clear();
    Ok(st)
}

/// 一键把 aiData 的 minLevel 改成 Trace（不记录原值、不写备份文件）
#[tauri::command]
pub fn boss_apply_logging(app: AppHandle) -> Result<LoggingStatus, String> {
    let rt = runtime();
    let mut g = rt.lock().unwrap();
    apply_logging_inner(&app, &mut g.settings)?;
    Ok(build_status(&app, &g.settings))
}

/// 一键恢复：固定把 aiData 的 minLevel 写回原始级别 `Error`。
#[tauri::command]
pub fn boss_restore_logging(app: AppHandle) -> Result<LoggingStatus, String> {
    let rt = runtime();
    let mut g = rt.lock().unwrap();
    restore_logging_inner(&app, &mut g.settings)?;
    Ok(build_status(&app, &g.settings))
}

fn apply_logging_inner(app: &AppHandle, s: &mut BossSettings) -> Result<(), String> {
    let path = resolve_config(app, s)
        .ok_or("找不到 Logging.config：请选择游戏安装目录（含 EscapeFromTarkov.exe）")?;
    let text = std::fs::read_to_string(&path)
        .map_err(|e| format!("读取 {} 失败：{e}", path.display()))?;
    // 先确认是合法 JSON，坏文件不写回
    if serde_json::from_str::<serde_json::Value>(&text).is_err() {
        return Err("Logging.config 不是合法的 JSON，已中止修改".into());
    }
    let next = set_ai_level(&text, "Trace")?;
    if next != text {
        std::fs::write(&path, next)
            .map_err(|e| format!("写入 {} 失败：{e}（可能需要管理员权限）", path.display()))?;
    }
    s.config_path = path.display().to_string();
    if let Some(parent) = path.parent() {
        s.game_root = parent.display().to_string();
    }
    save_settings(app, s)?;
    Ok(())
}

/// 把 aiData 写回 `Error`。不依赖任何记录或备份；但只在当前值仍是本工具写入的
/// `Trace` 时才动手 —— 已被手动改过（例如自己调成 Debug）就拒绝还原，
/// 避免把用户设置降回去（参考实现 tarkov-boss 也拒绝自动恢复被外部改动的配置）。
fn restore_logging_inner(app: &AppHandle, s: &mut BossSettings) -> Result<(), String> {
    let path = resolve_config(app, s)
        .ok_or("找不到 Logging.config：请选择游戏安装目录（含 EscapeFromTarkov.exe）")?;
    let text = std::fs::read_to_string(&path)
        .map_err(|e| format!("读取 {} 失败：{e}", path.display()))?;
    let current = ai_level(&text).ok_or("配置里没有 fileName 为 aiData 的规则")?;
    if !current.eq_ignore_ascii_case("Trace") {
        return Err(format!(
            "当前 aiData 级别是 {current}，不是本工具写入的 Trace。\n\
             可能已被手动或其它工具改过，已拒绝自动还原，请自行确认后修改。"
        ));
    }
    let next = set_ai_level(&text, ORIGINAL_AI_LEVEL)?;
    if next != text {
        std::fs::write(&path, next)
            .map_err(|e| format!("写入 {} 失败：{e}（可能需要管理员权限）", path.display()))?;
    }
    s.config_path = path.display().to_string();
    save_settings(app, s)?;
    Ok(())
}

fn remember_config(app: &AppHandle, s: &mut BossSettings, st: &LoggingStatus) {
    if st.found && st.config_path != s.config_path {
        s.config_path = st.config_path.clone();
        let _ = save_settings(app, s);
    }
}

fn build_status(app: &AppHandle, s: &BossSettings) -> LoggingStatus {
    let mut st = LoggingStatus {
        config_path: s.config_path.clone(),
        found: false,
        ai_data_level: String::new(),
        patched: false,
        restore_target: ORIGINAL_AI_LEVEL.to_string(),
        game_root: s.game_root.clone(),
        error: None,
    };
    let Some(path) = resolve_config(app, s) else {
        st.error = Some(
            "未找到 Logging.config。请点「选择游戏目录」指定游戏安装目录（与 EscapeFromTarkov.exe 同级）。"
                .into(),
        );
        return st;
    };
    st.config_path = path.display().to_string();
    st.found = true;
    match std::fs::read_to_string(&path) {
        Ok(text) => match ai_level(&text) {
            Some(level) => {
                st.patched = level.eq_ignore_ascii_case("Trace");
                st.ai_data_level = level;
            }
            None => st.error = Some("配置里没有 fileName 为 aiData 的规则".into()),
        },
        Err(e) => st.error = Some(format!("读取配置失败：{e}")),
    }
    st
}

fn ai_level(text: &str) -> Option<String> {
    let doc: serde_json::Value = serde_json::from_str(text).ok()?;
    let rules = doc.get("rules")?.as_array()?;
    for r in rules {
        let name = r.get("fileName").and_then(|v| v.as_str()).unwrap_or("");
        if name.eq_ignore_ascii_case("aiData") {
            return Some(
                r.get("minLevel")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string(),
            );
        }
    }
    None
}

/// 只替换 aiData 规则的 minLevel 文本，尽量不破坏原文件格式与键顺序
fn set_ai_level(text: &str, level: &str) -> Result<String, String> {
    if level.trim().is_empty() {
        return Err("目标日志级别为空，已中止".into());
    }
    for re in [&*RE_AI_LEVEL, &*RE_AI_LEVEL_ALT] {
        if let Some(c) = re.captures(text) {
            let g = c.get(1).unwrap();
            if g.as_str() == level {
                return Ok(text.to_string());
            }
            let mut out = String::with_capacity(text.len() + 8);
            out.push_str(&text[..g.start()]);
            out.push_str(level);
            out.push_str(&text[g.end()..]);
            return Ok(out);
        }
    }
    // 没有 aiData 规则：解析 JSON 后补一条
    let mut doc: serde_json::Value =
        serde_json::from_str(text).map_err(|e| format!("Logging.config 不是合法 JSON：{e}"))?;
    let rules = doc
        .get_mut("rules")
        .and_then(|v| v.as_array_mut())
        .ok_or("Logging.config 结构异常：缺少 rules 数组")?;
    rules.push(serde_json::json!({ "fileName": "aiData", "minLevel": level }));
    let mut s = serde_json::to_string_pretty(&doc).map_err(|e| e.to_string())?;
    s.push('\n');
    Ok(s)
}

fn resolve_config(app: &AppHandle, s: &BossSettings) -> Option<PathBuf> {
    candidate_paths(app, s).into_iter().find(|p| p.is_file())
}

fn candidate_paths(app: &AppHandle, s: &BossSettings) -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = Vec::new();
    let mut push = |p: PathBuf| {
        if !out.contains(&p) {
            out.push(p);
        }
    };
    // 1) 显式记录过的配置文件 / 游戏目录
    if !s.config_path.is_empty() {
        let p = PathBuf::from(&s.config_path);
        if p.is_file() {
            push(p);
        }
    }
    if !s.game_root.is_empty() {
        let root = PathBuf::from(&s.game_root);
        push(root.join(CONFIG_NAME));
        // 用户可能选到 Logs / 子目录，往上找几层
        for up in root.ancestors().take(4) {
            push(up.join(CONFIG_NAME));
        }
    }
    // 2) 从日志目录逐级往上找（游戏把 Logs 放在安装目录时）
    let log_dir = {
        let st = app.state::<AppState>();
        let w = st.watch.lock().unwrap();
        w.log_dir.clone()
    };
    if !log_dir.is_empty() {
        for up in Path::new(&log_dir).ancestors().take(6) {
            push(up.join(CONFIG_NAME));
        }
    }
    // 3) 常见安装位置（Windows 上逐盘探测，只在打开工具页 / 点检测时执行）
    #[cfg(windows)]
    {
        for letter in b'C'..=b'Z' {
            let drive = format!("{}:\\", letter as char);
            if !Path::new(&drive).is_dir() {
                continue;
            }
            for sub in [
                "Battlestate Games\\EFT",
                "Battlestate Games\\EscapeFromTarkov",
                "EFT",
                "Escape from Tarkov",
                "Games\\EFT",
                "Games\\Escape from Tarkov",
                "Program Files\\Battlestate Games\\EFT",
            ] {
                push(Path::new(&drive).join(sub).join(CONFIG_NAME));
            }
        }
    }
    out
}
