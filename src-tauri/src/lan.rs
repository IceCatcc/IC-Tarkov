//! 局域网同步：电脑端本地 HTTP/WebSocket 服务（移动端作为 WS 客户端连接）。
//!
//! 路由：
//! - `GET /ws?token=<t>` ：升级 WebSocket，双向通道。实时把后端事件转发给手机端；
//!   手机端可发指令：`{"type":"pull"}` 拉全量快照、`{"type":"refresh"}` 请求刷新。
//! - `GET /api/snapshot` ：返回全量用户数据快照（settings + Persisted，已丢弃 offsets）。
//! - `GET /api/info`     ：返回本机可连接 IP 列表 + 端口 + token，供渲染二维码。
//!
//! 事件桥接在 `lib.rs` 的 `setup` 中通过 `app.listen` 订阅现有 Tauri 事件并 `send` 到
//! 广播通道，watcher/screenshots 零改动。手机端连上后先 `pull` 拿全量，再持续收增量事件。

use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::sync::Arc;
use std::sync::Mutex;

use axum::extract::{Query, State, WebSocketUpgrade};
use axum::extract::ws::{Message, WebSocket};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::Router;
use futures_util::{SinkExt, StreamExt};
use futures_util::future::{select, Either};
use serde::{Deserialize, Serialize};
use serde_json::json;
use tauri::{AppHandle, Emitter, Listener, Manager};
use tokio::sync::broadcast;

use crate::persist::Persisted;
use crate::AppSettings;

const DEFAULT_PORT: u16 = 9527;
const BROADCAST_CAP: usize = 1024;

/// 全局 LAN 服务状态，由 `lib.rs::setup` 中 manage。
pub struct LanState {
    pub token: Mutex<String>,
    pub port: Mutex<u16>,
    pub broadcast_tx: Mutex<Option<broadcast::Sender<String>>>,
    pub server: Mutex<Option<tauri::async_runtime::JoinHandle<()>>>,
}

impl LanState {
    pub fn new(token: String) -> Self {
        Self {
            token: Mutex::new(token),
            port: Mutex::new(DEFAULT_PORT),
            broadcast_tx: Mutex::new(None),
            server: Mutex::new(None),
        }
    }
}

/// 传给 axum handler 的共享上下文
struct ServerCtx {
    token: String,
    tx: broadcast::Sender<String>,
    app: AppHandle,
}

/// `/api/info` 与 `get_connect_info` 返回结构
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ConnectInfo {
    pub hosts: Vec<String>,
    pub port: u16,
    pub token: String,
}

/// `get_lan_status` 返回结构
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LanStatus {
    pub running: bool,
    pub port: u16,
    pub connections: usize,
}

/// 快照结构（settings + Persisted）。导出时 Persisted.offsets 已被清空。
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub settings: AppSettings,
    pub persisted: Persisted,
}

#[derive(Deserialize)]
struct WsQuery {
    token: String,
}

// ---------------- 工具 ----------------

/// 生成 4 位数字配对码（0000-9999）。局域网内使用，短码便于手动输入
fn generate_token() -> String {
    use rand::Rng;
    let n: u32 = rand::thread_rng().gen_range(0..10000);
    format!("{:04}", n)
}

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
    let token = state.token.lock().unwrap().clone();
    let port = *state.port.lock().unwrap();
    ConnectInfo {
        hosts: local_ipv4_hosts(),
        port,
        token,
    }
}

/// 读取当前全量快照（Persisted.offsets 清空），供 /api/snapshot 与手机 pull 指令
fn build_snapshot(app: &AppHandle) -> Result<String, String> {
    let settings = crate::read_settings(app);
    let mut persisted = crate::persist::load(app);
    persisted.offsets.clear();
    let snap = Snapshot { settings, persisted };
    serde_json::to_string(&snap).map_err(|e| e.to_string())
}

// ---------------- setup（由 lib.rs 的 run() 调用） ----------------

/// 在 app setup 阶段：生成 token + 广播通道，订阅现有事件桥接到广播。
pub fn setup_lan(app: &mut tauri::App) {
    let token = generate_token();
    let (tx, _rx) = broadcast::channel::<String>(BROADCAST_CAP);
    let lan = LanState::new(token);
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

async fn ws_handler(
    State(ctx): State<Arc<ServerCtx>>,
    Query(q): Query<WsQuery>,
    ws: WebSocketUpgrade,
) -> Response {
    if q.token != ctx.token {
        return (
            axum::http::StatusCode::UNAUTHORIZED,
            "invalid token",
        )
            .into_response();
    }
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
    let mut rx = ctx.tx.subscribe();
    let (mut sender, mut receiver) = socket.split();
    // 手机端 pull 指令的单播回包通道（与广播事件复用同一条 socket 出站）
    let (tx_out, mut rx_out) = tokio::sync::mpsc::channel::<String>(16);

    // 出站：广播事件 或 单播回包 -> WebSocket
    let send_task = tauri::async_runtime::spawn(async move {
        loop {
            tokio::select! {
                Ok(msg) = rx.recv() => {
                    if sender.send(Message::Text(msg)).await.is_err() {
                        break;
                    }
                }
                Some(out) = rx_out.recv() => {
                    if sender.send(Message::Text(out)).await.is_err() {
                        break;
                    }
                }
            }
        }
    });

    // 入站：手机端指令
    let app = ctx.app.clone();
    let recv_task = tauri::async_runtime::spawn(async move {
        while let Some(Ok(msg)) = receiver.next().await {
            match msg {
                Message::Text(text) => {
                    if let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) {
                        match v.get("type").and_then(|t| t.as_str()) {
                            Some("pull") => {
                                if let Ok(snap) = build_snapshot(&app) {
                                    let out =
                                        json!({ "type": "snapshot", "payload": snap }).to_string();
                                    let _ = tx_out.send(out).await;
                                }
                            }
                            Some("refresh") => {
                                let _ = app.emit("lan-request-refresh", ());
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
    let token = lan.token.lock().unwrap().clone();
    let tx = lan
        .broadcast_tx
        .lock()
        .unwrap()
        .clone()
        .ok_or_else(|| "LAN 广播通道未初始化".to_string())?;
    let port = find_free_port(*lan.port.lock().unwrap());
    *lan.port.lock().unwrap() = port;

    let ctx = Arc::new(ServerCtx {
        token,
        tx,
        app: app.clone(),
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

/// 返回当前全量快照（settings + Persisted 去 offsets）JSON 字符串
#[tauri::command]
pub fn get_snapshot(app: AppHandle) -> Result<String, String> {
    build_snapshot(&app)
}

/// 应用手机端推来的快照（反向同步）：写盘 + 载入内存 + 重启 watcher + 通知前端刷新。
/// 跨设备导入一律丢弃 offsets，由新设备重扫本地日志重建；导入前不自动备份（由前端/调用方决定）。
#[tauri::command]
pub async fn apply_snapshot(app: AppHandle, json: String) -> Result<(), String> {
    let parsed: Snapshot =
        serde_json::from_str(&json).map_err(|e| format!("快照格式错误：{e}"))?;
    // 写 settings.json
    crate::write_settings(&app, &parsed.settings)?;
    // 写 quest_state.json（丢弃 offsets，由新设备重扫日志重建）
    let mut persisted = parsed.persisted;
    persisted.offsets.clear();
    let p = crate::persist::state_path(&app).ok_or_else(|| "无法确定数据目录".to_string())?;
    if let Some(parent) = p.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let content = serde_json::to_string(&persisted).map_err(|e| e.to_string())?;
    std::fs::write(&p, &content).map_err(|e| e.to_string())?;
    crate::persist::save_collected(&app, &persisted.collected);
    // 载入内存 + 重启 watcher
    crate::apply_persisted(&app, &persisted);
    let _ = app.emit("lan-sync-updated", ());
    Ok(())
}
