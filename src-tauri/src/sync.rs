//! 同步数据模型：快照（全量用户数据）与摘要（判断两端数据是否一致）。
//!
//! 电脑端与手机端共用：手机端作为 WS 客户端，需要用同一套结构生成 / 解析快照，
//! 因此本模块不依赖 axum 等桌面端专用库，两端都编译。
//! 局域网服务端（`lan.rs`，仅电脑端）复用这里的函数。

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

use crate::persist::Persisted;

/// 快照结构（settings + Persisted）。导出时 Persisted.offsets 已被清空。
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub settings: crate::AppSettings,
    pub persisted: Persisted,
}

/// 数据摘要：用于判断两端用户数据是否一致。
/// 刻意不含日志 / 截图目录等「只属于某一台机器」的字段（手机端应用快照时会清空它们）。
#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct SyncSummary {
    /// 有进度的任务数（已接取或已完成）
    pub quest_count: usize,
    /// 已完成的任务数
    pub completed_count: usize,
    /// 收藏家已收集物品数
    pub collected_count: usize,
    /// 手动解锁的任务数
    pub unlocked_count: usize,
    /// 档案等级
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

/// 收藏进度真值源是 collected.json；quest_state.json 里的 collected 仅作回退（老数据）。
/// 两者不一致时以文件为准，避免把用户刚取消勾选的物品从旧快照里带回来。
fn resolve_collected(app: &AppHandle, persisted: &Persisted) -> Vec<String> {
    let file_exists = crate::persist::collected_path(app)
        .map(|p| p.exists())
        .unwrap_or(false);
    if file_exists {
        crate::persist::load_collected(app)
    } else {
        persisted.collected.clone()
    }
}

/// 读取当前全量快照（Persisted.offsets 清空），供 /api/snapshot 与同步两端使用
pub fn build_snapshot(app: &AppHandle) -> Result<String, String> {
    let settings = crate::read_settings(app);
    let mut persisted = crate::persist::load(app);
    persisted.offsets.clear();
    persisted.collected = resolve_collected(app, &persisted);
    let snap = Snapshot { settings, persisted };
    serde_json::to_string(&snap).map_err(|e| e.to_string())
}

/// 生成数据摘要：任务进度 / 收藏 / 解锁 / 档案的规范化指纹 + 便于展示的计数
pub fn build_summary(app: &AppHandle) -> SyncSummary {
    let mut persisted = crate::persist::load(app);
    persisted.collected = resolve_collected(app, &persisted);
    let settings = crate::read_settings(app);

    // 规范化：排序后拼成定长文本再哈希，保证两端只要数据相同指纹就相同
    let mut quests: Vec<(String, String, String)> = persisted
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

    let mut collected = persisted.collected.clone();
    collected.sort();
    let mut unlocked = persisted.unlocked.clone();
    unlocked.sort();
    let mut loyalty: Vec<(String, u32)> = settings
        .profile
        .loyalty
        .iter()
        .map(|(k, v)| (k.clone(), *v))
        .collect();
    loyalty.sort();
    let mut locked_maps = settings.profile.locked_maps.clone();
    locked_maps.sort();

    let mut quest_count = 0usize;
    let mut completed_count = 0usize;
    for (_, accepted, completed) in &quests {
        if !accepted.is_empty() || !completed.is_empty() {
            quest_count += 1;
        }
        if !completed.is_empty() {
            completed_count += 1;
        }
    }

    let mut buf = String::new();
    for (id, accepted, completed) in &quests {
        buf.push_str(id);
        buf.push('|');
        buf.push_str(accepted);
        buf.push('|');
        buf.push_str(completed);
        buf.push('\n');
    }
    buf.push_str("#collected\n");
    for id in &collected {
        buf.push_str(id);
        buf.push('\n');
    }
    buf.push_str("#unlocked\n");
    for id in &unlocked {
        buf.push_str(id);
        buf.push('\n');
    }
    buf.push_str("#profile\n");
    buf.push_str(&format!("level={}\n", settings.profile.level));
    for (k, v) in &loyalty {
        buf.push_str(&format!("{k}={v}\n"));
    }
    for m in &locked_maps {
        buf.push_str(&format!("lock={m}\n"));
    }

    SyncSummary {
        quest_count,
        completed_count,
        collected_count: collected.len(),
        unlocked_count: unlocked.len(),
        level: settings.profile.level,
        hash: format!("{:016x}", fnv1a64(buf.as_bytes())),
        empty: quest_count == 0 && completed_count == 0 && collected.is_empty() && unlocked.is_empty(),
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
    crate::write_settings(app, &parsed.settings)?;
    let mut persisted = parsed.persisted;
    persisted.offsets.clear();
    let p = crate::persist::state_path(app).ok_or_else(|| "无法确定数据目录".to_string())?;
    if let Some(parent) = p.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let content = serde_json::to_string(&persisted).map_err(|e| e.to_string())?;
    std::fs::write(&p, &content).map_err(|e| e.to_string())?;
    crate::persist::save_collected(app, &persisted.collected);
    crate::apply_persisted(app, &persisted);
    let _ = app.emit("lan-sync-updated", ());
    Ok(())
}

// ---------------- Tauri commands（电脑端与手机端都注册） ----------------

/// 当前全量快照（settings + 任务进度）JSON 字符串
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
