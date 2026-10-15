//! 图片资源（物品图标 / 商人头像 / 地图底图 / 地图标记 / Boss 图 / 瓦片）的本地缓存与在线更新。
//!
//! **与游戏数据（`apidata`）相互独立**：两者是设置页里两个独立的按钮、两条独立的命令
//! （`refresh_assets` / `refresh_game_data`），各写各的目录、各记各的清单，一次更新只碰一项。
//! 唯一共用的是进度事件（`data-sync-progress` 的 `kind` 区分）与启动遮罩的步骤时间线。
//!
//! 与 `apidata` 是一套思路、两个来源，统一由远端清单驱动：
//!
//! **清单**（`{ASSETS_BASE}/assets-manifest.json`）逐条列出每个文件：
//!
//! ```json
//! { "version": 2, "files": [
//!   { "path": "maps/svg/Customs.svg", "name": "maps__svg__Customs.svg",
//!     "bytes": 12345, "etag": "<内容摘要>" },
//!   { "path": "item-icons/<物品id>.webp",
//!     "url": "https://assets.tarkov.dev/<物品id>-icon.webp", "etag": "<上游 ETag>" }
//! ] }
//! ```
//!
//! - `path`：本地落盘路径，与前端 `public/` 下的相对路径**完全一致**，
//!   前端据此把同一段相对路径拼成 `asset:` 协议 URL（见 `src-react/assetUrl.ts`）。
//! - `url`：完整下载地址（上游 CDN 用）；没有 `url` 时用 `{ASSETS_BASE}/{name}`（自有附件）。
//! - `etag`：版本标记。本地记录（`_local` 清单）里存着「上次同步到的版本」，
//!   与清单一致且字节数相同就**整条跳过**——于是「更新图片资源」只下载真正变化的文件。
//!   本地记录里的值一律取自清单声明（不是响应头），因此两边永远同源可比。
//!
//! 清单不可达时（尚未托管 / 断网）**退化为「图标缺失即下」**：至少保证新增物品、
//! 首次安装（无内置资源版）能拿到图，不会因为清单挂了就完全不能更新。
//! 上游确实没有的图（404）会在本地清单记一条 `etag: "missing"` 的占位，下次不再重探；
//! 上游后来补齐了，会由清单里的真实 etag 覆盖该占位（`force` 时也会忽略占位重探）。
//!
//! 随包已带的图：本地记录里已经有可比对的版本（上次同步时记下的清单值）就跳过；
//! 记录为空（首次同步、或刚换过资源目录）时还没有可比对的版本，会按清单值取一次，
//! 之后就一直命中跳过（无内置资源版 `IC_NO_ASSETS=1` 则本来就是全量下载）。
//!
//! 清单基址可用环境变量 `IC_ASSETS_BASE` 覆盖（自建服务时无需改代码）；
//! 清单的生成与上传见 `scripts/pack-assets.mjs`。

use std::collections::HashSet;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::apidata::{FileInfo, Manifest};

/// 资源缓存目录名（位于数据根目录下）
const DIR_NAME: &str = "tarkov-assets";
/// 本地清单文件名（记录每个文件同步到的版本 / 字节数 / 时间）
const MANIFEST_FILE: &str = "assets-manifest.json";
/// 上游 CDN：物品图标与商人头像（清单里没列出时按 id 直连兜底）
const CDN_BASE: &str = "https://assets.tarkov.dev";
/// 自有资源（地图底图 / 地图标记 / Boss 图 / 瓦片）的默认基址。
/// 与 GitHub Release 的 assets 标签对应；自建服务可用 `IC_ASSETS_BASE` 覆盖。
const ASSETS_BASE_DEFAULT: &str =
    "https://github.com/IceCatcc/IC-Tarkov/releases/download/assets/";
/// 并发下载线程数（图标数千张，串行会明显拖慢首次下载）
const CONCURRENCY: usize = 8;
/// 单个文件体积上限，防异常响应打爆磁盘
const MAX_FILE_BYTES: u64 = 256 * 1024 * 1024;
/// 本地清单里用来记「上游确认没有这张图」（404）的占位版本号：
/// 下次同步不再重复探测；上游真补齐了图，会被清单里的真实 etag 覆盖。
const MISSING_ETAG: &str = "missing";

static SYNCING: AtomicBool = AtomicBool::new(false);

/// build.rs 生成的「随包图片清单」：完整版列出安装包里已带的图片，
/// 无内置资源版（IC_NO_ASSETS=1）为空。
mod bundled {
    include!(concat!(env!("OUT_DIR"), "/bundled_assets.rs"));
}

// ---------------- 路径与清单 ----------------

/// 资源目录：<data_root>/tarkov-assets
pub fn dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let d = crate::data_root(app)?.join(DIR_NAME);
    std::fs::create_dir_all(&d).map_err(|e| format!("创建图片资源目录失败：{e}"))?;
    Ok(d)
}

fn now_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn read_manifest(dir: &Path) -> Manifest {
    std::fs::read_to_string(dir.join(MANIFEST_FILE))
        .ok()
        .and_then(|s| serde_json::from_str::<Manifest>(&s).ok())
        .unwrap_or_default()
}

fn write_manifest(dir: &Path, m: &Manifest) {
    if let Ok(json) = serde_json::to_string_pretty(m) {
        let _ = std::fs::write(dir.join(MANIFEST_FILE), json);
    }
}

/// 递归收集目录下的文件相对路径（'/' 分隔），清单文件与临时文件不对外暴露
fn collect(root: &Path, cur: &Path, out: &mut Vec<String>) {
    let rd = match std::fs::read_dir(cur) {
        Ok(rd) => rd,
        Err(_) => return,
    };
    for e in rd.flatten() {
        let p = e.path();
        if p.is_dir() {
            collect(root, &p, out);
        } else if let Ok(rel) = p.strip_prefix(root) {
            let rel = rel.to_string_lossy().replace('\\', "/");
            if rel != MANIFEST_FILE && !rel.ends_with(".tmp") {
                out.push(rel);
            }
        }
    }
}

/// 已下载的资源相对路径列表（前端据此决定用运行时资源还是随包资源）
pub fn index(app: &tauri::AppHandle) -> Vec<String> {
    let root = match dir(app) {
        Ok(d) => d,
        Err(_) => return Vec::new(),
    };
    let mut out = Vec::new();
    collect(&root, &root, &mut out);
    out.sort();
    out
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetsStatus {
    /// 资源目录绝对路径（前端用它把相对路径拼成 asset: 协议 URL）
    pub dir: String,
    pub files: usize,
    pub bytes: u64,
    /// 最近一次资源真正发生变化的时间（epoch 秒，0 = 从未更新过）
    pub updated_at: i64,
    /// 是否正在更新图片资源（设置页据此禁用按钮 / 显示「更新中」）
    pub syncing: bool,
}

/// 是否有一次图片资源更新正在跑：命令入口据此即时回「正在进行中」，不必等事件
pub fn syncing() -> bool {
    SYNCING.load(Ordering::SeqCst)
}

/// 是否「一张图都没有」：无内置资源版（`IC_NO_ASSETS=1`）首次启动、或换了数据目录。
/// 此时界面到处都是破图，启动时后台自动补一次；有随包图片时不自动同步，
/// 图片更新完全交给设置页的「更新图片资源」按钮。
pub fn needs_seed_download(app: &tauri::AppHandle) -> bool {
    bundled::BUNDLED.is_empty() && index(app).is_empty()
}

pub fn status(app: &tauri::AppHandle) -> AssetsStatus {
    let root = dir(app).ok();
    let mut files = 0usize;
    let mut bytes = 0u64;
    let mut updated_at = 0i64;
    if let Some(root) = &root {
        updated_at = read_manifest(root).updated_at;
        let mut list = Vec::new();
        collect(root, root, &mut list);
        files = list.len();
        for rel in &list {
            if let Ok(meta) = std::fs::metadata(root.join(rel)) {
                bytes += meta.len();
            }
        }
    }
    AssetsStatus {
        dir: root.map(|d| d.to_string_lossy().into_owned()).unwrap_or_default(),
        files,
        bytes,
        updated_at,
        syncing: syncing(),
    }
}

// ---------------- 同步 ----------------

#[derive(Default)]
pub struct AssetReport {
    pub updated: Vec<String>,
    pub failed: Vec<String>,
    /// 与清单比对后判定「已是同一版本」而跳过的文件数
    pub unchanged: usize,
    /// 上游没有该文件（404，如某物品本就没有图标）
    pub missing: usize,
    pub bytes: u64,
    pub total: usize,
}

/// 远端清单，逐条列出每个可更新文件
#[derive(Deserialize, Default)]
struct RemoteManifest {
    #[serde(default)]
    #[allow(dead_code)]
    version: u32,
    #[serde(default)]
    files: Vec<RemoteFile>,
}

#[derive(Deserialize, Default)]
struct RemoteFile {
    /// 本地落盘相对路径（与前端 public 下一致）
    #[serde(default)]
    path: String,
    /// 远端附件名（相对清单同目录）；与 url 二选一
    #[serde(default)]
    name: String,
    /// 完整下载地址（上游 CDN 用）；优先于 name
    #[serde(default)]
    url: String,
    /// 文件字节数（0 = 未知，不做比对）
    #[serde(default)]
    bytes: u64,
    /// 版本标记（内容摘要或上游 ETag）
    #[serde(default)]
    etag: String,
}

/// 一个待下载任务
struct Task {
    /// 落盘相对路径
    rel: String,
    /// 下载地址
    url: String,
    /// 清单声明的版本标记（写进本地记录，供下次比对；空 = 走响应头 ETag）
    ver: String,
}

fn assets_base() -> String {
    let raw = std::env::var("IC_ASSETS_BASE").unwrap_or_else(|_| ASSETS_BASE_DEFAULT.to_string());
    if raw.ends_with('/') {
        raw
    } else {
        format!("{raw}/")
    }
}

/// 相对路径合法性：拒绝绝对路径与目录穿越（路径来自远端，不能直接拼进本地路径）
fn safe_rel(rel: &str) -> bool {
    !rel.is_empty()
        && !rel.starts_with('/')
        && !rel.starts_with('\\')
        && !rel.contains("..")
        && !rel.contains(':')
}

/// 从「中文本地化」文件里取 id：其结构是 `{ "data": { "<id> Name": "中文名", ... } }`，
/// 因此按后缀剥出 id 即可，不必依赖已构建好的数据集（首次启动时数据集还是空的）。
fn zh_ids(cache_dir: &Path, file: &str, suffix: &str) -> Vec<String> {
    let text = match std::fs::read_to_string(cache_dir.join(file)) {
        Ok(t) => t,
        Err(_) => return Vec::new(),
    };
    let v: serde_json::Value = match serde_json::from_str(&text) {
        Ok(v) => v,
        Err(_) => return Vec::new(),
    };
    let data = match v.get("data").and_then(|d| d.as_object()) {
        Some(d) => d,
        None => return Vec::new(),
    };
    let mut ids: Vec<String> = data
        .keys()
        .filter_map(|k| k.strip_suffix(suffix).map(|s| s.to_string()))
        .collect();
    ids.sort();
    ids.dedup();
    ids
}

/// 二进制下载结果（与 apidata 的 Fetched 同理，但内容不校验 JSON）
enum FetchedBin {
    Unchanged,
    Fresh(Vec<u8>, String),
}

fn fetch_binary(agent: &ureq::Agent, url: &str, etag: Option<&str>) -> Result<FetchedBin, String> {
    let mut req = agent
        .get(url)
        .set("User-Agent", "ic-tarkov/1.0")
        // 图片不需要压缩：落盘即原始字节
        .set("Accept-Encoding", "identity");
    if let Some(tag) = etag {
        req = req.set("If-None-Match", tag);
    }
    match req.call() {
        Ok(resp) => {
            let code = resp.status();
            if code == 304 {
                return Ok(FetchedBin::Unchanged);
            }
            if code != 200 {
                return Err(format!("HTTP {code}"));
            }
            let new_etag = resp.header("ETag").unwrap_or_default().to_string();
            let mut buf = Vec::new();
            resp.into_reader()
                .take(MAX_FILE_BYTES)
                .read_to_end(&mut buf)
                .map_err(|e| format!("读取响应失败：{e}"))?;
            if buf.is_empty() {
                return Err("响应为空".to_string());
            }
            Ok(FetchedBin::Fresh(buf, new_etag))
        }
        // ureq 把 4xx/5xx 作为 Err(Status) 抛出（304 不算错误，见上）
        Err(ureq::Error::Status(code, _)) => Err(format!("HTTP {code}")),
        Err(e) => Err(format!("{e}")),
    }
}

/// 一批任务并发下载（保持与输入同序）；agent 是 Sync 的，可跨线程共享引用
fn download_batch(agent: &ureq::Agent, items: &[Task]) -> Vec<Result<FetchedBin, String>> {
    std::thread::scope(|s| {
        let handles: Vec<_> = items
            .iter()
            .map(|t| s.spawn(move || fetch_binary(agent, &t.url, None)))
            .collect();
        handles
            .into_iter()
            .map(|h| h.join().unwrap_or_else(|_| Err("下载线程异常退出".to_string())))
            .collect()
    })
}

/// 与 `apidata::sync_with` 同构：带进度回调的资源同步（阻塞）。
/// 进度回调 `(已完成数, 总数, 阶段文案)`，由调用方转成 `data-sync-progress` 事件。
/// 调用方：设置页「更新图片资源」按钮（`lib.rs::refresh_assets`）与启动兜底
/// （`needs_seed_download` 为真时，即一张图都没有的无内置资源版首次启动）。
pub fn sync_with<F>(
    app: &tauri::AppHandle,
    force: bool,
    progress: &mut F,
) -> Result<AssetReport, String>
where
    F: FnMut(usize, usize, &str),
{
    if SYNCING
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return Err("图片资源更新正在进行中".to_string());
    }
    let result = do_sync(app, force, progress);
    SYNCING.store(false, Ordering::SeqCst);
    result
}

fn do_sync<F>(app: &tauri::AppHandle, force: bool, progress: &mut F) -> Result<AssetReport, String>
where
    F: FnMut(usize, usize, &str),
{
    let root = dir(app)?;
    let cache = crate::apidata::cache_dir(app)?;
    let agent = crate::apidata::build_agent()?;
    let mut manifest = read_manifest(&root);
    let mut report = AssetReport::default();
    let base = assets_base();

    // ---- 1. 按远端清单挑出「与本地记录不同」的文件 ----
    // 这一步就是增量的核心：摘要一致 + 字节数一致的条目整条跳过，连请求都不发。
    let mut listed: HashSet<String> = HashSet::new();
    let mut tasks: Vec<Task> = Vec::new();
    match fetch_binary(&agent, &format!("{base}{MANIFEST_FILE}"), None) {
        Ok(FetchedBin::Fresh(bytes, _)) => match serde_json::from_slice::<RemoteManifest>(&bytes) {
            Ok(remote) => {
                for f in remote.files {
                    if !safe_rel(&f.path) {
                        report.failed.push(format!("清单里的路径非法：{}", f.path));
                        continue;
                    }
                    let url = if !f.url.is_empty() {
                        f.url.clone()
                    } else {
                        let name = if f.name.is_empty() { &f.path } else { &f.name };
                        if !safe_rel(name) {
                            report.failed.push(format!("清单里的附件名非法：{name}"));
                            continue;
                        }
                        format!("{base}{name}")
                    };
                    listed.insert(f.path.clone());
                    let same = match manifest.files.get(&f.path) {
                        Some(local) => {
                            !f.etag.is_empty()
                                && local.etag == f.etag
                                && (f.bytes == 0 || local.bytes == f.bytes)
                        }
                        None => false,
                    };
                    if !force && same {
                        report.unchanged += 1;
                        continue;
                    }
                    tasks.push(Task {
                        rel: f.path,
                        url,
                        ver: f.etag,
                    });
                }
            }
            Err(e) => report.failed.push(format!("资源清单解析失败：{e}")),
        },
        Ok(FetchedBin::Unchanged) => {}
        Err(e) => println!("[assets] 资源清单不可用（{e}），退化为「图标缺失即下」"),
    }

    // ---- 2. 兜底：清单没列出的图标（新物品 / 清单缺失）按「缺失即下」补 ----
    let mut cdn: Vec<(String, String)> = Vec::new();
    for id in zh_ids(&cache, "regular_items_zh.json", " Name") {
        cdn.push((
            format!("item-icons/{id}.webp"),
            format!("{CDN_BASE}/{id}-icon.webp"),
        ));
    }
    for id in zh_ids(&cache, "regular_traders_zh.json", " Description") {
        cdn.push((format!("trader-icons/{id}.webp"), format!("{CDN_BASE}/{id}.webp")));
    }
    for (rel, url) in cdn {
        if listed.contains(&rel) {
            continue;
        }
        if !force && (bundled::has(&rel) || root.join(&rel).is_file()) {
            report.unchanged += 1;
            continue;
        }
        // 上次已确认「上游没有这张图」：不再重复探测（只有强制更新才重探）
        if !force && manifest.files.get(&rel).is_some_and(|f| f.etag == MISSING_ETAG) {
            report.missing += 1;
            continue;
        }
        tasks.push(Task {
            rel,
            url,
            ver: String::new(),
        });
    }

    let total = tasks.len();
    report.total = total;
    if total == 0 {
        return Ok(report);
    }

    // ---- 3. 并发下载差异文件（批间更新进度）----
    let mut done = 0usize;
    for chunk in tasks.chunks(CONCURRENCY) {
        let results = download_batch(&agent, chunk);
        let mut changed = false;
        // 清单本身有改动（如记下新的「上游暂无」）也要落盘，但不算资源发生变化
        let mut dirty = false;
        for (task, res) in chunk.iter().zip(results) {
            match res {
                Ok(FetchedBin::Unchanged) => report.unchanged += 1,
                Ok(FetchedBin::Fresh(bytes, resp_etag)) => {
                    let path = root.join(&task.rel);
                    if let Some(p) = path.parent() {
                        let _ = std::fs::create_dir_all(p);
                    }
                    match crate::apidata::write_atomic(&path, &bytes) {
                        Ok(()) => {
                            manifest.files.insert(
                                task.rel.clone(),
                                FileInfo {
                                    bytes: bytes.len() as u64,
                                    updated_at: now_secs(),
                                    // 一律记清单声明的版本：下次比对才会与清单同源
                                    etag: if task.ver.is_empty() {
                                        resp_etag
                                    } else {
                                        task.ver.clone()
                                    },
                                },
                            );
                            report.bytes += bytes.len() as u64;
                            report.updated.push(task.rel.clone());
                            changed = true;
                        }
                        Err(e) => report.failed.push(format!("{} {e}", task.rel)),
                    }
                }
                // 上游没有这张图（如某物品本就没有图标）不算失败：
                // 记进本地清单，下次不必再探（上游真补了图会被清单里的真实 etag 覆盖）
                Err(e) if e.contains("404") => {
                    report.missing += 1;
                    manifest.files.insert(
                        task.rel.clone(),
                        FileInfo {
                            bytes: 0,
                            updated_at: now_secs(),
                            etag: MISSING_ETAG.to_string(),
                        },
                    );
                    dirty = true;
                }
                Err(e) => report.failed.push(format!("{} {e}", task.rel)),
            }
        }
        if changed {
            manifest.updated_at = now_secs();
        }
        if changed || dirty {
            write_manifest(&root, &manifest);
        }
        done += chunk.len();
        progress(done, total, "图片资源");
    }

    Ok(report)
}

/// 资源更新摘要文案（`assets-synced` 事件的 message）
pub fn summary_text(report: &AssetReport) -> String {
    let mut parts: Vec<String> = Vec::new();
    if report.updated.is_empty() {
        parts.push(format!("图片资源已是最新：{} 张内容未变化", report.unchanged));
    } else {
        let mb = report.bytes as f64 / 1048576.0;
        parts.push(format!(
            "已更新 {} 张图片资源（{mb:.1} MB）",
            report.updated.len()
        ));
        if report.unchanged > 0 {
            parts.push(format!("{} 张已是同一版本", report.unchanged));
        }
    }
    if report.missing > 0 {
        parts.push(format!("{} 张上游暂无", report.missing));
    }
    if !report.failed.is_empty() {
        parts.push(format!("{} 张失败", report.failed.len()));
    }
    parts.join("，")
}
