//! 图片资源（物品图标 / 商人头像 / 地图底图 / 地图标记 / Boss 图 / 瓦片）的本地缓存与在线更新。
//!
//! 与 `apidata`（游戏 JSON 数据）是一套思路、两个来源：
//!
//! **1. 上游 CDN 按 id 直连**（`assets.tarkov.dev`）
//!   物品图标 `{物品id}-icon.webp`、商人头像 `{商人id}.webp`。数量最多（数千张），
//!   但都能按 id 取到，因此不做清单：非强制更新时**只补本地缺失的**，
//!   避免每次更新都对上游发几千个条件请求。并发 8 路下载。
//!
//! **2. 自有资源包**（`{ASSETS_BASE}/assets-manifest.json` + `assets.zip`）
//!   地图底图 SVG、地图标记图标、Boss 图、可选的地图瓦片 —— 这些上游没有，
//!   由项目自己托管。清单里给出资源包文件名与内容摘要（`hash`）：
//!   摘要与本地记录一致就跳过整个资源包，否则下载后解包覆盖到资源目录。
//!   基址不可达（尚未托管 / 断网）时**静默跳过**，界面继续用随包资源。
//!
//! 目录约定：`<data_root>/tarkov-assets/`，布局与前端 `public/` 下的相对路径**完全一致**，
//! 前端据此把同一段相对路径拼成 `asset:` 协议 URL（详见 `src-react/assetUrl.ts`）：
//!
//! ```text
//! item-icons/<物品id>.webp
//! trader-icons/<商人id>.webp
//! boss-icons/<名称>.<png|webp>
//! maps/svg/<地图名>.svg
//! maps/interactive/<名称>.png
//! maps/tiles/<地图名>/<z>/<x>/<y>.png
//! ```
//!
//! 「已随包分发」的图片不会白下载一遍：图标类看 build.rs 生成的 `bundled_assets` 清单
//! （无内置资源版 `IC_NO_ASSETS=1` 时该清单为空 → 全部下载）。
//!
//! 清单基址可用环境变量 `IC_ASSETS_BASE` 覆盖（自建服务时无需改代码）；
//! 资源包的生成与上传见 `scripts/pack-assets.mjs`。

use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::apidata::{FileInfo, Manifest};

/// 资源缓存目录名（位于数据根目录下）
const DIR_NAME: &str = "tarkov-assets";
/// 本地清单文件名（记录每个文件的字节数 / 更新时间 / ETag）
const MANIFEST_FILE: &str = "assets-manifest.json";
/// 上游 CDN：物品图标与商人头像
const CDN_BASE: &str = "https://assets.tarkov.dev";
/// 自有资源（地图底图 / 地图标记 / Boss 图 / 瓦片）的默认基址。
/// 与 GitHub Release 的 assets 标签对应；自建服务可用 `IC_ASSETS_BASE` 覆盖。
const ASSETS_BASE_DEFAULT: &str =
    "https://github.com/IceCatcc/IC-Tarkov/releases/download/assets/";
/// 本地清单里记录「已解包的资源包摘要」用的键（不是真实文件，不会与图片重名）
const ARCHIVE_KEY: &str = "_archive";
/// 并发下载线程数（图标数千张，串行会明显拖慢首次下载）
const CONCURRENCY: usize = 8;
/// 单个文件体积上限，防异常响应打爆磁盘
const MAX_FILE_BYTES: u64 = 256 * 1024 * 1024;

static SYNCING: AtomicBool = AtomicBool::new(false);

/// build.rs 生成的「随包图片清单」：完整版列出安装包里已带的图片，
/// 无内置资源版（IC_NO_ASSETS=1）为空 → 全部由首次启动下载。
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
    }
}

// ---------------- 同步 ----------------

#[derive(Default)]
pub struct AssetReport {
    pub updated: Vec<String>,
    pub failed: Vec<String>,
    /// 内容未变化（服务端 304 或摘要一致）而跳过的文件 / 资源包数
    pub unchanged: usize,
    /// 上游没有该文件（404，如某物品本就没有图标）
    pub missing: usize,
    pub bytes: u64,
    pub total: usize,
}

/// 自有资源清单（托管在 ASSETS_BASE 下的 assets-manifest.json）。
/// 结构：`{ "version": 1, "zip": "assets.zip", "hash": "<资源包内容摘要>" }`
#[derive(Deserialize, Default)]
struct RemoteManifest {
    #[serde(default)]
    #[allow(dead_code)]
    version: u32,
    /// 资源包文件名（相对清单同目录）；留空按 assets.zip
    #[serde(default)]
    zip: String,
    /// 资源包内容摘要：与本地记录一致时跳过整个资源包的下载
    #[serde(default)]
    hash: String,
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
        // 图片不需要压缩：落盘即原始字节，ETag 也对应原始内容
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
fn download_batch(
    agent: &ureq::Agent,
    items: &[(String, String, Option<String>)],
) -> Vec<Result<FetchedBin, String>> {
    std::thread::scope(|s| {
        let handles: Vec<_> = items
            .iter()
            .map(|(_, url, etag)| s.spawn(move || fetch_binary(agent, url, etag.as_deref())))
            .collect();
        handles
            .into_iter()
            .map(|h| h.join().unwrap_or_else(|_| Err("下载线程异常退出".to_string())))
            .collect()
    })
}

type Archive = zip::ZipArchive<std::io::Cursor<Vec<u8>>>;

/// 与 `apidata::sync_with` 同构：带进度回调的资源同步。
/// 进度回调 `(已完成数, 总数, 当前阶段文案)`，由调用方转成 `data-sync-progress` 事件。
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

    // ---- 1. 待下载的图标（上游 CDN，按 id 直连）----
    // 非强制更新时跳过「随包已有」与「本地已有」的，因此完整版通常只需补新增物品的图。
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
    let mut icons: Vec<(String, String, Option<String>)> = Vec::new();
    for (rel, url) in cdn {
        if !force && (bundled::has(&rel) || root.join(&rel).is_file()) {
            continue;
        }
        icons.push((rel, url, None));
    }

    // ---- 2. 自有资源包（地图底图 / 地图标记 / Boss 图 / 瓦片）----
    let base = assets_base();
    let mut archive: Option<(Archive, String)> = None;
    match fetch_binary(&agent, &format!("{base}{MANIFEST_FILE}"), None) {
        Ok(FetchedBin::Fresh(bytes, _)) => match serde_json::from_slice::<RemoteManifest>(&bytes) {
            Ok(remote) => {
                let zip_name = if remote.zip.is_empty() {
                    "assets.zip".to_string()
                } else {
                    remote.zip
                };
                let local = manifest
                    .files
                    .get(ARCHIVE_KEY)
                    .map(|f| f.etag.clone())
                    .unwrap_or_default();
                // 摘要一致说明资源包没变：整包都不用下
                if !force && !remote.hash.is_empty() && remote.hash == local {
                    report.unchanged += 1;
                } else {
                    match fetch_binary(&agent, &format!("{base}{zip_name}"), None) {
                        Ok(FetchedBin::Fresh(zb, _)) => {
                            match zip::ZipArchive::new(std::io::Cursor::new(zb)) {
                                Ok(ar) => archive = Some((ar, remote.hash)),
                                Err(e) => report.failed.push(format!("资源包 {zip_name} 解析失败：{e}")),
                            }
                        }
                        Ok(FetchedBin::Unchanged) => report.unchanged += 1,
                        Err(e) => report.failed.push(format!("资源包 {zip_name} {e}")),
                    }
                }
            }
            Err(e) => report.failed.push(format!("资源清单解析失败：{e}")),
        },
        Ok(FetchedBin::Unchanged) => {}
        Err(e) => {
            // 基址不可达 / 尚未托管清单：静默跳过自有资源，界面继续用随包资源
            println!("[assets] 自有资源清单不可用（{e}），本次跳过");
        }
    }

    let entries = archive.as_ref().map(|(a, _)| a.len()).unwrap_or(0);
    let total = icons.len() + entries;
    report.total = total;
    if total == 0 {
        return Ok(report);
    }

    // ---- 3. 并发下载图标（批间更新进度）----
    let mut done = 0usize;
    for chunk in icons.chunks(CONCURRENCY) {
        let results = download_batch(&agent, chunk);
        let mut changed = false;
        for ((rel, _, _), res) in chunk.iter().zip(results) {
            match res {
                Ok(FetchedBin::Unchanged) => report.unchanged += 1,
                Ok(FetchedBin::Fresh(bytes, etag)) => {
                    let path = root.join(rel);
                    if let Some(p) = path.parent() {
                        let _ = std::fs::create_dir_all(p);
                    }
                    match crate::apidata::write_atomic(&path, &bytes) {
                        Ok(()) => {
                            manifest.files.insert(
                                rel.clone(),
                                FileInfo {
                                    bytes: bytes.len() as u64,
                                    updated_at: now_secs(),
                                    etag,
                                },
                            );
                            report.bytes += bytes.len() as u64;
                            report.updated.push(rel.clone());
                            changed = true;
                        }
                        Err(e) => report.failed.push(format!("{rel} {e}")),
                    }
                }
                // 上游没有这张图（如某物品本就没有图标）不算失败
                Err(e) if e.contains("404") => report.missing += 1,
                Err(e) => report.failed.push(format!("{rel} {e}")),
            }
        }
        if changed {
            manifest.updated_at = now_secs();
            write_manifest(&root, &manifest);
        }
        done += chunk.len();
        progress(done, total, "物品与商人图标");
    }

    // ---- 4. 解包资源包（逐条目覆盖写入）----
    if let Some((mut ar, hash)) = archive {
        let mut changed = false;
        let mut pkg_bytes = 0u64;
        for i in 0..ar.len() {
            let entry = {
                match ar.by_index(i) {
                    Ok(mut f) => {
                        if f.is_dir() {
                            None
                        } else {
                            let name = f.name().to_string();
                            let mut buf = Vec::new();
                            match f.read_to_end(&mut buf) {
                                Ok(_) => Some((name, buf)),
                                Err(e) => {
                                    report.failed.push(format!("资源包条目 {i} 读取失败：{e}"));
                                    None
                                }
                            }
                        }
                    }
                    Err(e) => {
                        report.failed.push(format!("资源包条目 {i} 打开失败：{e}"));
                        None
                    }
                }
            };
            done += 1;
            if let Some((name, data)) = entry {
                // 清单文件与非法路径不落盘
                if name != MANIFEST_FILE && safe_rel(&name) {
                    let path = root.join(&name);
                    if let Some(p) = path.parent() {
                        let _ = std::fs::create_dir_all(p);
                    }
                    match crate::apidata::write_atomic(&path, &data) {
                        Ok(()) => {
                            pkg_bytes += data.len() as u64;
                            report.updated.push(name);
                            changed = true;
                        }
                        Err(e) => report.failed.push(format!("{name} {e}")),
                    }
                }
            }
            progress(done, total, "地图与角色图片");
        }
        if changed {
            report.bytes += pkg_bytes;
            manifest.files.insert(
                ARCHIVE_KEY.to_string(),
                FileInfo {
                    bytes: pkg_bytes,
                    updated_at: now_secs(),
                    etag: hash,
                },
            );
            manifest.updated_at = now_secs();
            write_manifest(&root, &manifest);
        }
    }

    Ok(report)
}

/// 资源更新摘要文案（并入 apidata 的 SyncReport.message）
pub fn summary_text(report: &AssetReport) -> String {
    let mut parts = vec![format!("图片资源更新 {} 项", report.updated.len())];
    if report.unchanged > 0 {
        parts.push(format!("{} 项未变化", report.unchanged));
    }
    if report.missing > 0 {
        parts.push(format!("{} 张上游暂无", report.missing));
    }
    if !report.failed.is_empty() {
        parts.push(format!("{} 项失败", report.failed.len()));
    }
    parts.join("，")
}
