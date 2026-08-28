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
        let mut st = binding.store.lock().unwrap();
        st.log_dir = dir.to_string();
        st.last_scan = Some(now());
        st.error = None;
    }
    scan_dir(app, dir, &states, &seen, false);
    crate::persist::save(app); // 落盘初始扫描结果 + 偏移

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
        crate::persist::save(&r_app); // 每次扫描后落盘（含新增任务与偏移）
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
    let mut st = binding.store.lock().unwrap();
    st.sessions = session_dirs.len();
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
        let g = binding.offsets.lock().unwrap();
        let o = g.get(&key).copied().unwrap_or(0);
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
        let mut g = binding.offsets.lock().unwrap();
        g.insert(key.clone(), size);
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
                    let mut st = binding.store.lock().unwrap();
                    st.apply_accept(&quest_id, &info.name, &timestamp);
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
                    let mut st = binding.store.lock().unwrap();
                    st.apply_complete(&quest_id, &name, &timestamp);
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
                    let mut st = binding.store.lock().unwrap();
                    st.apply_progress(&endpoint, &timestamp);
                }
                crate::emit_progress(app, &endpoint, &timestamp, &source);
            }
            parser::RawEvent::Location {
                location_id,
                timestamp,
            } => {
                // 无论初始扫描还是实时事件都要更新当前地图（并去重：地图未变不重复 emit）
                let changed = {
                    let binding = app.state::<AppState>();
                    let mut st = binding.store.lock().unwrap();
                    st.apply_location(&location_id)
                };
                if changed && emit {
                    let _ = app.emit(
                        "map-changed",
                        serde_json::json!({ "locationId": location_id, "timestamp": timestamp }),
                    );
                }
            }
            parser::RawEvent::SessionMode { mode, timestamp } => {
                // 会话模式（pve/pvp）：初始扫描静默更新 store，实时检测到变化才 emit
                let changed = {
                    let binding = app.state::<AppState>();
                    let mut st = binding.store.lock().unwrap();
                    st.apply_session_mode(&mode)
                };
                if changed && emit {
                    let _ = app.emit(
                        "session-mode",
                        serde_json::json!({ "mode": mode, "timestamp": timestamp }),
                    );
                }
            }
        }
    }
}

fn now() -> String {
    chrono::Local::now()
        .format("%Y-%m-%d %H:%M:%S")
        .to_string()
}
