//! 显示器滤镜：直接改写显卡的 gamma ramp（GDI `SetDeviceGammaRamp`）。
//!
//! 原理：显卡输出阶段有一张 3×256 的查找表（LUT），8bit 像素值先经它映射成 16bit
//! 再送显示器。改这张表等于改「显示器画面设置」，因此对全屏独占（DirectX）游戏同样生效，
//! 而且不注入游戏进程、不叠加后处理，无性能开销。
//!
//! 要点：
//! - LUT 属于**显示设备**而非窗口，程序退出后仍保留（与参考工具一致）；
//!   重启系统 / 驱动重置 / 切换分辨率会还原成线性表，故启动时按存档再应用一次。
//! - 只声明 gdi32 / user32 的少量导出函数，不引入 windows crate（避免多一份绑定与体积）。
//! - 非 Windows 桌面平台编译为空实现：命令照常注册，返回空列表 / 报错文案。

use std::collections::HashMap;

#[cfg(target_os = "windows")]
use std::ffi::c_void;

// ---------------- 参数 ----------------

/// 一台显示器的滤镜参数（1.0 = 不改变）
#[derive(Clone, Copy, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct FilterParams {
    /// 亮度：整条曲线的线性缩放
    pub brightness: f32,
    /// 对比度：围绕中灰 0.5 拉伸 / 压缩
    pub contrast: f32,
    /// Gamma（>1 提亮中间调，<1 压暗中间调），RGB 分通道
    pub gamma_r: f32,
    pub gamma_g: f32,
    pub gamma_b: f32,
}

impl Default for FilterParams {
    fn default() -> Self {
        Self {
            brightness: 1.0,
            contrast: 1.0,
            gamma_r: 1.0,
            gamma_g: 1.0,
            gamma_b: 1.0,
        }
    }
}

impl FilterParams {
    /// 限制到安全范围：驱动会拒绝过于离谱的查找表（表现为「应用失败」），先夹一道
    fn sanitized(&self) -> Self {
        let f = |v: f32, lo: f32, hi: f32| {
            if v.is_finite() {
                v.clamp(lo, hi)
            } else {
                1.0
            }
        };
        Self {
            brightness: f(self.brightness, 0.30, 2.50),
            contrast: f(self.contrast, 0.20, 3.00),
            gamma_r: f(self.gamma_r, 0.20, 6.00),
            gamma_g: f(self.gamma_g, 0.20, 6.00),
            gamma_b: f(self.gamma_b, 0.20, 6.00),
        }
    }
}

/// 全局快捷键（Windows 虚拟键码 + 修饰键）
///
/// 不用字符串加速器而直接存 VK + 修饰位：前端 `KeyboardEvent.code` 到 VK 的映射是固定的，
/// 后端注册时只需拼 `RegisterHotKey` 的 mods，省掉一层易错的解析。
#[derive(Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Hotkey {
    /// 虚拟键码（如 NumpadSubtract = 0x6D、F1 = 0x70）
    pub vk: u32,
    pub ctrl: bool,
    pub alt: bool,
    pub shift: bool,
    /// 界面显示用文本（如 `Numpad-`、`Ctrl+Alt+F1`），后端不解析
    pub label: String,
}

impl Default for Hotkey {
    fn default() -> Self {
        Self {
            vk: 0,
            ctrl: false,
            alt: false,
            shift: false,
            label: String::new(),
        }
    }
}

impl Hotkey {
    /// 能否注册（只有修饰键 / 空键码无效）
    fn is_valid(&self) -> bool {
        self.vk > 0
    }

    /// 用于「配置是否变化」比较的指纹
    fn signature(&self) -> String {
        format!("{}:{}:{}:{}", self.vk, self.ctrl, self.alt, self.shift)
    }
}

/// 一套命名方案（预设 / 快捷键绑定目标）
#[derive(Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FilterPreset {
    pub name: String,
    pub params: FilterParams,
    /// 绑定到这套方案的全局快捷键（未绑定时为 null）
    #[serde(default)]
    pub hotkey: Option<Hotkey>,
}

/// `display-filter-changed` 事件载荷：快捷键命中后推给前端的完整新状态
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FilterChangedPayload {
    pub state: FilterState,
    /// 触发该次变更的方案名
    pub preset: Option<String>,
    /// 本次实际作用的显示器（快捷键只改选中的那一台）
    pub display: Option<String>,
}

/// 整机状态（持久化到 `<数据根>/display-filter.json`）
#[derive(Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct FilterState {
    /// 总开关：关闭时不应用任何滤镜（并会还原所有显示器）
    pub enabled: bool,
    /// RGB 三通道联动（界面上勾「锁定 RGB 通道」）
    pub locked_rgb: bool,
    /// 界面当前选中的显示器（设备名）；快捷键只作用于它
    pub selected: Option<String>,
    /// 每块显示器最后一次生效的参数，键为设备名（`\\.\DISPLAY1`）
    pub displays: HashMap<String, FilterParams>,
    /// 只保留用户自建方案（内置的「恢复默认 / 亮度+40 / +60 / +100」已移除）
    pub presets: Vec<FilterPreset>,
}

impl Default for FilterState {
    fn default() -> Self {
        Self {
            enabled: true,
            locked_rgb: true,
            selected: None,
            displays: HashMap::new(),
            presets: Vec::new(),
        }
    }
}

/// 早期版本内置的方案：现在不再提供，读档时按「名称 + 参数都吻合」清掉。
/// 用参数一起判定，避免误删用户自己建的同名但不同参数的方案。
fn is_builtin_preset(p: &FilterPreset) -> bool {
    let same = |b: f32, c: f32, g: f32| {
        (p.params.brightness - b).abs() < 1e-4
            && (p.params.contrast - c).abs() < 1e-4
            && (p.params.gamma_r - g).abs() < 1e-4
            && (p.params.gamma_g - g).abs() < 1e-4
            && (p.params.gamma_b - g).abs() < 1e-4
    };
    match p.name.as_str() {
        "恢复默认" => same(1.0, 1.0, 1.0),
        "亮度+40" => same(0.786_764_7, 1.198_529_4, 2.300_377_4),
        "亮度+60" => same(0.845_588_2, 1.617_647_1, 3.095_471_7),
        "亮度+100" => same(0.867_647_05, 1.845_588_3, 3.705_660_4),
        _ => false,
    }
}

/// 显示器描述（界面用来渲染选择列表）
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DisplayInfo {
    /// 设备名，如 `\\.\DISPLAY1`（gamma ramp 的操作对象）
    pub id: String,
    /// 显卡输出名（如 `NVIDIA GeForce RTX 4060`）
    pub name: String,
    /// 显示器名（EDID，如 `Generic PnP Monitor`）
    pub monitor: String,
    pub width: u32,
    pub height: u32,
    /// 主显示器（多屏时的重要标识）
    pub primary: bool,
}

// ---------------- 持久化 ----------------

const FILE_NAME: &str = "display-filter.json";

fn state_path(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    Ok(crate::data_root(app)?.join(FILE_NAME))
}

fn load_state(app: &tauri::AppHandle) -> FilterState {
    let mut st = state_path(app)
        .ok()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|t| serde_json::from_str::<FilterState>(&t).ok())
        .unwrap_or_default();
    // 老存档里可能还留着内置方案：按值判定后清掉（用户自建方案原样保留）
    st.presets.retain(|p| !is_builtin_preset(p));
    st
}

fn store_state(app: &tauri::AppHandle, state: &FilterState) -> Result<(), String> {
    let p = state_path(app)?;
    let text = serde_json::to_string_pretty(state).map_err(|e| e.to_string())?;
    std::fs::write(&p, text).map_err(|e| format!("写入 {} 失败：{e}", p.display()))?;
    // 任何一次落盘都把快捷键注册对齐到最新状态（内部按指纹去重，参数微调不会重注册）
    sync_hotkeys(app, state);
    Ok(())
}

// ---------------- 曲线 ----------------

/// 由参数生成 3×256 的查找表（每通道 256 项，16bit，0..=65535）
///
/// 顺序：对比度（绕中灰拉伸）→ 亮度（线性缩放）→ Gamma（幂 1/gamma）。
/// 三步都是单调函数且末段夹到 [0,1]，保证整表单调递增（驱动要求）。
pub fn build_ramp(params: &FilterParams) -> [u16; 768] {
    let p = params.sanitized();
    let gammas = [p.gamma_r, p.gamma_g, p.gamma_b];
    let mut ramp = [0u16; 768];
    for (ch, gamma) in gammas.iter().enumerate() {
        let inv = 1.0 / gamma;
        for i in 0..256usize {
            let mut v = i as f32 / 255.0;
            v = (v - 0.5) * p.contrast + 0.5;
            v = (v * p.brightness).clamp(0.0, 1.0);
            let out = v.powf(inv).clamp(0.0, 1.0);
            ramp[ch * 256 + i] = (out * 65535.0).round() as u16;
        }
    }
    ramp
}

// ---------------- Windows 实现 ----------------

#[cfg(target_os = "windows")]
mod win {
    use std::ffi::c_void;

    pub type Hdc = *mut c_void;

    /// `DISPLAY_DEVICEW`（wingdi.h）
    #[repr(C)]
    pub struct DisplayDeviceW {
        pub cb: u32,
        pub device_name: [u16; 32],
        pub device_string: [u16; 128],
        pub state_flags: u32,
        pub device_id: [u16; 128],
        pub device_key: [u16; 128],
    }

    impl DisplayDeviceW {
        pub fn new() -> Self {
            let mut d: Self = unsafe { std::mem::zeroed() };
            d.cb = std::mem::size_of::<Self>() as u32;
            d
        }
    }

    /// `DEVMODEW`（wingdi.h）：仅用分辨率与屏幕原点，其余字段按声明对齐保留
    #[repr(C)]
    pub struct DevModeW {
        pub dm_device_name: [u16; 32],
        pub dm_spec_version: u16,
        pub dm_driver_version: u16,
        pub dm_size: u16,
        pub dm_driver_extra: u16,
        pub dm_fields: u32,
        pub dm_position_x: i32,
        pub dm_position_y: i32,
        pub dm_display_orientation: u32,
        pub dm_display_fixed_output: u32,
        pub dm_color: i16,
        pub dm_duplex: i16,
        pub dm_y_resolution: i16,
        pub dm_tt_option: i16,
        pub dm_collate: i16,
        pub dm_form_name: [u16; 32],
        pub dm_log_pixels: u16,
        pub dm_bits_per_pel: u32,
        pub dm_pels_width: u32,
        pub dm_pels_height: u32,
        pub dm_display_flags: u32,
        pub dm_display_frequency: u32,
        pub dm_icm_method: u32,
        pub dm_icm_intent: u32,
        pub dm_media_type: u32,
        pub dm_dither_type: u32,
        pub dm_reserved1: u32,
        pub dm_reserved2: u32,
        pub dm_panning_width: u32,
        pub dm_panning_height: u32,
    }

    impl DevModeW {
        pub fn new() -> Self {
            let mut d: Self = unsafe { std::mem::zeroed() };
            d.dm_size = std::mem::size_of::<Self>() as u16;
            d
        }
    }

    #[link(name = "gdi32")]
    extern "system" {
        pub fn CreateDCW(
            driver: *const u16,
            device: *const u16,
            port: *const u16,
            init: *const DevModeW,
        ) -> Hdc;
        pub fn DeleteDC(hdc: Hdc) -> i32;
        pub fn SetDeviceGammaRamp(hdc: Hdc, ramp: *const u16) -> i32;
    }

    #[link(name = "user32")]
    extern "system" {
        pub fn EnumDisplayDevicesW(
            device: *const u16,
            dev_num: u32,
            dd: *mut DisplayDeviceW,
            flags: u32,
        ) -> i32;
        pub fn EnumDisplaySettingsW(device: *const u16, mode: u32, dm: *mut DevModeW) -> i32;
        pub fn ShowWindow(hwnd: *mut c_void, cmd: i32) -> i32;
        /// 注册全局热键（hWnd = NULL 时 WM_HOTKEY 投递到调用线程的消息队列）
        pub fn RegisterHotKey(hwnd: *mut c_void, id: i32, mods: u32, vk: u32) -> i32;
        pub fn UnregisterHotKey(hwnd: *mut c_void, id: i32) -> i32;
        /// 非阻塞取消息：只用来把队列里的 WM_HOTKEY 取出来处理
        pub fn PeekMessageW(
            msg: *mut Msg,
            hwnd: *mut c_void,
            filter_min: u32,
            filter_max: u32,
            remove: u32,
        ) -> i32;
    }

    #[link(name = "kernel32")]
    extern "system" {
        /// 本进程关联的控制台窗口（没有控制台时为 NULL）
        pub fn GetConsoleWindow() -> *mut c_void;
    }

    #[link(name = "advapi32")]
    extern "system" {
        /// 打开已有注册表键（不存在时返回非 0）
        pub fn RegOpenKeyExW(
            hkey: *mut c_void,
            sub_key: *const u16,
            options: u32,
            sam_desired: u32,
            result: *mut *mut c_void,
        ) -> i32;
        /// 打开或创建注册表键（写兼容性标记时 Layers 键可能还不存在）
        pub fn RegCreateKeyExW(
            hkey: *mut c_void,
            sub_key: *const u16,
            reserved: u32,
            class: *const u16,
            options: u32,
            sam_desired: u32,
            security: *const c_void,
            result: *mut *mut c_void,
            disposition: *mut u32,
        ) -> i32;
        pub fn RegSetValueExW(
            hkey: *mut c_void,
            value_name: *const u16,
            reserved: u32,
            ty: u32,
            data: *const u8,
            cb: u32,
        ) -> i32;
        pub fn RegQueryValueExW(
            hkey: *mut c_void,
            value_name: *const u16,
            reserved: *mut u32,
            ty: *mut u32,
            data: *mut u8,
            cb: *mut u32,
        ) -> i32;
        pub fn RegDeleteValueW(hkey: *mut c_void, value_name: *const u16) -> i32;
        pub fn RegCloseKey(hkey: *mut c_void) -> i32;
    }

    #[link(name = "shell32")]
    extern "system" {
        /// 以指定动词启动进程（`runas` = 触发 UAC 提权）
        pub fn ShellExecuteW(
            hwnd: *mut c_void,
            op: *const u16,
            file: *const u16,
            params: *const u16,
            dir: *const u16,
            show: i32,
        ) -> *mut c_void;
        /// 当前进程是否以管理员身份运行（已弃用但仍由 shell32 导出，语义最简单）
        pub fn IsUserAnAdmin() -> i32;
    }

    /// `MSG`（winuser.h）
    #[repr(C)]
    pub struct Msg {
        pub hwnd: *mut c_void,
        pub message: u32,
        pub w_param: usize,
        pub l_param: isize,
        pub time: u32,
        pub pt_x: i32,
        pub pt_y: i32,
    }

    /// 该设备已挂到桌面
    pub const ATTACHED_TO_DESKTOP: u32 = 0x0000_0001;
    /// 镜像驱动（多屏复制），不是真实输出，跳过
    pub const MIRRORING_DRIVER: u32 = 0x0000_0008;
    /// `ENUM_CURRENT_SETTINGS`
    pub const CURRENT_SETTINGS: u32 = 0xFFFF_FFFF;

    /// `ShowWindow` 的隐藏命令
    pub const SW_HIDE: i32 = 0;

    /// `HKEY_CURRENT_USER`（预定义句柄，值固定）
    pub const HKEY_CURRENT_USER: usize = 0x8000_0001;
    /// `KEY_QUERY_VALUE`
    pub const KEY_QUERY_VALUE: u32 = 0x0001;
    /// `KEY_SET_VALUE`
    pub const KEY_SET_VALUE: u32 = 0x0002;
    /// `REG_SZ`
    pub const REG_SZ: u32 = 1;
    /// `ERROR_FILE_NOT_FOUND`（删除不存在的值时会返回它）
    pub const ERROR_FILE_NOT_FOUND: i32 = 2;

    pub const WM_HOTKEY: u32 = 0x0312;
    pub const PM_REMOVE: u32 = 0x0001;
    pub const MOD_ALT: u32 = 0x0001;
    pub const MOD_CONTROL: u32 = 0x0002;
    pub const MOD_SHIFT: u32 = 0x0004;
    /// 按住不放时不重复触发
    pub const MOD_NOREPEAT: u32 = 0x4000;
}

#[cfg(target_os = "windows")]
fn wide_to_string(buf: &[u16]) -> String {
    let end = buf.iter().position(|c| *c == 0).unwrap_or(buf.len());
    String::from_utf16_lossy(&buf[..end])
}

#[cfg(target_os = "windows")]
fn to_wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

/// 枚举已挂到桌面的显示器
#[cfg(target_os = "windows")]
fn enumerate() -> Vec<DisplayInfo> {
    use win::*;

    let mut out = Vec::new();
    let mut index = 0u32;
    loop {
        let mut dd = DisplayDeviceW::new();
        // 以 NULL 为设备名枚举「适配器」层，每项给出 \\.\DISPLAYn 与显卡名
        if unsafe { EnumDisplayDevicesW(std::ptr::null(), index, &mut dd, 0) } == 0 {
            break;
        }
        index += 1;
        if dd.state_flags & ATTACHED_TO_DESKTOP == 0 || dd.state_flags & MIRRORING_DRIVER != 0 {
            continue;
        }
        let id = wide_to_string(&dd.device_name);
        if id.is_empty() {
            continue;
        }
        let name = wide_to_string(&dd.device_string);

        // 子设备（显示器本身）
        let mut mon = DisplayDeviceW::new();
        let monitor = if unsafe { EnumDisplayDevicesW(dd.device_name.as_ptr(), 0, &mut mon, 0) } != 0
        {
            wide_to_string(&mon.device_string)
        } else {
            String::new()
        };

        // 分辨率与主显示器判定（主屏原点固定为 0,0）
        let mut dm = DevModeW::new();
        let (mut width, mut height, mut primary) = (0u32, 0u32, false);
        if unsafe { EnumDisplaySettingsW(dd.device_name.as_ptr(), CURRENT_SETTINGS, &mut dm) } != 0 {
            width = dm.dm_pels_width;
            height = dm.dm_pels_height;
            primary = dm.dm_position_x == 0 && dm.dm_position_y == 0;
        }

        out.push(DisplayInfo {
            id,
            name,
            monitor,
            width,
            height,
            primary,
        });
    }
    out
}

#[cfg(not(target_os = "windows"))]
fn enumerate() -> Vec<DisplayInfo> {
    Vec::new()
}

/// 取某块显示器的 DC（DISPLAY 驱动 + 设备名），用完必须 DeleteDC
#[cfg(target_os = "windows")]
fn display_dc(device_id: &str) -> Option<win::Hdc> {
    let driver = to_wide("DISPLAY");
    let device = to_wide(device_id);
    let hdc = unsafe {
        win::CreateDCW(
            driver.as_ptr(),
            device.as_ptr(),
            std::ptr::null(),
            std::ptr::null(),
        )
    };
    if hdc.is_null() {
        None
    } else {
        Some(hdc)
    }
}

/// 把参数下发到指定显示器；`None` 表示还原线性表
#[cfg(target_os = "windows")]
fn apply_to_device(device_id: &str, params: Option<&FilterParams>) -> Result<(), String> {
    let hdc = display_dc(device_id).ok_or_else(|| format!("无法取得显示器 {device_id} 的设备上下文"))?;
    let ramp = params.map(build_ramp).unwrap_or_else(|| build_ramp(&FilterParams::default()));
    let ok = unsafe { win::SetDeviceGammaRamp(hdc, ramp.as_ptr()) };
    unsafe { win::DeleteDC(hdc) };
    if ok == 0 {
        // 系统 / 驱动拒绝：常见于超出驱动允许范围的极端参数，或显示器处于独占全屏
        return Err(format!(
            "{device_id} 应用失败（显卡驱动拒绝了该参数范围，可尝试减小调整幅度后重试）"
        ));
    }
    Ok(())
}

#[cfg(not(target_os = "windows"))]
fn apply_to_device(_device_id: &str, _params: Option<&FilterParams>) -> Result<(), String> {
    Err("显示器滤镜仅支持 Windows".to_string())
}

// ---------------- 全局快捷键 ----------------

/// 把「期望的快捷键列表」对齐给后台线程（滤镜关闭时等于全部注销）
pub fn sync_hotkeys(app: &tauri::AppHandle, state: &FilterState) {
    #[cfg(target_os = "windows")]
    hotkeys::sync(app, state);
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (app, state);
    }
}

/// 全局快捷键的后台线程（Windows）
///
/// `RegisterHotKey(NULL, …)` 把 `WM_HOTKEY` 投递到**调用线程**的消息队列，所以注册必须固定在
/// 同一个线程里做：这里起一个常驻线程，自己持有消息队列，用 `PeekMessageW` 非阻塞取消息。
/// 配置变更走 mpsc 通道（最多 20ms 轮询间隔），不必再往线程里 Post 自定义消息。
///
/// 权限说明：热键由系统转发，游戏以管理员身份运行时，未提权的进程收不到 `WM_HOTKEY`
/// （UIPI 拦截），因此界面提供「以管理员身份重启」，与参考工具一致。
#[cfg(target_os = "windows")]
mod hotkeys {
    use super::*;
    use once_cell::sync::Lazy;
    use std::sync::mpsc::{channel, Receiver, RecvTimeoutError, Sender};
    use std::sync::{Mutex, Once};
    use std::time::Duration;
    use tauri::Emitter;

    static STARTED: Once = Once::new();
    static TX: Lazy<Mutex<Option<Sender<Vec<FilterPreset>>>>> = Lazy::new(|| Mutex::new(None));
    /// 已生效配置的指纹：参数微调触发的落盘不需要重新注册热键
    static LAST_SIG: Lazy<Mutex<String>> = Lazy::new(|| Mutex::new(String::new()));

    fn fingerprint(list: &[FilterPreset]) -> String {
        list.iter()
            .map(|p| {
                format!(
                    "{}={}",
                    p.name,
                    p.hotkey.as_ref().map(|h| h.signature()).unwrap_or_default()
                )
            })
            .collect::<Vec<_>>()
            .join("|")
    }

    pub fn sync(app: &tauri::AppHandle, state: &FilterState) {
        let list: Vec<FilterPreset> = if state.enabled {
            state
                .presets
                .iter()
                .filter(|p| p.hotkey.as_ref().map_or(false, |h| h.is_valid()))
                .cloned()
                .collect()
        } else {
            Vec::new()
        };
        let sig = fingerprint(&list);
        {
            let mut last = LAST_SIG.lock().unwrap();
            if *last == sig {
                return;
            }
            *last = sig;
        }
        STARTED.call_once(|| {
            let (tx, rx) = channel::<Vec<FilterPreset>>();
            *TX.lock().unwrap() = Some(tx);
            let app = app.clone();
            std::thread::spawn(move || run(app, rx));
        });
        if let Some(tx) = TX.lock().unwrap().as_ref() {
            let _ = tx.send(list);
        }
    }

    fn run(app: tauri::AppHandle, rx: Receiver<Vec<FilterPreset>>) {
        let mut active: Vec<FilterPreset> = Vec::new();
        let mut ids: Vec<i32> = Vec::new();
        loop {
            match rx.recv_timeout(Duration::from_millis(20)) {
                Ok(list) => register(&mut ids, &mut active, list),
                Err(RecvTimeoutError::Timeout) => {}
                Err(RecvTimeoutError::Disconnected) => break,
            }
            if !ids.is_empty() {
                drain(&app, &active);
            }
        }
    }

    /// 注销全部再按新列表注册；注册失败的（组合键冲突 / 已被别的程序占用）直接跳过
    fn register(ids: &mut Vec<i32>, active: &mut Vec<FilterPreset>, list: Vec<FilterPreset>) {
        for id in ids.drain(..) {
            unsafe {
                win::UnregisterHotKey(std::ptr::null_mut(), id);
            }
        }
        active.clear();
        for preset in list {
            let Some(hk) = preset.hotkey.as_ref() else {
                continue;
            };
            let id = (ids.len() + 1) as i32;
            let mut mods = win::MOD_NOREPEAT;
            if hk.alt {
                mods |= win::MOD_ALT;
            }
            if hk.ctrl {
                mods |= win::MOD_CONTROL;
            }
            if hk.shift {
                mods |= win::MOD_SHIFT;
            }
            let ok = unsafe { win::RegisterHotKey(std::ptr::null_mut(), id, mods, hk.vk) } != 0;
            if ok {
                ids.push(id);
                // id 与 active 的下标严格对应（wParam = id，取 active[id-1]）
                active.push(preset);
            }
        }
    }

    fn drain(app: &tauri::AppHandle, active: &[FilterPreset]) {
        unsafe {
            let mut msg: win::Msg = std::mem::zeroed();
            while win::PeekMessageW(
                &mut msg,
                std::ptr::null_mut(),
                win::WM_HOTKEY,
                win::WM_HOTKEY,
                win::PM_REMOVE,
            ) != 0
            {
                let idx = msg.w_param.wrapping_sub(1);
                if let Some(p) = active.get(idx) {
                    fire(app, p);
                }
            }
        }
    }

    /// 命中快捷键：方案只应用到**界面上选中的那台**显示器，落盘并通知界面刷新。
    /// 没有选中记录（老存档 / 刚装好还没打开过工具）时退回主显示器，再不行退回第一台。
    fn fire(app: &tauri::AppHandle, preset: &FilterPreset) {
        let mut st = load_state(app);
        let displays = enumerate();
        let target = st
            .selected
            .clone()
            .filter(|id| displays.iter().any(|d| &d.id == id))
            .or_else(|| displays.iter().find(|d| d.primary).map(|d| d.id.clone()))
            .or_else(|| displays.first().map(|d| d.id.clone()));
        let Some(target) = target else {
            return;
        };
        if apply_to_device(&target, Some(&preset.params)).is_ok() {
            st.displays.insert(target.clone(), preset.params);
        }
        // store_state 内部会再 sync 一次，指纹未变即直接返回
        let _ = store_state(app, &st);
        let _ = app.emit(
            "display-filter-changed",
            FilterChangedPayload {
                state: st,
                preset: Some(preset.name.clone()),
                display: Some(target),
            },
        );
    }
}

// ---------------- 命令 ----------------

/// 枚举显示器（浏览器端 / 非 Windows 返回空列表）
#[tauri::command]
pub fn list_displays() -> Vec<DisplayInfo> {
    enumerate()
}

/// 读取整机滤镜状态（含内置方案）
#[tauri::command]
pub fn get_display_filter(app: tauri::AppHandle) -> FilterState {
    load_state(&app)
}

/// 只落盘、不改变画面（总开关、方案增删、当前选择等）
#[tauri::command]
pub fn save_display_filter(app: tauri::AppHandle, state: FilterState) -> Result<(), String> {
    store_state(&app, &state)
}

/// 把参数应用到一台显示器，并记进存档（重启后自动复现）。
///
/// `selected` 由前端带上当前选中的显示器：这个命令会把整份状态写回磁盘，若只从存档里读
/// `selected`，前端刚切过显示器但落盘还没到头时会用旧值覆盖（快捷键随后就会作用错屏）。
#[tauri::command]
pub fn apply_display_filter(
    app: tauri::AppHandle,
    display_id: String,
    params: FilterParams,
    selected: Option<String>,
) -> Result<(), String> {
    let p = params.sanitized();
    apply_to_device(&display_id, Some(&p))?;
    let mut st = load_state(&app);
    if selected.is_some() {
        st.selected = selected;
    }
    st.displays.insert(display_id, p);
    store_state(&app, &st)
}

/// 还原显示器：指定 `displayId` 只还原这一台，省略则还原全部并清空存档
#[tauri::command]
pub fn reset_display_filter(app: tauri::AppHandle, display_id: Option<String>) -> Result<(), String> {
    let mut st = load_state(&app);
    let mut first_err: Option<String> = None;
    match display_id {
        Some(id) => {
            if let Err(e) = apply_to_device(&id, None) {
                first_err = Some(e);
            }
            st.displays.remove(&id);
        }
        None => {
            for id in enumerate().iter().map(|d| d.id.clone()) {
                if let Err(e) = apply_to_device(&id, None) {
                    first_err.get_or_insert(e);
                }
            }
            st.displays.clear();
        }
    }
    store_state(&app, &st)?;
    match first_err {
        Some(e) => Err(e),
        None => Ok(()),
    }
}

/// 启动时复现上次的滤镜（gamma ramp 不跨重启 / 驱动重置保留），并对齐全局快捷键
pub fn restore_on_startup(app: &tauri::AppHandle) {
    let st = load_state(app);
    if st.enabled {
        let ids: Vec<String> = enumerate().iter().map(|d| d.id.clone()).collect();
        for id in ids {
            if let Some(p) = st.displays.get(&id) {
                let _ = apply_to_device(&id, Some(p));
            }
        }
    }
    // 滤镜关闭时这里是空列表，等价于「不注册任何快捷键」
    sync_hotkeys(app, &st);
}

/// 当前进程是否以管理员身份运行
///
/// 游戏以管理员身份运行时，未提权的进程收不到全局热键（UIPI 拦截），界面据此提示提权。
#[tauri::command]
pub fn is_elevated() -> bool {
    #[cfg(target_os = "windows")]
    {
        unsafe { win::IsUserAnAdmin() != 0 }
    }
    #[cfg(not(target_os = "windows"))]
    {
        false
    }
}

/// 「以管理员身份重启」时附加的参数：新进程据此隐藏随 UAC 一起分配的控制台窗口
const ELEVATED_ARG: &str = "--elevated";

/// 若本进程是从「以管理员身份重启」拉起来的，隐藏系统分配的控制台窗口
///
/// 发布版是 GUI 子系统（`windows_subsystem = "windows"`），本来就没有控制台；
/// debug 构建是控制台子系统，提权启动时 Windows 会给它开一个黑框并把日志打在里面，
/// 这里在 `run()` 一开始就把窗口隐藏掉。
///
/// 刻意不用 `FreeConsole`：释放控制台后 stdout 句柄失效，之后任何 `println!` / `eprintln!`
/// 都会 panic（std 打印失败即 panic），隐藏窗口则句柄仍然有效。
pub fn hide_console_if_relaunched() {
    #[cfg(target_os = "windows")]
    {
        if !std::env::args().any(|a| a == ELEVATED_ARG) {
            return;
        }
        unsafe {
            let hwnd = win::GetConsoleWindow();
            if !hwnd.is_null() {
                win::ShowWindow(hwnd, win::SW_HIDE);
            }
        }
    }
}

/// 以管理员身份重启本程序：UAC 提权后当前进程退出（数据目录、存档都不变）
#[tauri::command]
pub fn relaunch_as_admin(app: tauri::AppHandle) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        let exe = std::env::current_exe().map_err(|e| e.to_string())?;
        let file = to_wide(&exe.to_string_lossy());
        let op = to_wide("runas");
        // 带上标记参数，避免新进程弹出控制台黑框（见 hide_console_if_relaunched）
        let params = to_wide(ELEVATED_ARG);
        // SW_SHOWNORMAL = 1；返回 HINSTANCE > 32 才算成功
        let h = unsafe {
            win::ShellExecuteW(
                std::ptr::null_mut(),
                op.as_ptr(),
                file.as_ptr(),
                params.as_ptr(),
                std::ptr::null(),
                1,
            )
        };
        if (h as isize) <= 32 {
            return Err(format!("提权启动失败（ShellExecuteW 返回 {}）", h as isize));
        }
        app.exit(0);
        Ok(())
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = app;
        Err("仅 Windows 支持以管理员身份重启".to_string())
    }
}

/* ---------------- 「始终以管理员身份启动」（exe 兼容性标记） ---------------- */

/// exe 兼容性标记的注册表位置：与资源管理器「属性 → 兼容性 → 以管理员身份运行此程序」
/// 写的是同一处。`HKCU` 只对当前用户生效，写入**不需要提权**，也不改 exe 文件本身。
#[cfg(target_os = "windows")]
const LAYERS_KEY: &str = r"Software\Microsoft\Windows NT\CurrentVersion\AppCompatFlags\Layers";

/// 「以管理员身份运行」这一层的名字
#[cfg(target_os = "windows")]
const RUN_AS_ADMIN_LAYER: &str = "RUNASADMIN";

/// 当前 exe 的路径（兼容性标记用完整路径当值名）
#[cfg(target_os = "windows")]
fn exe_path() -> Result<String, String> {
    std::env::current_exe()
        .map(|p| p.to_string_lossy().to_string())
        .map_err(|e| format!("读取当前程序路径失败：{e}"))
}

/// 把层字符串拆成层名列表（去掉开头的 `~`，按大小写不敏感去重）
#[cfg(target_os = "windows")]
fn layer_names(raw: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for token in raw.split_whitespace().filter(|t| *t != "~") {
        if !out.iter().any(|x| x.eq_ignore_ascii_case(token)) {
            out.push(token.to_string());
        }
    }
    out
}

/// 读当前 exe 的兼容性层字符串；键或值不存在都当空串（= 从没设过兼容性标记）
#[cfg(target_os = "windows")]
fn read_layers() -> Result<String, String> {
    let key = to_wide(LAYERS_KEY);
    let name = to_wide(&exe_path()?);
    unsafe {
        let mut hkey: *mut c_void = std::ptr::null_mut();
        let rc = win::RegOpenKeyExW(
            win::HKEY_CURRENT_USER as *mut c_void,
            key.as_ptr(),
            0,
            win::KEY_QUERY_VALUE,
            &mut hkey,
        );
        if rc != 0 {
            return Ok(String::new());
        }
        // 先问长度再取值（两次调用之间外部改动忽略）
        let mut ty = 0u32;
        let mut len = 0u32;
        let rc = win::RegQueryValueExW(
            hkey,
            name.as_ptr(),
            std::ptr::null_mut(),
            &mut ty,
            std::ptr::null_mut(),
            &mut len,
        );
        if rc != 0 || len == 0 {
            win::RegCloseKey(hkey);
            return Ok(String::new());
        }
        let mut buf = vec![0u8; len as usize];
        let rc = win::RegQueryValueExW(
            hkey,
            name.as_ptr(),
            std::ptr::null_mut(),
            &mut ty,
            buf.as_mut_ptr(),
            &mut len,
        );
        win::RegCloseKey(hkey);
        if rc != 0 {
            return Ok(String::new());
        }
        // REG_SZ：UTF-16LE，多数情况不带宽字符结尾的 NUL
        let units: Vec<u16> = buf[..len as usize]
            .chunks_exact(2)
            .map(|c| u16::from_le_bytes([c[0], c[1]]))
            .collect();
        Ok(String::from_utf16_lossy(&units)
            .trim_end_matches('\0')
            .to_string())
    }
}

/// 写入（`Some`）或删除（`None`）当前 exe 的兼容性层字符串
#[cfg(target_os = "windows")]
fn write_layers(value: Option<&str>) -> Result<(), String> {
    let key = to_wide(LAYERS_KEY);
    let name = to_wide(&exe_path()?);
    unsafe {
        let mut hkey: *mut c_void = std::ptr::null_mut();
        // 用 Create 而不是 Open：从没设过兼容性标记时 Layers 键可能整体不存在
        let rc = win::RegCreateKeyExW(
            win::HKEY_CURRENT_USER as *mut c_void,
            key.as_ptr(),
            0,
            std::ptr::null(),
            0,
            win::KEY_SET_VALUE,
            std::ptr::null(),
            &mut hkey,
            std::ptr::null_mut(),
        );
        if rc != 0 {
            return Err(format!("打开注册表键失败（错误码 {rc}）"));
        }
        let rc = match value {
            Some(v) => {
                // REG_SZ 不含结尾 NUL
                let data: Vec<u8> = v.encode_utf16().flat_map(|u| u.to_le_bytes()).collect();
                win::RegSetValueExW(
                    hkey,
                    name.as_ptr(),
                    0,
                    win::REG_SZ,
                    data.as_ptr(),
                    data.len() as u32,
                )
            }
            None => win::RegDeleteValueW(hkey, name.as_ptr()),
        };
        win::RegCloseKey(hkey);
        // 删一个本来就不存在的值 = 已经是想要的状态
        if rc != 0 && rc != win::ERROR_FILE_NOT_FOUND {
            return Err(format!("写入注册表失败（错误码 {rc}）"));
        }
        Ok(())
    }
}

/// 是否已设置「始终以管理员身份启动」
#[tauri::command]
pub fn get_auto_admin() -> Result<bool, String> {
    #[cfg(target_os = "windows")]
    {
        Ok(layer_names(&read_layers()?)
            .iter()
            .any(|t| t.eq_ignore_ascii_case(RUN_AS_ADMIN_LAYER)))
    }
    #[cfg(not(target_os = "windows"))]
    {
        Ok(false)
    }
}

/// 设置「始终以管理员身份启动」：写当前用户注册表里的 exe 兼容性标记，**下次启动生效**
///
/// 返回写入后的实际状态，前端以返回值刷新开关（避免界面与注册表不一致）。
/// 不影响当前进程——本次是否已提权仍由 `is_elevated` 判断：勾上了却没提权
/// （例如被计划任务 / 直接 CreateProcess 拉起）时，界面提示用「以管理员身份重启」。
#[tauri::command]
pub fn set_auto_admin(enabled: bool) -> Result<bool, String> {
    #[cfg(target_os = "windows")]
    {
        let mut names: Vec<String> = layer_names(&read_layers()?)
            .into_iter()
            .filter(|t| !t.eq_ignore_ascii_case(RUN_AS_ADMIN_LAYER))
            .collect();
        if enabled {
            names.insert(0, RUN_AS_ADMIN_LAYER.to_string());
        }
        if names.is_empty() {
            // 只删我们这一项，同一 exe 的其它兼容性层（如 HIGHDPIAWARE）原样保留
            write_layers(None)?;
        } else {
            write_layers(Some(&format!("~ {}", names.join(" "))))?;
        }
        Ok(enabled)
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = enabled;
        Err("仅 Windows 支持设置以管理员身份启动".to_string())
    }
}
