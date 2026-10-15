use once_cell::sync::Lazy;
use regex::Regex;
use serde::Deserialize;
use std::path::{Path, PathBuf};

static RE_TS: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\.\d{3}").unwrap()
});
static RE_CHAT: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"Got notification \| ChatMessageReceived").unwrap());
static RE_URL: Lazy<Regex> = Lazy::new(|| Regex::new(r"URL:\s*(https?://[^\s]+)").unwrap());
static RE_HTTPID: Lazy<Regex> = Lazy::new(|| Regex::new(r"id \[(\d+)\]").unwrap());
static RE_QUEST_COMPLETE: Lazy<Regex> = Lazy::new(|| Regex::new(r"client/quest/complete").unwrap());
static RE_QUEST_LIST: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"client/quest/(?:list|chains|getMainQuestsList|getMainQuestNotesList)|client/completable-item/quests/list").unwrap()
});
static RE_TEMPLATE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"^([0-9a-fA-F]{24})\s+(\w+)$").unwrap());
static RE_TRAIL_COMMA: Lazy<Regex> = Lazy::new(|| Regex::new(r",(\s*[}\]])").unwrap());
/// application 行的地图链：
/// - 进入 raid：`[Transit] Flag:None, RaidId:..., Count:0, Locations:Sandbox_start -> `
/// - 地图转移：`[Transit] Flag:Common, RaidId:..., Count:1, Locations:bigmap -> factory4_day -> `
///
/// 转移时是「源 -> 目标」链，**最后一个**才是当前所在地图；
/// 只取第一个会导致转移后仍停留在原地图（不会跟随切换）。
static RE_LOCATION: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"Locations:([A-Za-z0-9_\-]*(?:\s*->\s*[A-Za-z0-9_\-]*)*)").unwrap()
});
/// 会话模式行（application_000.log 启动时一行）：`Session mode: Pve` / `Session mode: Pvp`
static RE_SESSION_MODE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"(?i)Session mode:\s*(Pve|Pvp)").unwrap());
/// 后端网关域名兜底：PvE 走 `gw-pve.escapefromtarkov.ru`，PvP 走 `gw-pvp.*`。
/// 注意 `client/game/mode` 恒走 gw-pvp（启动器模式查询），不能作为判别依据。
static RE_GW_MODE: Lazy<Regex> = Lazy::new(|| Regex::new(r"https?://gw-(pve|pvp)\.").unwrap());

#[derive(Debug, Clone)]
pub enum RawEvent {
    Accept {
        quest_id: String,
        trader_id: String,
        event_id: String,
        timestamp: String,
    },
    CompleteNotif {
        quest_id: String,
        event_id: String,
        timestamp: String,
    },
    Progress {
        endpoint: String,
        key: String,
        timestamp: String,
    },
    Location {
        location_id: String,
        timestamp: String,
    },
    /// 会话模式（"pve" | "pvp"），主来源为 `Session mode:` 行，兜底为网关域名
    SessionMode {
        mode: String,
        timestamp: String,
    },
}

fn full_ts(line: &str) -> Option<String> {
    RE_TS
        .captures(line)
        .map(|c| c.get(1).unwrap().as_str().to_string())
}

/// 解析状态：在多次增量读取之间保持，避免实时监听截断多行 JSON 时丢事件。
#[derive(Default, Clone)]
pub struct ParseState {
    pub in_json: bool,
    pub depth: i32,
    pub json_buf: String,
    pub cur_ts: String,
    /// 兜底网关域名已上报过（每文件只报一次，避免每条请求都产生事件）
    pub mode_sent: bool,
}

/// 解析一段日志文本，返回其中的接取 / 完成 / 进度事件。
/// 兼容美化后的多行 JSON（含嵌套花括号、尾逗号）。
///
/// `st` 跨多次 `process_file` 调用持久化：若本次读取在一条多行 JSON 中途结束，
/// 未闭合的部分保留在 `st` 中，下次读取时续解析，避免实时增量读取截断丢事件。
pub fn parse_chunk(text: &str, st: &mut ParseState) -> Vec<RawEvent> {
    let mut out = Vec::new();
    let lines: Vec<&str> = text.lines().collect();
    let mut i = 0;

    while i < lines.len() {
        let line = lines[i];
        if let Some(ts) = full_ts(line) {
            st.cur_ts = ts;
        }

        if st.in_json {
            // 安全护栏：单条 JSON 异常超大（之前某次截断后一直未闭合），重置避免永久阻塞后续事件
            if st.json_buf.len() > 4_000_000 {
                st.in_json = false;
                st.depth = 0;
                st.json_buf.clear();
            }
            for ch in line.chars() {
                match ch {
                    '{' => st.depth += 1,
                    '}' => st.depth -= 1,
                    _ => {}
                }
            }
            st.json_buf.push_str(line);
            st.json_buf.push('\n');
            if st.depth <= 0 {
                if let Some(ev) = parse_notif(&st.json_buf, &st.cur_ts) {
                    out.push(ev);
                }
                st.in_json = false;
                st.depth = 0;
                st.json_buf.clear();
            }
        } else if RE_CHAT.is_match(line) {
            st.in_json = true;
            st.depth = 0;
            st.json_buf.clear();
        } else if let Some(cap) = RE_SESSION_MODE.captures(line) {
            // 权威来源：`Session mode: Pve/Pvp`（每文件首个命中即上报，store 侧按值去重）
            if !st.mode_sent {
                st.mode_sent = true;
                out.push(RawEvent::SessionMode {
                    mode: cap.get(1).unwrap().as_str().to_lowercase(),
                    timestamp: st.cur_ts.clone(),
                });
            }
        } else if let Some(urlcap) = RE_URL.captures(line) {
            let url = urlcap.get(1).unwrap().as_str();
            // 网关域名兜底：文件未出现 Session mode: 行时，用请求域名判别。
            // `client/game/mode` 恒走 gw-pvp（启动器模式查询），排除。
            if !st.mode_sent && !url.contains("client/game/mode") {
                if let Some(cap) = RE_GW_MODE.captures(line) {
                    st.mode_sent = true;
                    out.push(RawEvent::SessionMode {
                        mode: cap.get(1).unwrap().as_str().to_lowercase(),
                        timestamp: st.cur_ts.clone(),
                    });
                }
            }
            let key = make_progress_key(line, url, &st.cur_ts);
            if RE_QUEST_COMPLETE.is_match(url) {
                out.push(RawEvent::Progress {
                    endpoint: "client/quest/complete (提交完成)".to_string(),
                    key,
                    timestamp: st.cur_ts.clone(),
                });
            } else if RE_QUEST_LIST.is_match(url) {
                out.push(RawEvent::Progress {
                    endpoint: "client/quest/list (同步任务列表)".to_string(),
                    key,
                    timestamp: st.cur_ts.clone(),
                });
            }
        } else if line.contains("RaidId") {
            if let Some(cap) = RE_LOCATION.captures(line) {
                // 取地图链的最后一个非空段：转移时形如 `bigmap -> factory4_day ->`
                let chain = cap.get(1).map(|m| m.as_str()).unwrap_or("");
                let last = chain
                    .split("->")
                    .map(|s| s.trim())
                    .filter(|s| !s.is_empty())
                    .last()
                    .unwrap_or("");
                if !last.is_empty() {
                    out.push(RawEvent::Location {
                        location_id: last.to_string(),
                        timestamp: st.cur_ts.clone(),
                    });
                }
            }
        }

        i += 1;
    }

    out
}

fn make_progress_key(line: &str, url: &str, ts: &str) -> String {
    let id = RE_HTTPID
        .captures(line)
        .and_then(|c| c.get(1))
        .map(|m| m.as_str())
        .unwrap_or("");
    format!("{ts}|{url}|{id}")
}

fn parse_notif(json: &str, ts: &str) -> Option<RawEvent> {
    #[derive(Deserialize)]
    struct Notif {
        #[serde(rename = "eventId")]
        event_id: String,
        #[serde(rename = "dialogId")]
        dialog_id: String,
        #[serde(default)]
        message: NotifMsg,
    }
    #[derive(Deserialize, Default)]
    struct NotifMsg {
        #[serde(rename = "templateId", default)]
        template_id: String,
    }

    let cleaned = RE_TRAIL_COMMA.replace_all(json, "$1");
    let n: Notif = serde_json::from_str(&cleaned).ok()?;
    let cap = RE_TEMPLATE.captures(&n.message.template_id)?;
    let quest_id = cap.get(1).unwrap().as_str().to_string();
    let suffix = cap.get(2).unwrap().as_str();

    match suffix {
        "description" => Some(RawEvent::Accept {
            quest_id,
            trader_id: n.dialog_id,
            event_id: n.event_id,
            timestamp: ts.to_string(),
        }),
        "successMessageText" => Some(RawEvent::CompleteNotif {
            quest_id,
            event_id: n.event_id,
            timestamp: ts.to_string(),
        }),
        _ => None,
    }
}

// ---------------- 日志精简 ----------------

/// 精简日志结果（前端提示用）
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SimplifyResult {
    /// 日志目录
    pub dir: String,
    /// 扫描到的 .log 文件数
    pub files: usize,
    /// 实际被裁剪的文件数
    pub trimmed_files: usize,
    /// 跳过的文件数（正在写入 / 读取或写入失败）
    pub skipped_files: usize,
    /// 删除的行数
    pub removed_lines: usize,
    /// 保留的行数
    pub kept_lines: usize,
    /// 原始总行数
    pub total_lines: usize,
    /// 节省的字节数
    pub bytes_saved: u64,
}

/// 该行是否与任务相关（精简日志的保留规则）：
/// - 任务通知（接取 / 完成）的多行 JSON 起始行（后续 JSON 行由状态机一并保留）
/// - `Session mode:` 会话模式行（任务事件归属 pvp / pve 需要）
/// - 任务接口请求（提交完成 / 同步任务列表）
///
/// 进入地图（`Locations:` / `RaidId`）、资源加载等无关输出一律丢弃。
fn simplify_keep(line: &str) -> bool {
    if RE_CHAT.is_match(line) || RE_SESSION_MODE.is_match(line) {
        return true;
    }
    match RE_URL.captures(line) {
        Some(c) => {
            let url = c.get(1).unwrap().as_str();
            RE_QUEST_COMPLETE.is_match(url) || RE_QUEST_LIST.is_match(url)
        }
        None => false,
    }
}

/// 递归收集 dir 下的 .log 文件（游戏日志结构为 Logs/<会话目录>/*.log）
fn collect_logs(dir: &Path, depth: u32, out: &mut Vec<PathBuf>) {
    if depth > 6 {
        return;
    }
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return,
    };
    for e in entries.flatten() {
        let p = e.path();
        if p.is_dir() {
            collect_logs(&p, depth + 1, out);
        } else if p.extension().and_then(|x| x.to_str()) == Some("log") {
            out.push(p);
        }
    }
}

fn brace_delta(line: &str) -> i32 {
    let mut d = 0;
    for ch in line.chars() {
        match ch {
            '{' => d += 1,
            '}' => d -= 1,
            _ => {}
        }
    }
    d
}

/// 过滤一段日志文本：保留任务相关行，其余（进入地图等无关输出）丢弃。
/// 多行 JSON 通知块整体原样保留（仍可被 `parse_chunk` 再次解析），
/// 返回 (精简后文本, 保留行数, 总行数)。
fn filter_log_text(text: &str) -> (String, usize, usize) {
    let mut out = String::new();
    let mut kept = 0usize;
    let mut total = 0usize;
    // 与 parse_chunk 一致：通知行开启多行 JSON，闭合花括号结束
    let mut in_json = false;
    let mut depth = 0i32;
    // split_inclusive 保留行尾换行，写回时逐字节与原文件一致（仅少了被删的行）
    for line in text.split_inclusive('\n') {
        total += 1;
        let keep = if in_json {
            depth += brace_delta(line);
            if depth <= 0 {
                in_json = false;
                depth = 0;
            }
            true
        } else if RE_CHAT.is_match(line) {
            in_json = true;
            depth = 0;
            true
        } else {
            simplify_keep(line)
        };
        if keep {
            out.push_str(line);
            kept += 1;
        }
    }
    (out, kept, total)
}

/// 最近这么长时间内被写过的日志视为游戏仍在写入，跳过不裁剪（避免与游戏争抢同一文件）
const ACTIVE_SECS: u64 = 60;

/// 就地精简日志目录下的所有 `.log`：删除与任务无关的输出（进入地图 / 资源加载等），
/// **直接覆盖原文件**（不产生副本），使其只剩任务相关信息。
/// 正在写入的文件（mtime 在 `ACTIVE_SECS` 内）跳过，避免与游戏写文件冲突。
pub fn simplify_logs_in_place(dir: &Path) -> Result<SimplifyResult, String> {
    let mut files: Vec<PathBuf> = Vec::new();
    collect_logs(dir, 0, &mut files);
    if files.is_empty() {
        return Err(format!("日志目录下没有 .log 文件：{}", dir.display()));
    }
    files.sort(); // 会话目录名带时间前缀，排序即大致按时间先后

    let now = std::time::SystemTime::now();
    let mut res = SimplifyResult {
        dir: dir.to_string_lossy().into_owned(),
        files: files.len(),
        trimmed_files: 0,
        skipped_files: 0,
        removed_lines: 0,
        kept_lines: 0,
        total_lines: 0,
        bytes_saved: 0,
    };

    for f in &files {
        let meta = match std::fs::metadata(f) {
            Ok(m) => m,
            Err(_) => {
                res.skipped_files += 1;
                continue;
            }
        };
        let writing = meta
            .modified()
            .ok()
            .and_then(|t| now.duration_since(t).ok())
            .map(|d| d.as_secs() < ACTIVE_SECS)
            .unwrap_or(false);
        let text = match std::fs::read_to_string(f) {
            Ok(t) if !writing => t,
            _ => {
                res.skipped_files += 1;
                continue;
            }
        };
        let (kept, kept_lines, total_lines) = filter_log_text(&text);
        if kept_lines == total_lines {
            continue; // 没有可删的行，保持原文件不动
        }
        match std::fs::write(f, kept.as_bytes()) {
            Ok(()) => {
                res.total_lines += total_lines;
                res.kept_lines += kept_lines;
                res.trimmed_files += 1;
                res.removed_lines += total_lines - kept_lines;
                res.bytes_saved += meta.len().saturating_sub(kept.len() as u64);
            }
            Err(_) => res.skipped_files += 1,
        }
    }

    if res.trimmed_files == 0 && res.skipped_files == res.files {
        return Err("所有日志文件都在使用中或无法访问，未做任何裁剪".into());
    }
    Ok(res)
}
