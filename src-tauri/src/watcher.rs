use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use notify::{Event, RecursiveMode, Watcher};
use tauri::{AppHandle, Emitter, Manager};

use crate::data;
use crate::parser;
use crate::AppState;

pub struct WatcherHandle {
    _watcher: notify::RecommendedWatcher,
    _states: Arc<Mutex<HashMap<String, parser::ParseState>>>,
    _seen: Arc<Mutex<HashSet<String>>>,
}

impl WatcherHandle {
    // 释放（被 take 丢弃）即停止监听
    #[allow(dead_code)]
    pub fn stop(&self) {}
}

/// 启动对 log_dir 的递归监听，并立即做一次全量初始扫描。
/// 偏移量（每文件已读字节）来自 AppState.offsets（启动时已从数据库加载），
/// 因此初始扫描只会读到上次之后的新增内容，不会重复处理历史日志。
pub fn start(app: &AppHandle, dir: &str) -> Result<WatcherHandle, String> {
    let states: Arc<Mutex<HashMap<String, parser::ParseState>>> =
        Arc::new(Mutex::new(HashMap::new()));
    let seen: Arc<Mutex<HashSet<String>>> = Arc::new(Mutex::new(HashSet::new()));

    let app_c = app.clone();
    let states_c = states.clone();
    let seen_c = seen.clone();
    let mut watcher = notify::recommended_watcher(move |res: notify::Result<Event>| {
        if let Ok(ev) = res {
            for p in ev.paths {
                process_file(&app_c, &states_c, &seen_c, &p, true);
            }
        }
    })
    .map_err(|e| e.to_string())?;

    watcher
        .watch(Path::new(dir), RecursiveMode::Recursive)
        .map_err(|e| e.to_string())?;

    {
        let binding = app.state::<AppState>();
        let mut w = binding.watch.lock().unwrap();
        w.log_dir = dir.to_string();
        w.last_scan = Some(now());
        w.error = None;
    }
    scan_dir(app, dir, &states, &seen, false);
    crate::persist::save_all_from(app); // 落盘初始扫描结果 + 偏移

    // 周期性 rescan 兜底：notify 的 RecursiveMode 在新 session 目录（游戏启动/重启时新建）
    // 的 watch 注册存在时序竞态，可能漏掉新目录内文件的初始内容，导致整轮游戏不被识别。
    // 每 3 秒遍历一次 log_dir 下所有 .log，复用 offset 做增量读取，与 notify 互补。
    let r_app = app.clone();
    let r_dir = dir.to_string();
    let r_states = states.clone();
    let r_seen = seen.clone();
    thread::spawn(move || loop {
        thread::sleep(Duration::from_secs(3));
        scan_dir(&r_app, &r_dir, &r_states, &r_seen, true);
        crate::persist::save_all_from(&r_app); // 每次扫描后落盘（含新增任务与偏移）
        // 崩溃 / 强退不会写出图日志行，用进程存在性兜底停止 BTR 倒计时
        stop_raid_if_game_exited(&r_app);
    });

    Ok(WatcherHandle {
        _watcher: watcher,
        _states: states,
        _seen: seen,
    })
}

/// 遍历 dir 下所有 .log 文件（含子目录，即游戏的 session 目录），对每个文件做增量读取。
/// emit=false 用于初始扫描（不向前端报历史噪声），emit=true 用于实时/轮询（补报 notify 漏掉的新文件）。
fn scan_dir(
    app: &AppHandle,
    dir: &str,
    states: &Arc<Mutex<HashMap<String, parser::ParseState>>>,
    seen: &Arc<Mutex<HashSet<String>>>,
    emit: bool,
) {
    let root = Path::new(dir);
    let mut session_dirs: HashSet<String> = HashSet::new();
    if let Ok(entries) = std::fs::read_dir(root) {
        for e in entries.flatten() {
            let p = e.path();
            if p.is_dir() {
                session_dirs.insert(
                    p.file_name()
                        .map(|s| s.to_string_lossy().to_string())
                        .unwrap_or_default(),
                );
                if let Ok(files) = std::fs::read_dir(&p) {
                    for f in files.flatten() {
                        let fp = f.path();
                        if fp.extension().and_then(|x| x.to_str()) == Some("log") {
                            process_file(app, states, seen, &fp, emit);
                        }
                    }
                }
            } else if p.extension().and_then(|x| x.to_str()) == Some("log") {
                process_file(app, states, seen, &p, emit);
            }
        }
    }
    let binding = app.state::<AppState>();
    binding.watch.lock().unwrap().sessions = session_dirs.len();
}

fn process_file(
    app: &AppHandle,
    states: &Arc<Mutex<HashMap<String, parser::ParseState>>>,
    seen: &Arc<Mutex<HashSet<String>>>,
    path: &Path,
    emit: bool,
) {
    if path.extension().and_then(|x| x.to_str()) != Some("log") {
        return;
    }
    let meta = match std::fs::metadata(path) {
        Ok(m) => m,
        Err(_) => return,
    };
    let size = meta.len();
    let key = path.display().to_string();
    let mut truncated = false;
    let offset = {
        let binding = app.state::<AppState>();
        let o = binding.with_active(|md| md.offsets.get(&key).copied().unwrap_or(0));
        if o > size {
            // 文件被截断/轮转（如游戏重建会话），offset 失效，从头读并重置解析状态
            truncated = true;
            0
        } else {
            o
        }
    };
    if truncated {
        states.lock().unwrap().remove(&key);
    }

    use std::io::{Read, Seek, SeekFrom};
    let mut f = match std::fs::File::open(path) {
        Ok(f) => f,
        Err(_) => return,
    };
    if f.seek(SeekFrom::Start(offset)).is_err() {
        return;
    }
    let mut buf = Vec::new();
    if f.read_to_end(&mut buf).is_err() {
        return;
    }
    {
        let binding = app.state::<AppState>();
        binding.with_active(|md| {
            md.offsets.insert(key.clone(), size);
        });
    }
    let text = String::from_utf8_lossy(&buf);
    if text.is_empty() {
        return;
    }

    let source = path
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default();

    // 在锁内用持久化 ParseState 解析（未闭合的多行 JSON 会保留在 states 中，下次续解析）
    let events = {
        let mut g = states.lock().unwrap();
        parser::parse_chunk(&text, g.entry(key.clone()).or_default())
    };
    for ev in events {
        match ev {
            parser::RawEvent::Accept {
                quest_id,
                trader_id,
                event_id,
                timestamp,
                ..
            } => {
                let key2 = format!("acc|{event_id}");
                if !seen.lock().unwrap().insert(key2) {
                    continue;
                }
                let info = data::resolve_accept(&quest_id);
                {
                    let binding = app.state::<AppState>();
                    binding.with_active(|md| md.apply_accept(&quest_id, &info.name, &timestamp));
                }
                if emit {
                    crate::emit_accept(
                        app,
                        &quest_id,
                        &info.name,
                        &trader_id,
                        &info.trader_name,
                        &info.objectives,
                        &info.wiki,
                        info.min_level,
                        &timestamp,
                        &source,
                    );
                }
            }
            parser::RawEvent::CompleteNotif {
                quest_id,
                event_id,
                timestamp,
                ..
            } => {
                let key2 = format!("cmp|{event_id}");
                if !seen.lock().unwrap().insert(key2) {
                    continue;
                }
                let name = data::resolve_name(&quest_id);
                {
                    let binding = app.state::<AppState>();
                    binding.with_active(|md| md.apply_complete(&quest_id, &name, &timestamp));
                }
                if emit {
                    crate::emit_complete(app, &quest_id, &name, &timestamp, "通知", &source);
                }
            }
            parser::RawEvent::Progress {
                endpoint,
                key,
                timestamp,
                ..
            } => {
                if !emit {
                    continue; // 初始扫描不记录进度噪声
                }
                if !seen.lock().unwrap().insert(format!("prg|{key}")) {
                    continue;
                }
                {
                    let binding = app.state::<AppState>();
                    binding.with_active(|md| md.apply_progress(&endpoint, &timestamp));
                }
                crate::emit_progress(app, &endpoint, &timestamp, &source);
            }
            parser::RawEvent::Location {
                location_id,
                timestamp,
            } => {
                // 重扫 / 启动首扫只重建任务进度，不处理「进入地图」事件：
                // 当前地图只由实时事件决定，避免全量重扫把历史日志里最后一张地图
                // 当成「当前所在地图」而跳来跳去。
                if !emit {
                    continue;
                }
                // 实时事件更新当前地图（`apply_location` 的返回值只表示「状态是否变化」，
                // **不能**拿来决定要不要发事件，见下）
                {
                    let binding = app.state::<AppState>();
                    binding.with_active(|md| md.apply_location(&location_id));
                }
                // 战局起点：每次进图（含同一张图连打两局、转场到新图）都重置。
                let raid = {
                    let binding = app.state::<AppState>();
                    let mut r = binding.raid.lock().unwrap();
                    r.active = true;
                    r.location_id = Some(location_id.clone());
                    r.started_at = Some(timestamp.clone());
                    r.ended_at = None;
                    r.clone()
                };
                let _ = app.emit("raid-changed", &raid);
                // 每条「进图行」都发 map-changed，**不再按 locationId 去重**：
                // `current_map` 是持久化值（上次会话也会写），连打同一张图时
                // `apply_location` 返回 false，若因此不发事件，地图页就永远不跟随，
                // 「进入地图」提示也不会弹。日志偏移保证同一行只处理一次，重复发不存在。
                let _ = app.emit(
                    "map-changed",
                    serde_json::json!({ "locationId": location_id, "timestamp": timestamp }),
                );
            }
            parser::RawEvent::RaidEnd { timestamp } => {
                // 初始扫描不处理：历史日志里的出图行与当前状态无关
                if !emit {
                    continue;
                }
                // 只有确实在战局中才结束，避免进图前的 profile 切换行误判
                let raid = {
                    let binding = app.state::<AppState>();
                    let mut r = binding.raid.lock().unwrap();
                    if r.active {
                        r.active = false;
                        r.ended_at = Some(timestamp);
                        Some(r.clone())
                    } else {
                        None
                    }
                };
                if let Some(r) = raid {
                    let _ = app.emit("raid-changed", &r);
                }
            }
            parser::RawEvent::SessionMode { mode, timestamp } => {
                // 会话模式决定新事件写入哪一套数据：初始扫描静默切换，实时变化才 emit
                let target = crate::store::norm_mode(&mode);
                let changed = {
                    let binding = app.state::<AppState>();
                    let mut am = binding.active_mode.lock().unwrap();
                    if *am != target {
                        *am = target.clone();
                        true
                    } else {
                        false
                    }
                };
                if changed && emit {
                    let _ = app.emit(
                        "session-mode",
                        serde_json::json!({ "mode": target, "timestamp": timestamp }),
                    );
                }
            }
        }
    }
}

/// 游戏进程已退出但没收到出图事件（崩溃 / 强退）时，结束战局并广播。
/// 只在战局进行中才查询进程，平时没有额外开销。
fn stop_raid_if_game_exited(app: &AppHandle) {
    let active = {
        let st = app.state::<AppState>();
        let r = st.raid.lock().unwrap();
        r.active
    };
    if !active || game_running() {
        return;
    }
    let payload = {
        let st = app.state::<AppState>();
        let mut r = st.raid.lock().unwrap();
        if !r.active {
            return;
        }
        r.active = false;
        r.ended_at = Some(now());
        r.clone()
    };
    let _ = app.emit("raid-changed", &payload);
}

/// 游戏主进程是否在运行。
/// 查询失败时保守地当作「仍在运行」，避免一次偶发失败就结束计时。
#[cfg(windows)]
fn game_running() -> bool {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    std::process::Command::new("tasklist")
        .args(["/FI", "IMAGENAME eq EscapeFromTarkov.exe", "/NH"])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .map(|o| {
            String::from_utf8_lossy(&o.stdout)
                .to_ascii_lowercase()
                .contains("escapefromtarkov.exe")
        })
        .unwrap_or(true)
}

/// 非 Windows 平台没有本机日志监控（移动端日志由电脑端推来），不额外判定
#[cfg(not(windows))]
fn game_running() -> bool {
    true
}

fn now() -> String {
    chrono::Local::now()
        .format("%Y-%m-%d %H:%M:%S")
        .to_string()
}
