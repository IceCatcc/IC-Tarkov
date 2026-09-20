//! 启动进度上报。
//!
//! 耗时的资料读取（任务进度 / 游戏数据集 / 数据更新检查）已从 Tauri 的 setup
//! 主线程挪到后台线程执行，主线程立即返回，窗口先出首帧。这里记录「当前读到
//! 哪一步」，通过 `startup-step` 事件与 `get_startup_state` 命令提供给前端，
//! 渲染「读取中 xx」提示。

use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, Emitter};

/// 前端订阅的启动步骤事件名
pub const EVENT_STEP: &str = "startup-step";

#[derive(Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct StartupState {
    /// 步骤键：同一键只占一行，文案变化时原地更新（如数据集读取的各子阶段）
    pub step: String,
    /// 展示文案（「正在读取游戏数据…」）
    pub label: String,
    /// 后台资料读取是否已结束（成功与失败都为 true；
    /// 前端拿到 true 后即可安全调用依赖数据集的命令）
    pub done: bool,
    /// 读取失败信息（失败时仍置 done：界面照常进入，只是数据为空）
    pub error: Option<String>,
}

/// 启动进度记录器（由 setup 装配，后台加载线程逐步写入）
pub struct StartupTracker {
    inner: Mutex<StartupState>,
}

impl Default for StartupTracker {
    fn default() -> Self {
        Self::new()
    }
}

impl StartupTracker {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(StartupState::default()),
        }
    }

    /// 写入状态并广播（先改状态再发事件，保证事件回调里查到的状态不会回退）
    fn update(&self, app: &AppHandle, f: impl FnOnce(&mut StartupState)) {
        let snap = {
            let mut g = self.inner.lock().unwrap();
            f(&mut g);
            g.clone()
        };
        let _ = app.emit(EVENT_STEP, snap);
    }

    /// 报告当前步骤；同一步骤内的文案变化沿用同一个 step 键
    pub fn step(&self, app: &AppHandle, step: &str, label: &str) {
        self.update(app, |s| {
            s.step = step.to_string();
            s.label = label.to_string();
        });
    }

    /// 后台加载结束（成功与失败都要调用，避免前端一直停在遮罩上）
    pub fn finish(&self, app: &AppHandle, error: Option<String>) {
        self.update(app, |s| {
            s.done = true;
            s.error = error;
        });
    }

    pub fn snapshot(&self) -> StartupState {
        self.inner.lock().unwrap().clone()
    }
}
