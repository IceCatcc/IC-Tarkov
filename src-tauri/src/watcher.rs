use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use notify::{Event, RecursiveMode, Watcher};
use tauri::{AppHandle, Manager};

use crate::data;
use crate::parser;
use crate::AppState;

pub struct WatcherHandle {
    _watcher: notify::RecommendedWatcher,
    _paths: Arc<Mutex<HashMap<PathBuf, u64>>>,
    _seen: Arc<Mutex<HashSet<String>>>,
}

impl WatcherHandle {
    // 释放（被 take 丢弃）即停止监听
    #[allow(dead_code)]
    pub fn stop(&self) {}
}

/// 启动对 log_dir 的递归监听，并立即做一次全量初始扫描。
pub fn start(app: &AppHandle, dir: &str) -> Result<WatcherHandle, String> {
    let paths: Arc<Mutex<HashMap<PathBuf, u64>>> = Arc::new(Mutex::new(HashMap::new()));
    let seen: Arc<Mutex<HashSet<String>>> = Arc::new(Mutex::new(HashSet::new()));

    let app_c = app.clone();
    let paths_c = paths.clone();
    let seen_c = seen.clone();
    let mut watcher = notify::recommended_watcher(move |res: notify::Result<Event>| {
        if let Ok(ev) = res {
            for p in ev.paths {
                process_file(&app_c, &paths_c, &seen_c, &p, true);
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
    initial_scan(app, dir, &paths, &seen);

    Ok(WatcherHandle {
        _watcher: watcher,
        _paths: paths,
        _seen: seen,
    })
}

fn initial_scan(
    app: &AppHandle,
    dir: &str,
    paths: &Arc<Mutex<HashMap<PathBuf, u64>>>,
    seen: &Arc<Mutex<HashSet<String>>>,
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
                            process_file(app, paths, seen, &fp, false);
                        }
                    }
                }
            } else if p.extension().and_then(|x| x.to_str()) == Some("log") {
                process_file(app, paths, seen, &p, false);
            }
        }
    }
    let binding = app.state::<AppState>();
    let mut st = binding.store.lock().unwrap();
    st.sessions = session_dirs.len();
}

fn process_file(
    app: &AppHandle,
    paths: &Arc<Mutex<HashMap<PathBuf, u64>>>,
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
    let offset = {
        let mut g = paths.lock().unwrap();
        let o = g.get(path).copied().unwrap_or(0);
        if o > size {
            0
        } else {
            o
        }
    };

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
        let mut g = paths.lock().unwrap();
        g.insert(path.to_path_buf(), size);
    }
    let text = String::from_utf8_lossy(&buf);
    if text.is_empty() {
        return;
    }

    let source = path
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default();

    let events = parser::parse_chunk(&text);
    for ev in events {
        match ev {
            parser::RawEvent::Accept {
                quest_id,
                trader_id,
                event_id,
                timestamp,
                ..
            } => {
                let key = format!("acc|{event_id}");
                if !seen.lock().unwrap().insert(key) {
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
                let key = format!("cmp|{event_id}");
                if !seen.lock().unwrap().insert(key) {
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
        }
    }
}

fn now() -> String {
    chrono::Local::now()
        .format("%Y-%m-%d %H:%M:%S")
        .to_string()
}
