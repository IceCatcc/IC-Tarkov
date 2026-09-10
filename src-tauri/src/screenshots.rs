//! 截图目录监听：解析截图文件名中的玩家位置与朝向。
//!
//! 文件名格式（游戏内置 F12 截图 / 投射工具生成）：
//! `2026-08-26[21-36]_85.24, 15.52, 3.62_-0.00018, -0.99981, 0.01149, -0.01550_14.25 (0).png`
//!   └ 日期[时间]  └ x, y, z        └ 四元数 qx, qy, qz, qw                    └ zoom (序号)

use once_cell::sync::Lazy;
use regex::Regex;
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, OnceLock};
use tauri::{AppHandle, Emitter};

/// 应用启动时刻：只认启动之后生成的截图，旧截图不再定位
static APP_START: OnceLock<std::time::SystemTime> = OnceLock::new();

pub fn started_at() -> std::time::SystemTime {
    *APP_START.get_or_init(std::time::SystemTime::now)
}

static RE_SHOT: Lazy<Regex> = Lazy::new(|| {
    Regex::new(
        r#"^\d{4}-\d{2}-\d{2}\[\d{2}-\d{2}\]_\s*(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)_\s*(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)"#,
    )
    .unwrap()
});

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShotPosition {
    pub position: ShotPos,
    /// 面朝方向（度，0 = 游戏 +Z 北向，顺时针增加）
    pub rotation: f64,
    pub timestamp: String,
    pub file: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShotPos {
    pub x: f64,
    pub y: f64,
    pub z: f64,
}

pub fn parse_filename(name: &str) -> Option<ShotPosition> {
    let c = RE_SHOT.captures(name)?;
    let num = |i: usize| -> Option<f64> { Some(c.get(i)?.as_str().parse().ok()?) };
    // 提取文件名中的日期时间作为捕获时间戳
    let ts = name
        .split('_')
        .next()
        .unwrap_or("")
        .replace('[', " ")
        .replace(']', "");
    Some(ShotPosition {
        position: ShotPos {
            x: num(1)?,
            y: num(2)?,
            z: num(3)?,
        },
        rotation: rotation_deg(num(4)?, num(5)?, num(6)?, num(7)?),
        timestamp: ts,
        file: name.to_string(),
    })
}

/// Unity 四元数 -> 绕 Y 轴偏航角（度）。forward = q * (0,0,1)
fn rotation_deg(qx: f64, qy: f64, qz: f64, qw: f64) -> f64 {
    let fx = 2.0 * (qx * qz + qw * qy);
    let fz = 1.0 - 2.0 * (qx * qx + qy * qy);
    fx.atan2(fz).to_degrees()
}

pub fn scan_latest(dir: &Path) -> Option<(PathBuf, std::time::SystemTime)> {
    let mut best: Option<(PathBuf, std::time::SystemTime)> = None;
    let consider = |p: &Path, best: &mut Option<(PathBuf, std::time::SystemTime)>| {
        let ext = p
            .extension()
            .and_then(|x| x.to_str())
            .map(|s| s.to_ascii_lowercase());
        if !matches!(ext.as_deref(), Some("png") | Some("jpg") | Some("jpeg")) {
            return;
        }
        let Some(name) = p.file_name().and_then(|s| s.to_str()) else {
            return;
        };
        if parse_filename(name).is_none() {
            return;
        }
        if let Ok(meta) = std::fs::metadata(p) {
            if let Ok(mtime) = meta.modified() {
                let replace = match &best {
                    Some((_, t)) => mtime > *t,
                    None => true,
                };
                if replace {
                    *best = Some((p.to_path_buf(), mtime));
                }
            }
        }
    };
    let entries = std::fs::read_dir(dir).ok()?;
    for e in entries.flatten() {
        let p = e.path();
        if p.is_dir() {
            // 兼容按日期分文件夹的布局，递归一层
            if let Ok(sub) = std::fs::read_dir(&p) {
                for se in sub.flatten() {
                    consider(&se.path(), &mut best);
                }
            }
        } else {
            consider(&p, &mut best);
        }
    }
    best
}

/// 列出目录（含一层子目录）中「启动之后产生的」截图（png/jpg/jpeg）。
fn recent_shots(dir: &Path) -> Vec<PathBuf> {
    fn is_shot(p: &Path) -> bool {
        matches!(
            p.extension()
                .and_then(|x| x.to_str())
                .map(|s| s.to_ascii_lowercase())
                .as_deref(),
            Some("png") | Some("jpg") | Some("jpeg")
        )
    }
    fn fresh(p: &Path) -> bool {
        std::fs::metadata(p)
            .and_then(|m| m.modified())
            .map(|t| t > started_at())
            .unwrap_or(false)
    }
    let mut out = Vec::new();
    let Ok(entries) = std::fs::read_dir(dir) else {
        return out;
    };
    for e in entries.flatten() {
        let p = e.path();
        if p.is_dir() {
            // 兼容按日期分文件夹的布局，递归一层
            if let Ok(sub) = std::fs::read_dir(&p) {
                for se in sub.flatten() {
                    let sp = se.path();
                    if !sp.is_dir() && is_shot(&sp) && fresh(&sp) {
                        out.push(sp);
                    }
                }
            }
        } else if is_shot(&p) && fresh(&p) {
            out.push(p);
        }
    }
    out
}

/// 删除启动之后产生、但文件名不含坐标的截图。
/// 用于「读取坐标后删除截图」开启时，避免无坐标的新截图在目录里堆积。
pub fn purge_unparsable(dir: &Path) {
    for p in recent_shots(dir) {
        let has_coords = p
            .file_name()
            .and_then(|s| s.to_str())
            .map(|n| parse_filename(n).is_some())
            .unwrap_or(false);
        if !has_coords {
            let _ = std::fs::remove_file(&p);
        }
    }
}

pub struct ScreenshotHandle {
    stop: Arc<AtomicBool>,
}

impl ScreenshotHandle {
    pub fn stop(&self) {
        self.stop.store(true, Ordering::Relaxed);
    }
}

/// 每 0.5s 扫描一次截图目录；文件变化时解析并 emit `player-position`。
/// `delete_after` 为 true 时读取坐标后删除该截图（避免重复消费），false 时保留。
/// 同一开关下，启动之后产生但不含坐标的截图也会被清理，避免无用截图堆积。
pub fn start(app: &AppHandle, dir: &str, delete_after: bool) -> ScreenshotHandle {
    let _ = started_at(); // 记录启动时刻
    let stop = Arc::new(AtomicBool::new(false));
    let stop_c = stop.clone();
    let app_c = app.clone();
    let dir_s = dir.to_string();
    std::thread::spawn(move || {
        let dir = PathBuf::from(&dir_s);
        let mut last_key = String::new();
        loop {
            if stop_c.load(Ordering::Relaxed) {
                break;
            }
            if !dir.is_dir() {
                std::thread::sleep(std::time::Duration::from_millis(500));
                continue;
            }
            if let Some((path, mtime)) = scan_latest(&dir) {
                // 启动之前就存在的截图不用于定位
                if mtime > started_at() {
                    let key = format!(
                        "{}|{}",
                        path.display(),
                        path.metadata()
                            .ok()
                            .and_then(|m| m.modified().ok())
                            .map(|t| format!("{t:?}"))
                            .unwrap_or_default()
                    );
                    if key != last_key {
                        last_key = key.clone();
                        if let Some(name) = path.file_name().and_then(|s| s.to_str()) {
                            if let Some(shot) = parse_filename(name) {
                                let _ = app_c.emit("player-position", &shot);
                                // 读取坐标后是否删除截图由设置决定
                                if delete_after {
                                    let _ = std::fs::remove_file(&path);
                                }
                            }
                        }
                    }
                }
            }
            // 读取坐标后删除模式下，启动之后产生的不含坐标截图同样清理
            if delete_after {
                purge_unparsable(&dir);
            }
            std::thread::sleep(std::time::Duration::from_millis(500));
        }
    });
    ScreenshotHandle { stop }
}
