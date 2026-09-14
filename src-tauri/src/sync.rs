//! 同步数据模型：快照（全量用户数据）与摘要（判断两端数据是否一致）。
//!
//! 电脑端与手机端共用：手机端作为 WS 客户端，需要用同一套结构生成 / 解析快照，
//! 因此本模块不依赖 axum 等桌面端专用库，两端都编译。
//! 局域网服务端（`lan.rs`，仅电脑端）复用这里的函数。
//!
//! 任务进度按模式（PVP / PVPS / PVE）各存一份，快照与摘要都覆盖全部三套。

use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};

use crate::store::{norm_mode, ModeData, MODES};

/// 快照结构（settings + 三种模式的进度）。导出时各模式的 offsets 已被清空。
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub settings: crate::AppSettings,
    /// key = 模式名（pvp / pvps / pve）
    #[serde(default)]
    pub modes: HashMap<String, ModeData>,
    /// 电脑端「日志检测到的会话模式」：手机端应用快照后跟随切换（手机端没有本地日志）
    #[serde(default)]
    pub session_mode: Option<String>,
}

/// 数据摘要：用于判断两端用户数据是否一致（三套合并统计）。
/// 刻意不含日志 / 截图目录等「只属于某一台机器」的字段（手机端应用快照时会清空它们）。
#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct SyncSummary {
    /// 有进度的任务数（已接取或已完成，三套合计）
    pub quest_count: usize,
    /// 已完成的任务数（三套合计）
    pub completed_count: usize,
    /// 收藏家已收集物品数（三套合计）
    pub collected_count: usize,
    /// 手动解锁的任务数（三套合计）
    pub unlocked_count: usize,
    /// 档案等级（当前查看模式）
    pub level: u32,
    /// 内容指纹（FNV-1a 64 位十六进制）：两端一致即代表用户数据相同
    pub hash: String,
    /// 是否为空数据（全新安装 / 从未记录任何进度）
    pub empty: bool,
}

/// FNV-1a 64 位：实现固定的简易哈希，不依赖标准库的随机化 hasher。
fn fnv1a64(bytes: &[u8]) -> u64 {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in bytes {
        h ^= *b as u64;
        h = h.wrapping_mul(0x0000_0100_0000_01b3);
    }
    h
}

/// 从内存取三套模式数据（offsets 一律清空，跨设备导入由本机重扫本地日志重建）
fn collect_modes(app: &AppHandle) -> HashMap<String, ModeData> {
    let st = app.state::<crate::AppState>();
    let mut out: HashMap<String, ModeData> = {
        let g = st.modes.lock().unwrap();
        g.iter().map(|(k, v)| (k.clone(), v.clone())).collect()
    };
    for d in out.values_mut() {
        d.offsets.clear();
    }
    for m in MODES {
        out.entry(m.to_string()).or_insert_with(ModeData::new);
    }
    out
}

/// 读取当前全量快照（各模式 offsets 清空），供 /api/snapshot 与同步两端使用
pub fn build_snapshot(app: &AppHandle) -> Result<String, String> {
    let settings = crate::read_settings(app);
    let modes = collect_modes(app);
    let session_mode = Some(app.state::<crate::AppState>().active());
    let snap = Snapshot {
        settings,
        modes,
        session_mode,
    };
    serde_json::to_string(&snap).map_err(|e| e.to_string())
}

/// 生成数据摘要：三套进度的规范化指纹 + 便于展示的计数
pub fn build_summary(app: &AppHandle) -> SyncSummary {
    let modes = collect_modes(app);
    let settings = crate::read_settings(app);

    let mut buf = String::new();
    let mut quest_count = 0usize;
    let mut completed_count = 0usize;
    let mut collected_count = 0usize;
    let mut unlocked_count = 0usize;

    // 固定按 MODES 顺序拼接，保证两端指纹可比
    for m in MODES {
        let Some(md) = modes.get(m) else { continue };
        buf.push_str(&format!("#mode={m}\n"));

        let mut quests: Vec<(String, String, String)> = md
            .quests
            .iter()
            .map(|(id, e)| {
                (
                    id.clone(),
                    e.accepted_at.clone().unwrap_or_default(),
                    e.completed_at.clone().unwrap_or_default(),
                )
            })
            .collect();
        quests.sort();
        for (id, accepted, completed) in &quests {
            if !accepted.is_empty() || !completed.is_empty() {
                quest_count += 1;
            }
            if !completed.is_empty() {
                completed_count += 1;
            }
            buf.push_str(id);
            buf.push('|');
            buf.push_str(accepted);
            buf.push('|');
            buf.push_str(completed);
            // 手动勾选完成的目标（顺序无关的确定性拼接）
            let mut done: Vec<String> = md
                .quests
                .get(id)
                .map(|e| e.objectives_done.iter().cloned().collect())
                .unwrap_or_default();
            done.sort();
            if !done.is_empty() {
                buf.push_str("|obj=");
                buf.push_str(&done.join(","));
            }
            buf.push('\n');
        }

        let mut collected: Vec<String> = md.collected.iter().cloned().collect();
        collected.sort();
        collected_count += collected.len();
        buf.push_str("#collected\n");
        for id in &collected {
            buf.push_str(id);
            buf.push('\n');
        }

        let mut unlocked: Vec<String> = md.unlocked.iter().cloned().collect();
        unlocked.sort();
        unlocked_count += unlocked.len();
        buf.push_str("#unlocked\n");
        for id in &unlocked {
            buf.push_str(id);
            buf.push('\n');
        }

        let p = settings.profile_of(m);
        buf.push_str(&format!("#profile level={}\n", p.level));
        let mut loyalty: Vec<(String, u32)> = p.loyalty.iter().map(|(k, v)| (k.clone(), *v)).collect();
        loyalty.sort();
        for (k, v) in &loyalty {
            buf.push_str(&format!("{k}={v}\n"));
        }
        let mut locked_maps: Vec<String> = p.locked_maps.clone();
        locked_maps.sort();
        for x in &locked_maps {
            buf.push_str(&format!("lock={x}\n"));
        }
    }

    SyncSummary {
        quest_count,
        completed_count,
        collected_count,
        unlocked_count,
        level: settings.profile.level,
        hash: format!("{:016x}", fnv1a64(buf.as_bytes())),
        empty: quest_count == 0
            && completed_count == 0
            && collected_count == 0
            && unlocked_count == 0,
    }
}

/// 应用对端快照：写盘 + 载入内存 + 通知前端刷新。
/// 跨设备导入一律丢弃 offsets，由新设备重扫本地日志重建。
pub fn apply_snapshot_internal(app: &AppHandle, json: &str) -> Result<(), String> {
    #[allow(unused_mut)] // 移动端会清空目录字段，桌面 target 不需要 mut
    let mut parsed: Snapshot =
        serde_json::from_str(json).map_err(|e| format!("快照格式错误：{e}"))?;
    // 移动端：目录字段是电脑端本机路径，照搬会让手机端后续保存设置时
    // 因「日志目录不存在」报错，应用快照时直接清空
    #[cfg(mobile)]
    {
        parsed.settings.log_dir.clear();
        parsed.settings.screenshot_dir.clear();
    }
    // profile 是「当前查看模式」的镜像，以 profiles 真值源为准，避免覆盖错模式
    let vm = norm_mode(&crate::view_mode_of(app));
    parsed.settings.profile = parsed.settings.profile_of(&vm);
    crate::write_settings(app, &parsed.settings)?;

    // 三套进度写回内存（offsets 清空）
    {
        let st = app.state::<crate::AppState>();
        let mut g = st.modes.lock().unwrap();
        for m in MODES {
            let mut md = parsed.modes.get(m).cloned().unwrap_or_default();
            md.offsets.clear();
            g.insert(m.to_string(), md);
        }
    }
    // 跟随电脑端的会话模式：仅移动端（没有本地日志可检测）把「写入模式 / 查看模式」对齐过去，
    // 前端随后 getSessionMode() 即可自动切到对应档位。桌面端有自己的日志，不采用对端模式。
    #[cfg(mobile)]
    if let Some(m) = parsed.session_mode.as_deref() {
        let m = norm_mode(m);
        let st = app.state::<crate::AppState>();
        *st.active_mode.lock().unwrap() = m.clone();
        *st.view_mode.lock().unwrap() = m;
    }
    crate::persist::save_all_from(app);
    let _ = app.emit("lan-sync-updated", ());
    Ok(())
}

// ---------------- Tauri commands（电脑端与手机端都注册） ----------------

/// 当前全量快照（settings + 三套任务进度）JSON 字符串
#[tauri::command]
pub fn get_snapshot(app: AppHandle) -> Result<String, String> {
    build_snapshot(&app)
}

/// 应用对端推来的快照（写盘 + 载入内存 + 刷新前端）
#[tauri::command]
pub fn apply_snapshot(app: AppHandle, json: String) -> Result<(), String> {
    apply_snapshot_internal(&app, &json)
}

/// 本端数据摘要：手机端连接时上报，电脑端据此判断两端是否一致
#[tauri::command]
pub fn get_sync_summary(app: AppHandle) -> SyncSummary {
    build_summary(&app)
}
