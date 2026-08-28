use once_cell::sync::Lazy;
use regex::Regex;
use serde::Deserialize;

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
/// 进入 raid 时 application 行：`[Transit] Flag:None, RaidId:..., Count:0, Locations:Sandbox_start -> `
static RE_LOCATION: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"Locations:([A-Za-z0-9_]+)").unwrap());

#[derive(Debug, Clone)]
pub enum RawEvent {
    Accept {
        quest_id: String,
        trader_id: String,
        event_id: String,
        timestamp: String,
        source: String,
    },
    CompleteNotif {
        quest_id: String,
        event_id: String,
        timestamp: String,
        source: String,
    },
    Progress {
        endpoint: String,
        key: String,
        timestamp: String,
        source: String,
    },
    Location {
        location_id: String,
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
        } else if let Some(urlcap) = RE_URL.captures(line) {
            let url = urlcap.get(1).unwrap().as_str();
            let key = make_progress_key(line, url, &st.cur_ts);
            if RE_QUEST_COMPLETE.is_match(url) {
                out.push(RawEvent::Progress {
                    endpoint: "client/quest/complete (提交完成)".to_string(),
                    key,
                    timestamp: st.cur_ts.clone(),
                    source: String::new(),
                });
            } else if RE_QUEST_LIST.is_match(url) {
                out.push(RawEvent::Progress {
                    endpoint: "client/quest/list (同步任务列表)".to_string(),
                    key,
                    timestamp: st.cur_ts.clone(),
                    source: String::new(),
                });
            }
        } else if line.contains("RaidId") {
            if let Some(cap) = RE_LOCATION.captures(line) {
                out.push(RawEvent::Location {
                    location_id: cap.get(1).unwrap().as_str().to_string(),
                    timestamp: st.cur_ts.clone(),
                });
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
        #[serde(default)]
        text: String,
    }

    let cleaned = RE_TRAIL_COMMA.replace_all(json, "$1");
    let n: Notif = serde_json::from_str(&cleaned).ok()?;
    let cap = RE_TEMPLATE.captures(&n.message.template_id)?;
    let quest_id = cap.get(1).unwrap().as_str().to_string();
    let suffix = cap.get(2).unwrap().as_str();
    let source = String::new();

    match suffix {
        "description" => Some(RawEvent::Accept {
            quest_id,
            trader_id: n.dialog_id,
            event_id: n.event_id,
            timestamp: ts.to_string(),
            source,
        }),
        "successMessageText" => Some(RawEvent::CompleteNotif {
            quest_id,
            event_id: n.event_id,
            timestamp: ts.to_string(),
            source,
        }),
        _ => None,
    }
}
