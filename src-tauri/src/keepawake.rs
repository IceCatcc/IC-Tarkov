//! 移动端屏幕常亮（Android `FLAG_KEEP_SCREEN_ON`）。
//!
//! 手机端常作为第二屏查看任务 / 地图，自动熄屏会打断使用，因此默认开启并可在设置里关闭。
//! 开关状态持久化在 settings.json 的 keepScreenOn：
//! - 启动时后端按设置应用一次；
//! - 切换开关时经 JNI 反射调用 `MainActivity.setKeepScreenOn` 即时生效。
//!
//! 桌面端（系统休眠由系统统一管理）与 iOS（暂无原生工程）不做处理，仅持久化设置。

use crate::{read_settings, write_settings, AppSettings};

/// 把常亮状态应用到当前窗口。仅 Android 生效，其余平台静默忽略（不报错、不阻塞启动）。
pub fn apply(app: &tauri::AppHandle, enable: bool) {
    #[cfg(target_os = "android")]
    {
        use tauri::Manager;
        // Window flag 只能在 UI 线程改：借 webview 的 JNI handle 把闭包投递到主线程执行
        let Some(window) = app.get_webview_window("main") else {
            return;
        };
        let _ = window.with_webview(move |webview| {
            webview.jni_handle().exec(move |env, activity, _webview| {
                // 反射调用 MainActivity.setKeepScreenOn(boolean)，JNI 签名 "(Z)V"；
                // 该方法在 proguard-rules.pro 中 keep，避免 release 包被 R8 移除后反射失败。
                if let Err(e) = env.call_method(
                    activity,
                    "setKeepScreenOn",
                    "(Z)V",
                    &[jni::objects::JValue::Bool(enable as u8)],
                ) {
                    eprintln!("[keepawake] 设置屏幕常亮失败：{e}");
                }
            });
        });
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = (app, enable);
    }
}

/// 切换屏幕常亮：写入 settings.json 并立即生效（移动端）。
#[tauri::command]
pub fn set_keep_screen_on(app: tauri::AppHandle, enable: bool) -> Result<AppSettings, String> {
    let mut s = read_settings(&app);
    s.keep_screen_on = enable;
    write_settings(&app, &s)?;
    apply(&app, enable);
    Ok(s)
}
