//! 同步：电脑端本地 HTTP/WebSocket 服务（移动端作为 WS 客户端连接）。
//!
//! 路由：
//! - `GET /ws`           ：升级 WebSocket，双向通道。实时把后端事件转发给手机端；
//!   手机端可发指令：`{"type":"pull"}` 拉全量快照、`{"type":"refresh"}` 请求刷新。
//!   单设备限制：新连接会顶掉旧连接。连接建立时发 `lan-client-connected` 事件，
//!   电脑端「连接」窗口据此自动关闭。
//! - `GET /api/snapshot` ：返回全量用户数据快照（settings + Persisted，已丢弃 offsets）。
//! - `GET /api/info`     ：返回本机可连接 IP 列表 + 端口，供渲染二维码。
//!
//! 事件桥接在 `lib.rs` 的 `setup` 中通过 `app.listen` 订阅现有 Tauri 事件并 `send` 到
//! 广播通道，watcher/screenshots 零改动。手机端连上后先 `pull` 拿全量，再持续收增量事件。

use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::sync::Arc;
use std::sync::Mutex;

use axum::extract::{State, WebSocketUpgrade};
use axum::extract::ws::{Message, WebSocket};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::Router;
use futures_util::{SinkExt, StreamExt};
use futures_util::future::{select, Either};
use serde::Serialize;
use serde_json::json;
use tauri::{AppHandle, Emitter, Listener, Manager};
use tokio::sync::broadcast;

use crate::sync::{apply_snapshot_internal, build_snapshot, build_summary, SyncSummary};

const DEFAULT_PORT: u16 = 9527;
const BROADCAST_CAP: usize = 1024;

/// 全局 LAN 服务状态，由 `lib.rs::setup` 中 manage。
pub struct LanState {
    pub port: Mutex<u16>,
    pub broadcast_tx: Mutex<Option<broadcast::Sender<String>>>,
    pub server: Mutex<Option<tauri::async_runtime::JoinHandle<()>>>,
    /// 当前已连接手机的「单播出站」通道：(连接 id, 发送端)。
    /// 冲突决策命令（resolve_lan_conflict）通过它向手机下发指令。
    pub client_tx: Mutex<Option<(u64, tokio::sync::mpsc::Sender<String>)>>,
}

impl LanState {
    pub fn new() -> Self {
        Self {
            port: Mutex::new(DEFAULT_PORT),
            broadcast_tx: Mutex::new(None),
            server: Mutex::new(None),
            client_tx: Mutex::new(None),
        }
    }
}

/// 活跃连接登记（单设备限制）：新连接顶掉旧连接。
#[derive(Default)]
struct ActiveConn {
    next_id: u64,
    /// (连接代次, 关闭通知通道)：向该通道发 () 即让对应旧连接退出
    current: Option<(u64, tokio::sync::mpsc::UnboundedSender<()>)>,
}

/// 传给 axum handler 的共享上下文
struct ServerCtx {
    tx: broadcast::Sender<String>,
    app: AppHandle,
    active: Arc<Mutex<ActiveConn>>,
}

/// `/api/info` 与 `get_connect_info` 返回结构
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ConnectInfo {
    pub hosts: Vec<String>,
    pub port: u16,
}

/// `get_lan_status` 返回结构
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LanStatus {
    pub running: bool,
    pub port: u16,
    pub connections: usize,
}

// ---------------- 工具 ----------------

/// 枚举本机非回环 IPv4 地址，供手机端逐个尝试连接
fn local_ipv4_hosts() -> Vec<String> {
    let mut hosts = Vec::new();
    if let Ok(ifaces) = if_addrs::get_if_addrs() {
        for iface in ifaces {
            let ip = iface.addr.ip();
            if let IpAddr::V4(v4) = ip {
                if !v4.is_loopback() {
                    hosts.push(v4.to_string());
                }
            }
        }
    }
    hosts
}

/// 端口被占用则顺序试探下一个（最多 +100）
fn find_free_port(start: u16) -> u16 {
    for p in start..=start + 100 {
        if std::net::TcpListener::bind(("0.0.0.0", p)).is_ok() {
            return p;
        }
    }
    start
}

fn build_connect_info(state: &LanState) -> ConnectInfo {
    let port = *state.port.lock().unwrap();
    ConnectInfo {
        hosts: local_ipv4_hosts(),
        port,
    }
}

// ---------------- 同步方向决策 ----------------

/// 手机端连上后先发 `hello` 携带自己的数据摘要，电脑端据此决定同步方向：
/// - 两端一致 / 手机端为空：直接把电脑端数据下发给手机（新装 App 首次连接即自动初始化）
/// - 电脑端为空、手机端有数据：索取手机端数据覆盖本机
/// - 两端都有数据且不一致：抛给电脑端前端，由用户选择以哪一端为准
async fn handle_hello(
    app: &AppHandle,
    remote: SyncSummary,
    tx_out: &tokio::sync::mpsc::Sender<String>,
) {
    let local = build_summary(app);
    let side = if local.hash == remote.hash {
        "local"
    } else if local.empty && !remote.empty {
        "remote"
    } else if remote.empty && !local.empty {
        "local"
    } else {
        "ask"
    };
    if side == "ask" {
        let _ = app.emit("lan-sync-conflict", json!({ "local": local, "remote": remote }));
        let _ = tx_out
            .send(json!({ "type": "sync-pending" }).to_string())
            .await;
        return;
    }
    if let Err(e) = resolve_direction(app, side, tx_out).await {
        eprintln!("[lan] 同步失败：{e}");
        let _ = app.emit("lan-sync-status", json!({ "state": "error", "message": e }));
    }
}

/// 按选定方向执行同步：
/// - `local`：把电脑端快照发给手机（手机端覆盖为电脑端数据）
/// - `remote`：向手机索取快照并覆盖本机（手机端回 `push` 后落地）
/// - `skip`：两端都保持原样，本次不同步
pub(crate) async fn resolve_direction(
    app: &AppHandle,
    side: &str,
    tx_out: &tokio::sync::mpsc::Sender<String>,
) -> Result<(), String> {
    match side {
        "remote" => {
            let _ = tx_out
                .send(json!({ "type": "request-snapshot" }).to_string())
                .await;
            Ok(())
        }
        "skip" => {
            let _ = tx_out
                .send(json!({ "type": "sync-skipped" }).to_string())
                .await;
            let _ = app.emit("lan-sync-status", json!({ "state": "skipped" }));
            Ok(())
        }
        _ => {
            let snap = build_snapshot(app)?;
            let _ = tx_out
                .send(json!({ "type": "snapshot", "payload": snap }).to_string())
                .await;
            // 附带电脑端当前监控状态，手机端连上即正确显示
            let st = crate::get_state(app.clone());
            if let Ok(p) = serde_json::to_string(&st) {
                let out = json!({
                    "type": "event",
                    "event": "watcher-state",
                    "payload": p,
                })
                .to_string();
                let _ = tx_out.send(out).await;
            }
            let _ = app.emit("lan-sync-status", json!({ "state": "pushed" }));
            Ok(())
        }
    }
}

// ---------------- setup（由 lib.rs 的 run() 调用） ----------------

/// 在 app setup 阶段：建广播通道，订阅现有事件桥接到广播。
pub fn setup_lan(app: &mut tauri::App) {
    let (tx, _rx) = broadcast::channel::<String>(BROADCAST_CAP);
    let lan = LanState::new();
    *lan.broadcast_tx.lock().unwrap() = Some(tx.clone());
    app.manage(lan);

    for ev in [
        "quest-event",
        "map-changed",
        "session-mode",
        "player-position",
        "data-reloaded",
        // 手机端监控页需显示电脑端的监控状态（watching/error/目录）
        "watcher-state",
        // 手机端需同步：收藏进度变化、档案变化（电脑端手动改任务状态本就走 quest-event）
        "collected-changed",
        "profile-changed",
        // 手动勾选任务目标的进度变化
        "objective-changed",
    ] {
        let tx2 = tx.clone();
        let ev_name = ev.to_string();
        app.listen(ev, move |event| {
            let payload = event.payload().to_string();
            let msg = json!({ "type": "event", "event": ev_name, "payload": payload }).to_string();
            let _ = tx2.send(msg);
        });
    }
}

// ---------------- HTTP handlers ----------------

async fn ws_handler(State(ctx): State<Arc<ServerCtx>>, ws: WebSocketUpgrade) -> Response {
    ws.on_upgrade(move |socket| handle_socket(socket, ctx))
}

async fn snapshot_handler(State(ctx): State<Arc<ServerCtx>>) -> Response {
    match build_snapshot(&ctx.app) {
        Ok(s) => axum::Json(json!({ "type": "snapshot", "payload": s })).into_response(),
        Err(e) => (
            axum::http::StatusCode::INTERNAL_SERVER_ERROR,
            e,
        )
            .into_response(),
    }
}

async fn info_handler(State(ctx): State<Arc<ServerCtx>>) -> axum::Json<ConnectInfo> {
    let lan = ctx.app.state::<LanState>();
    axum::Json(build_connect_info(&lan))
}

async fn handle_socket(socket: WebSocket, ctx: Arc<ServerCtx>) {
    // 单设备：登记本连接并顶掉旧连接（旧连接收到关闭通知后自行退出）
    let (close_tx, mut close_rx) = tokio::sync::mpsc::unbounded_channel::<()>();
    let my_id = {
        let mut a = ctx.active.lock().unwrap();
        if let Some((_, prev)) = a.current.take() {
            let _ = prev.send(());
        }
        let id = a.next_id;
        a.next_id += 1;
        a.current = Some((id, close_tx));
        id
    };
    eprintln!("[lan] 客户端接入（id {my_id}）");
    // 通知前端有设备连上：电脑端「连接」窗口据此自动关闭
    let _ = ctx.app.emit("lan-client-connected", ());
    let mut rx = ctx.tx.subscribe();
    let (mut sender, mut receiver) = socket.split();
    // 手机端 pull 指令的单播回包通道（与广播事件复用同一条 socket 出站）
    let (tx_out, mut rx_out) = tokio::sync::mpsc::channel::<String>(16);
    // 登记出站通道：界面上的冲突决策据此向该手机下发指令
    {
        let lan = ctx.app.state::<LanState>();
        *lan.client_tx.lock().unwrap() = Some((my_id, tx_out.clone()));
    }

    // 出站：广播事件 或 单播回包 -> WebSocket。
    // 广播 Lagged（客户端消费太慢）只跳过缺失事件，不断开连接。
    let send_task = tauri::async_runtime::spawn(async move {
        loop {
            tokio::select! {
                res = rx.recv() => match res {
                    Ok(msg) => {
                        if sender.send(Message::Text(msg)).await.is_err() {
                            break;
                        }
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(n)) => {
                        eprintln!("[lan] 客户端消费落后 {n} 条事件，已跳过");
                    }
                    Err(_) => break,
                },
                Some(out) = rx_out.recv() => {
                    if sender.send(Message::Text(out)).await.is_err() {
                        break;
                    }
                }
            }
        }
    });

    // 入站：手机端指令。90s 无任何消息视为死连接（客户端每 25s 有心跳），
    // 主动断开以回收资源；被新连接顶掉时也会收到关闭通知而退出。
    let app = ctx.app.clone();
    let recv_task = tauri::async_runtime::spawn(async move {
        loop {
            let idle = tokio::time::sleep(std::time::Duration::from_secs(90));
            tokio::pin!(idle);
            let res = tokio::select! {
                _ = &mut idle => {
                    eprintln!("[lan] 客户端 90s 无活动，断开");
                    break;
                }
                _ = close_rx.recv() => {
                    eprintln!("[lan] 被新连接顶掉，断开旧连接");
                    break;
                }
                msg = receiver.next() => msg,
            };
            let Some(Ok(msg)) = res else { break };
            match msg {
                Message::Text(text) => {
                    if let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) {
                        match v.get("type").and_then(|t| t.as_str()) {
                            // 手机端上报自身数据摘要，由本端决定同步方向
                            Some("hello") => {
                                let remote: SyncSummary = serde_json::from_value(
                                    v.get("summary").cloned().unwrap_or(serde_json::Value::Null),
                                )
                                .unwrap_or_default();
                                handle_hello(&app, remote, &tx_out).await;
                            }
                            // 手机端回传自己的全量数据（电脑端选择了「用手机端数据」）
                            Some("push") => {
                                let snap = v
                                    .get("payload")
                                    .and_then(|x| x.as_str())
                                    .unwrap_or("")
                                    .to_string();
                                match apply_snapshot_internal(&app, &snap) {
                                    Ok(()) => {
                                        let _ = app
                                            .emit("lan-sync-status", json!({ "state": "pulled" }));
                                    }
                                    Err(e) => {
                                        eprintln!("[lan] 应用手机端快照失败：{e}");
                                        let _ = app.emit(
                                            "lan-sync-status",
                                            json!({ "state": "error", "message": e }),
                                        );
                                    }
                                }
                            }
                            Some("pull") => {
                                if let Ok(snap) = build_snapshot(&app) {
                                    let out =
                                        json!({ "type": "snapshot", "payload": snap }).to_string();
                                    let _ = tx_out.send(out).await;
                                }
                                // 附带电脑端当前监控状态，手机端连上即正确显示
                                let st = crate::get_state(app.clone());
                                if let Ok(p) = serde_json::to_string(&st) {
                                    let out = json!({
                                        "type": "event",
                                        "event": "watcher-state",
                                        "payload": p,
                                    })
                                    .to_string();
                                    let _ = tx_out.send(out).await;
                                }
                            }
                            Some("refresh") => {
                                let _ = app.emit("lan-request-refresh", ());
                            }
                            // 手机端反向同步：手动改任务状态（电脑端执行后经 quest-event 广播回所有端）
                            Some("set-quest-status") => {
                                let qid = v
                                    .get("questId")
                                    .and_then(|x| x.as_str())
                                    .unwrap_or("")
                                    .to_string();
                                let action = v
                                    .get("action")
                                    .and_then(|x| x.as_str())
                                    .unwrap_or("")
                                    .to_string();
                                if !qid.is_empty() {
                                    if let Err(e) =
                                        crate::set_quest_status(app.clone(), qid, action)
                                    {
                                        eprintln!("[lan] set-quest-status 失败：{e}");
                                    }
                                }
                            }
                            // 手机端反向同步：手动勾选任务目标（执行后经 objective-changed 广播）
                            Some("set-objective-status") => {
                                let qid = v
                                    .get("questId")
                                    .and_then(|x| x.as_str())
                                    .unwrap_or("")
                                    .to_string();
                                let oid = v
                                    .get("objectiveId")
                                    .and_then(|x| x.as_str())
                                    .unwrap_or("")
                                    .to_string();
                                let done = v.get("done").and_then(|x| x.as_bool()).unwrap_or(false);
                                if !qid.is_empty() && !oid.is_empty() {
                                    // 命令本身不会失败（返回更新后的全集）；执行后经 objective-changed 广播
                                    crate::set_objective_status(app.clone(), qid, oid, done);
                                }
                            }
                            // 手机端反向同步：收藏品标记（执行后经 collected-changed 广播）
                            Some("set-item-collected") => {
                                let id = v
                                    .get("itemId")
                                    .and_then(|x| x.as_str())
                                    .unwrap_or("")
                                    .to_string();
                                let collected =
                                    v.get("collected").and_then(|x| x.as_bool()).unwrap_or(false);
                                if !id.is_empty() {
                                    crate::set_item_collected(app.clone(), id, collected);
                                }
                            }
                            // 手机端反向同步：档案（等级/好感）变化
                            Some("set-profile") => {
                                match serde_json::from_value::<crate::PlayerProfile>(
                                    v.get("profile").cloned().unwrap_or(serde_json::Value::Null),
                                ) {
                                    Ok(p) => {
                                        let st = crate::read_settings(&app);
                                        if let Err(e) = crate::save_settings(
                                            app.clone(),
                                            st.log_dir,
                                            st.screenshot_dir,
                                            Some(st.delete_screenshots),
                                            Some(p),
                                            None,
                                        ) {
                                            eprintln!("[lan] set-profile 失败：{e}");
                                        }
                                    }
                                    Err(e) => eprintln!("[lan] set-profile 解析失败：{e}"),
                                }
                            }
                            _ => {}
                        }
                    }
                }
                Message::Close(_) => break,
                _ => {}
            }
        }
    });

    let either = select(send_task, recv_task).await;
    match either {
        Either::Left((_, recv)) => recv.abort(),
        Either::Right((_, send)) => send.abort(),
    }
    // 连接结束：仅当登记的仍是本连接时清除（避免误清后来新连接的登记）
    {
        let mut a = ctx.active.lock().unwrap();
        if a.current.as_ref().map(|(id, _)| *id) == Some(my_id) {
            a.current = None;
        }
    }
    // 清除出站通道登记（仅当登记的仍是本连接，避免误清新连接）
    {
        let lan = ctx.app.state::<LanState>();
        let mut g = lan.client_tx.lock().unwrap();
        if g.as_ref().map(|(id, _)| *id) == Some(my_id) {
            *g = None;
        }
    }
    eprintln!("[lan] 客户端断开，当前连接数 {}", ctx.tx.receiver_count());
    // 通知前端客户端已断开：桌面端顶部「连接」按钮据此回到未连接态。
    // payload = 是否仍有客户端在线（被新连接顶掉时这里为 true，不应回到未连接态）
    let still_connected = ctx.active.lock().unwrap().current.is_some();
    let _ = ctx.app.emit("lan-client-disconnected", still_connected);
}

// ---------------- 路由构建 ----------------

fn build_router(ctx: Arc<ServerCtx>) -> Router {
    Router::new()
        .route("/ws", get(ws_handler))
        .route("/api/snapshot", get(snapshot_handler))
        .route("/api/info", get(info_handler))
        .with_state(ctx)
}

// ---------------- Tauri commands ----------------

/// 启动局域网服务（0.0.0.0:端口；端口被占用则顺序试探）。重复调用幂等。
#[tauri::command]
pub async fn start_lan_sync(app: AppHandle) -> Result<(), String> {
    let lan = app.state::<LanState>();
    {
        let g = lan.server.lock().unwrap();
        if g.is_some() {
            return Ok(());
        }
    }
    let tx = lan
        .broadcast_tx
        .lock()
        .unwrap()
        .clone()
        .ok_or_else(|| "LAN 广播通道未初始化".to_string())?;
    let port = find_free_port(*lan.port.lock().unwrap());
    *lan.port.lock().unwrap() = port;

    let ctx = Arc::new(ServerCtx {
        tx,
        app: app.clone(),
        active: Arc::new(Mutex::new(ActiveConn::default())),
    });
    let router = build_router(ctx);

    let handle = tauri::async_runtime::spawn(async move {
        let addr = SocketAddr::from((Ipv4Addr::UNSPECIFIED, port));
        match tokio::net::TcpListener::bind(addr).await {
            Ok(listener) => {
                let _ = axum::serve(listener, router).await;
            }
            Err(e) => eprintln!("[lan] 绑定端口 {port} 失败：{e}"),
        }
    });
    *lan.server.lock().unwrap() = Some(handle);
    Ok(())
}

/// 停止局域网服务
#[tauri::command]
pub fn stop_lan_sync(app: AppHandle) -> Result<(), String> {
    let lan = app.state::<LanState>();
    if let Some(h) = lan.server.lock().unwrap().take() {
        h.abort();
    }
    // 停止服务即断开全部客户端：通知前端回到未连接态
    let _ = app.emit("lan-client-disconnected", false);
    Ok(())
}

/// 返回服务运行状态、端口与当前连接数
#[tauri::command]
pub fn get_lan_status(app: AppHandle) -> LanStatus {
    let lan = app.state::<LanState>();
    let running = lan.server.lock().unwrap().is_some();
    let port = *lan.port.lock().unwrap();
    let connections = lan
        .broadcast_tx
        .lock()
        .unwrap()
        .as_ref()
        .map(|tx| tx.receiver_count())
        .unwrap_or(0);
    LanStatus {
        running,
        port,
        connections,
    }
}

/// 返回本机可连接 IP + 端口 + token（用于渲染二维码）
#[tauri::command]
pub fn get_connect_info(app: AppHandle) -> ConnectInfo {
    let lan = app.state::<LanState>();
    build_connect_info(&lan)
}

/// 两端数据不一致时，由电脑端用户选定以哪一端为准。
/// side：`local`=用电脑端数据覆盖手机；`remote`=用手机端数据覆盖电脑；`skip`=暂不同步。
#[tauri::command]
pub async fn resolve_lan_conflict(app: AppHandle, side: String) -> Result<(), String> {
    let tx = {
        let lan = app.state::<LanState>();
        let guard = lan.client_tx.lock().unwrap();
        guard.as_ref().map(|(_, t)| t.clone())
    };
    let Some(tx) = tx else {
        return Err("当前没有已连接的设备".to_string());
    };
    resolve_direction(&app, side.as_str(), &tx).await
}
