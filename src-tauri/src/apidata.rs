//! tarkov.dev 原始 API JSON 的本地缓存与在线刷新。
//!
//! 数据全部来自 json.tarkov.dev 的静态端点（端点目录见 https://json.tarkov.dev/endpoints），
//! 原始响应原样落盘，不做任何加工；派生索引由 dataset 模块在运行时构建。
//!
//! 目录约定：
//!   resources/api/*.json          随安装包分发的种子（由 scripts/fetch_api_data.py 抓取）
//!   <app_data_dir>/tarkov-api/    运行时缓存，软件端联网刷新时直接覆盖这里的文件

use std::collections::HashMap;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::{Emitter, Manager};

/// 缓存过期时间：超过这个秒数就认为数据可能过期（启动时的静默自动更新会触发）
pub const SYNC_INTERVAL_SECS: i64 = 7 * 24 * 3600;

pub struct Endpoint {
    /// 缓存文件名（同时也是种子文件名）
    pub file: &'static str,
    /// API 路径（不含 host）
    pub path: &'static str,
    /// 界面展示名
    pub label: &'static str,
}

/// 与 scripts/fetch_api_data.py 的 ENDPOINTS 保持一致
pub const ENDPOINTS: &[Endpoint] = &[
    Endpoint { file: "regular_tasks.json", path: "regular/tasks", label: "任务（PvP）" },
    Endpoint { file: "pve_tasks.json", path: "pve/tasks", label: "任务（PvE）" },
    Endpoint { file: "season_tasks.json", path: "pvp-season/tasks", label: "任务（赛季）" },
    Endpoint { file: "regular_tasks_zh.json", path: "regular/tasks_zh", label: "任务中文" },
    Endpoint { file: "pve_tasks_zh.json", path: "pve/tasks_zh", label: "任务中文（PvE）" },
    Endpoint { file: "regular_maps.json", path: "regular/maps", label: "地图数据" },
    Endpoint { file: "regular_maps_zh.json", path: "regular/maps_zh", label: "地图中文" },
    Endpoint { file: "regular_traders.json", path: "regular/traders", label: "商人" },
    Endpoint { file: "regular_traders_zh.json", path: "regular/traders_zh", label: "商人中文" },
    Endpoint { file: "regular_items_zh.json", path: "regular/items_zh", label: "物品中文" },
];

const BASE_URL: &str = "https://json.tarkov.dev";
const MANIFEST: &str = "manifest.json";

static SYNCING: AtomicBool = AtomicBool::new(false);

// ---------------- 清单 ----------------

#[derive(Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct FileInfo {
    pub bytes: u64,
    pub updated_at: i64,
}

#[derive(Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Manifest {
    #[serde(default)]
    pub version: u32,
    #[serde(default)]
    pub updated_at: i64,
    #[serde(default)]
    pub files: HashMap<String, FileInfo>,
}

fn now_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

// ---------------- 路径 ----------------

/// 运行时缓存目录：<app_data_dir>/tarkov-api
pub fn cache_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("无法定位应用数据目录：{e}"))?
        .join("tarkov-api");
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建缓存目录失败：{e}"))?;
    Ok(dir)
}

/// 随包分发的资源目录：优先 Tauri resource_dir，其次 exe 同目录，最后源码目录（开发态）
fn bundled_dir(app: &tauri::AppHandle, sub: Option<&str>) -> Option<PathBuf> {
    let mut cands: Vec<PathBuf> = Vec::new();
    if let Ok(res) = app.path().resource_dir() {
        cands.push(match sub {
            Some(s) => res.join(s),
            None => res.clone(),
        });
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            cands.push(match sub {
                Some(s) => parent.join(s),
                None => parent.to_path_buf(),
            });
        }
    }
    let dev = match sub {
        Some(s) => PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources").join(s),
        None => PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources"),
    };
    cands.push(dev);
    cands.into_iter().find(|d| d.is_dir())
}

/// 定位随包资源文件（如 maps-skeleton.json）
pub fn bundled_file(app: &tauri::AppHandle, name: &str) -> Option<PathBuf> {
    let dir = bundled_dir(app, None)?;
    let p = dir.join(name);
    if p.is_file() {
        Some(p)
    } else {
        None
    }
}

/// 种子目录（resources/api）
fn seed_dir(app: &tauri::AppHandle) -> Option<PathBuf> {
    bundled_dir(app, Some("api"))
}

/// 保证缓存目录里有完整可用的一套原始 JSON：缺失的从随包种子复制
pub fn ensure_cache(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = cache_dir(app)?;
    let seed = seed_dir(app);
    for ep in ENDPOINTS {
        let dst = dir.join(ep.file);
        if dst.is_file() {
            continue;
        }
        let Some(src) = seed.as_ref().map(|s| s.join(ep.file)).filter(|p| p.is_file()) else {
            continue;
        };
        if let Err(e) = std::fs::copy(&src, &dst) {
            eprintln!("[apidata] 复制种子失败 {}: {e}", ep.file);
        }
    }
    // 首轮种子复制后补写清单，保证「更新时间」有值
    let mut manifest = read_manifest(&dir);
    let mut changed = false;
    for ep in ENDPOINTS {
        let p = dir.join(ep.file);
        if !manifest.files.contains_key(ep.file) {
            if let Ok(meta) = std::fs::metadata(&p) {
                manifest.files.insert(
                    ep.file.to_string(),
                    FileInfo {
                        bytes: meta.len(),
                        updated_at: mtime_secs(&p),
                    },
                );
                changed = true;
            }
        }
    }
    if changed {
        if manifest.files.values().map(|f| f.updated_at).max().unwrap_or(0) > manifest.updated_at {
            manifest.updated_at = manifest.files.values().map(|f| f.updated_at).max().unwrap_or(0);
        }
        write_manifest(&dir, &manifest);
    }
    Ok(dir)
}

fn mtime_secs(p: &Path) -> i64 {
    std::fs::metadata(p)
        .and_then(|m| m.modified())
        .map(|t| {
            t.duration_since(UNIX_EPOCH)
                .map(|d| d.as_secs() as i64)
                .unwrap_or(0)
        })
        .unwrap_or(0)
}

fn read_manifest(dir: &Path) -> Manifest {
    std::fs::read_to_string(dir.join(MANIFEST))
        .ok()
        .and_then(|s| serde_json::from_str::<Manifest>(&s).ok())
        .unwrap_or_default()
}

fn write_manifest(dir: &Path, m: &Manifest) {
    if let Ok(json) = serde_json::to_string_pretty(m) {
        let _ = std::fs::write(dir.join(MANIFEST), json);
    }
}

// ---------------- 状态 ----------------

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DataFileStat {
    pub file: String,
    pub label: String,
    pub bytes: u64,
    pub updated_at: i64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DataStatus {
    /// 缓存目录里是否已有完整数据
    pub cached: bool,
    /// 最近一次更新时间（epoch 秒，0 = 未更新过）
    pub updated_at: i64,
    /// 是否过期（无清单或超过 SYNC_INTERVAL_SECS）
    pub stale: bool,
    pub syncing: bool,
    pub files: Vec<DataFileStat>,
}

pub fn status(app: &tauri::AppHandle) -> DataStatus {
    let dir = cache_dir(app);
    let manifest = dir.as_ref().map(|d| read_manifest(d)).unwrap_or_default();
    let mut files = Vec::new();
    let mut missing = 0usize;
    if let Ok(d) = &dir {
        for ep in ENDPOINTS {
            let p = d.join(ep.file);
            let (bytes, updated_at) = match std::fs::metadata(&p) {
                Ok(m) => (
                    m.len(),
                    manifest
                        .files
                        .get(ep.file)
                        .map(|f| f.updated_at)
                        .filter(|t| *t > 0)
                        .unwrap_or_else(|| mtime_secs(&p)),
                ),
                Err(_) => {
                    missing += 1;
                    (0, 0)
                }
            };
            files.push(DataFileStat {
                file: ep.file.to_string(),
                label: ep.label.to_string(),
                bytes,
                updated_at,
            });
        }
    }
    let updated_at = manifest.updated_at;
    DataStatus {
        cached: missing == 0,
        updated_at,
        stale: missing > 0 || now_secs() - updated_at > SYNC_INTERVAL_SECS,
        syncing: SYNCING.load(Ordering::SeqCst),
        files,
    }
}

// ---------------- 同步 ----------------

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncProgress {
    pub running: bool,
    pub done: usize,
    pub total: usize,
    pub label: String,
    pub force: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncReport {
    pub ok: bool,
    pub updated: Vec<String>,
    pub failed: Vec<String>,
    pub skipped: usize,
    pub updated_at: i64,
    pub message: String,
}

fn build_agent() -> Result<ureq::Agent, String> {
    Ok(ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(20))
        .timeout_read(Duration::from_secs(120))
        .timeout_write(Duration::from_secs(30))
        .build())
}

fn fetch_one(agent: &ureq::Agent, ep: &Endpoint) -> Result<Vec<u8>, String> {
    let url = format!("{BASE_URL}/{}", ep.path);
    let resp = agent
        .get(&url)
        .set("User-Agent", "ic-tarkov/1.0")
        // 明文返回，落盘即可直接解析
        .set("Accept-Encoding", "identity")
        .call()
        .map_err(|e| format!("{e}"))?;
    if resp.status() != 200 {
        return Err(format!("HTTP {}", resp.status()));
    }
    let mut buf = Vec::new();
    resp.into_reader()
        .take(256 * 1024 * 1024)
        .read_to_end(&mut buf)
        .map_err(|e| format!("读取响应失败：{e}"))?;
    if buf.is_empty() || (buf[0] != b'{' && buf[0] != b'[') {
        return Err("响应不是 JSON".to_string());
    }
    Ok(buf)
}

fn write_atomic(path: &Path, data: &[u8]) -> Result<(), String> {
    let tmp = path.with_extension("tmp");
    std::fs::write(&tmp, data).map_err(|e| format!("写入失败：{e}"))?;
    match std::fs::rename(&tmp, path) {
        Ok(()) => Ok(()),
        Err(e) => {
            let _ = std::fs::remove_file(&tmp);
            Err(format!("替换文件失败：{e}"))
        }
    }
}

/// 从 API 拉取全部端点并写入缓存（阻塞）。force=true 时忽略过期判断，全部重下。
pub fn sync(app: &tauri::AppHandle, force: bool) -> Result<SyncReport, String> {
    if SYNCING.compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst).is_err() {
        return Err("数据更新正在进行中".to_string());
    }
    let result = do_sync(app, force);
    SYNCING.store(false, Ordering::SeqCst);
    result
}

fn do_sync(app: &tauri::AppHandle, force: bool) -> Result<SyncReport, String> {
    let dir = ensure_cache(app)?;
    let agent = build_agent()?;
    let total = ENDPOINTS.len();
    let mut manifest = read_manifest(&dir);
    let mut updated: Vec<String> = Vec::new();
    let mut failed: Vec<String> = Vec::new();
    let mut skipped = 0usize;

    for (i, ep) in ENDPOINTS.iter().enumerate() {
        let _ = app.emit(
            "data-sync-progress",
            SyncProgress {
                running: true,
                done: i,
                total,
                label: ep.label.to_string(),
                force,
            },
        );
        let path = dir.join(ep.file);
        if !force {
            if let Ok(meta) = std::fs::metadata(&path) {
                let age = now_secs() - mtime_secs(&path);
                if meta.len() > 0 && age < SYNC_INTERVAL_SECS {
                    skipped += 1;
                    continue;
                }
            }
        }
        match fetch_one(&agent, ep) {
            Ok(bytes) => match write_atomic(&path, &bytes) {
                Ok(()) => {
                    let ts = now_secs();
                    manifest.files.insert(
                        ep.file.to_string(),
                        FileInfo {
                            bytes: bytes.len() as u64,
                            updated_at: ts,
                        },
                    );
                    manifest.updated_at = ts;
                    write_manifest(&dir, &manifest);
                    updated.push(ep.label.to_string());
                }
                Err(e) => failed.push(format!("{} {}", ep.label, e)),
            },
            Err(e) => failed.push(format!("{} {}", ep.label, e)),
        }
    }

    let _ = app.emit(
        "data-sync-progress",
        SyncProgress {
            running: false,
            done: total,
            total,
            label: String::new(),
            force,
        },
    );

    let ok = failed.is_empty();
    let message = if ok {
        if updated.is_empty() {
            format!("数据已是最新（跳过 {skipped} 项）")
        } else {
            format!("已更新 {} 项数据", updated.len())
        }
    } else {
        format!("{} 项更新失败：{}", failed.len(), failed.join("；"))
    };
    let report = SyncReport {
        ok,
        updated,
        failed,
        skipped,
        updated_at: manifest.updated_at,
        message,
    };
    let _ = app.emit("data-synced", report.clone());
    Ok(report)
}
