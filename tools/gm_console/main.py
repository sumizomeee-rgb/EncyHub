"""
GM Console - FastAPI 入口
"""
import os
import asyncio
import time
from contextlib import asynccontextmanager
from typing import Optional, Any

from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect, Request
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
import uvicorn

from .server_mgr import ServerMgr
from .custom_gm import CustomGmManager
from .proto_parser import ProtoParser, validate_haruroot, generate_lua_code, parse_log_file
from .runtime_gm_code import build_runtime_gm_code, detect_local_lan_ip

# 环境变量
PORT = int(os.environ.get("PORT", 8000))
HOST = os.environ.get("HOST", "0.0.0.0")
DATA_DIR = os.environ.get("DATA_DIR", os.path.join(os.path.dirname(__file__), "../../data/gm_console"))

# 默认 TCP 监听端口
DEFAULT_TCP_PORT = 12581

# 全局实例
server_mgr: Optional[ServerMgr] = None
custom_gm_mgr: Optional[CustomGmManager] = None
proto_parser: Optional[ProtoParser] = None

# WebSocket 连接池
ws_connections: list[dict[str, Any]] = []
pending_screenshot_sessions: dict[str, list[dict[str, Any]]] = {}
SCREENSHOT_REQUEST_TTL = 30.0
game_log_ws_connections: dict[str, list[WebSocket]] = {}
game_log_cache: dict[str, dict[str, Any]] = {}
game_log_stop_tasks: dict[str, asyncio.Task] = {}
GAME_LOG_BOOTSTRAP_BYTES = 0
GAME_LOG_BOOTSTRAP_MAX_ENTRIES = 2000
GAME_LOG_CACHE_MAX_ENTRIES = 5000
GAME_LOG_CACHE_MAX_BYTES = 5 * 1024 * 1024
GAME_LOG_POLL_INTERVAL_MS = 300
GAME_LOG_READ_CHUNK_BYTES = 64 * 1024
GAME_LOG_STOP_DELAY = 30.0


def _prune_screenshot_sessions(client_id: str):
    now = time.monotonic()
    queue = pending_screenshot_sessions.get(client_id, [])
    queue = [item for item in queue if now - item["created_at"] <= SCREENSHOT_REQUEST_TTL]
    if queue:
        pending_screenshot_sessions[client_id] = queue
    else:
        pending_screenshot_sessions.pop(client_id, None)


def _remember_screenshot_session(client_id: str, session_id: Optional[str]):
    if not session_id:
        return
    _prune_screenshot_sessions(client_id)
    pending_screenshot_sessions.setdefault(client_id, []).append({
        "session_id": session_id,
        "created_at": time.monotonic(),
    })


def _pop_screenshot_session(client_id: str) -> Optional[str]:
    _prune_screenshot_sessions(client_id)
    queue = pending_screenshot_sessions.get(client_id)
    if not queue:
        return None
    item = queue.pop(0)
    if not queue:
        pending_screenshot_sessions.pop(client_id, None)
    return item.get("session_id")


async def broadcast_event(event: dict, target_session_id: Optional[str] = None):
    """广播事件到所有 WebSocket 连接"""
    if not ws_connections:
        print(f"[GmConsole] 广播跳过: 无 WS 连接 (event.type={event.get('type')})")
        return
    target_info = f", target_session={target_session_id}" if target_session_id else ""
    print(f"[GmConsole] 广播事件: type={event.get('type')}, ws连接数={len(ws_connections)}, clients={len(event.get('clients', []))}{target_info}")
    sent = 0
    for entry in ws_connections[:]:
        if target_session_id and entry.get("session_id") != target_session_id:
            continue
        ws = entry["ws"]
        try:
            await ws.send_json(event)
            sent += 1
        except Exception as e:
            print(f"[GmConsole] WS 广播失败, 移除连接: {e}")
            if entry in ws_connections:
                ws_connections.remove(entry)
    print(f"[GmConsole] 广播完成: type={event.get('type')}, 成功={sent}")


def _estimate_game_log_entry_size(entry: dict) -> int:
    text = entry.get("text", "") if isinstance(entry, dict) else ""
    return len(str(text).encode("utf-8", errors="ignore")) + 128


def _get_game_log_state(client_id: str) -> dict[str, Any]:
    if client_id not in game_log_cache:
        game_log_cache[client_id] = {
            "entries": [],
            "meta": {},
            "status": {},
            "bytes": 0,
            "droppedCount": 0,
            "lastSeq": 0,
        }
    return game_log_cache[client_id]


def _trim_game_log_state(state: dict[str, Any]):
    entries = state.get("entries", [])
    while entries and (
        len(entries) > GAME_LOG_CACHE_MAX_ENTRIES
        or state.get("bytes", 0) > GAME_LOG_CACHE_MAX_BYTES
    ):
        removed = entries.pop(0)
        state["bytes"] = max(0, state.get("bytes", 0) - _estimate_game_log_entry_size(removed))
        state["droppedCount"] = state.get("droppedCount", 0) + 1


def _normalize_game_log_entry(entry: Any) -> dict[str, Any]:
    if not isinstance(entry, dict):
        return {"text": str(entry), "level": "info"}
    text = str(entry.get("text", ""))
    return {
        "seq": entry.get("seq"),
        "level": str(entry.get("level", "info") or "info"),
        "time": str(entry.get("time", "") or ""),
        "header": str(entry.get("header", "") or ""),
        "text": text,
        "fileOffset": entry.get("fileOffset"),
    }


def _cache_game_log_entries(client_id: str, raw_entries: Any) -> list[dict[str, Any]]:
    if not isinstance(raw_entries, list):
        return []
    state = _get_game_log_state(client_id)
    # 按 Lua 端单调递增的 seq 去重：seq 在进程内唯一且永不重置，能正确处理
    # 重连/重复推送，又不会把内容相同的多条真实日志（如多次 print(1)）误判为重复。
    last_seq = state.get("lastSeq", 0)
    max_seq = last_seq
    normalized = []
    for entry in raw_entries:
        normalized_entry = _normalize_game_log_entry(entry)
        seq = normalized_entry.get("seq")
        if isinstance(seq, int):
            if seq <= last_seq:
                continue
            if seq > max_seq:
                max_seq = seq
        normalized.append(normalized_entry)
    state["lastSeq"] = max_seq
    for entry in normalized:
        state["entries"].append(entry)
        state["bytes"] = state.get("bytes", 0) + _estimate_game_log_entry_size(entry)
    _trim_game_log_state(state)
    return normalized


async def broadcast_game_log_event(client_id: str, event: dict[str, Any]):
    conns = game_log_ws_connections.get(client_id, [])
    if not conns:
        return
    payload = {**event, "client_id": client_id}
    dead = []
    for ws in conns:
        try:
            await ws.send_json(payload)
        except Exception:
            dead.append(ws)
    for ws in dead:
        if ws in conns:
            conns.remove(ws)
    if not conns:
        game_log_ws_connections.pop(client_id, None)


def _schedule_game_log_stop(client_id: str):
    existing = game_log_stop_tasks.get(client_id)
    if existing and not existing.done():
        existing.cancel()

    async def delayed_stop():
        try:
            await asyncio.sleep(GAME_LOG_STOP_DELAY)
            if game_log_ws_connections.get(client_id):
                return
            if server_mgr:
                await server_mgr.send_game_log_request(client_id, "stop", {})
        except asyncio.CancelledError:
            pass
        finally:
            if game_log_stop_tasks.get(client_id) is task:
                game_log_stop_tasks.pop(client_id, None)

    task = asyncio.create_task(delayed_stop())
    game_log_stop_tasks[client_id] = task


@asynccontextmanager
async def lifespan(app: FastAPI):
    """应用生命周期"""
    global server_mgr, custom_gm_mgr, proto_parser

    # 初始化
    os.makedirs(DATA_DIR, exist_ok=True)
    server_mgr = ServerMgr()
    custom_gm_mgr = CustomGmManager(DATA_DIR)
    proto_parser = ProtoParser(DATA_DIR)

    # 加载 HaruRoot 配置和缓存
    config = proto_parser.load_config()
    if config.get("haruroot"):
        proto_parser.haruroot = config["haruroot"]
        proto_parser.load_cache()

    # 设置回调
    def on_update():
        asyncio.create_task(broadcast_event({
            "type": "update",
            "listeners": server_mgr.get_listeners_info(),
            "clients": server_mgr.get_clients_info(),
            "clientStateRev": server_mgr.client_state_rev,
        }))

    def on_log(log):
        asyncio.create_task(broadcast_event({
            "type": "log",
            "log": log.to_dict(),
        }))

    server_mgr.on_update = on_update
    server_mgr.on_log = on_log

    async def on_disconnect(client_id: str):
        """客户端断开时直接 await 广播，确保前端卡片立即消失（不依赖 create_task 调度）"""
        await broadcast_event({
            "type": "update",
            "listeners": server_mgr.get_listeners_info(),
            "clients": server_mgr.get_clients_info(),
            "clientStateRev": server_mgr.client_state_rev,
        })

    server_mgr.on_disconnect = on_disconnect

    def on_client_data_update(client_id):
        asyncio.create_task(broadcast_event({
            "type": "update",
            "listeners": server_mgr.get_listeners_info(),
            "clients": server_mgr.get_clients_info(),
            "clientStateRev": server_mgr.client_state_rev,
        }))

    server_mgr.on_client_data_update = on_client_data_update

    def on_animator_data(client_id, pkt):
        asyncio.create_task(broadcast_animator_event({
            "type": "animator_data",
            "client_id": client_id,
            "snapshot": pkt.get("snapshot"),
            "stateChanges": pkt.get("stateChanges")
        }))

    def on_animator_list(client_id, animators):
        asyncio.create_task(broadcast_animator_event({
            "type": "animator_list",
            "client_id": client_id,
            "animators": animators
        }))

    def on_animator_removed(client_id, animator_id):
        asyncio.create_task(broadcast_animator_event({
            "type": "animator_removed",
            "client_id": client_id,
            "animatorId": animator_id
        }))

    server_mgr.on_animator_data = on_animator_data
    server_mgr.on_animator_list = on_animator_list
    server_mgr.on_animator_removed = on_animator_removed

    def on_inspector_data(client_id, pkt):
        asyncio.create_task(broadcast_inspector_event({
            "type": pkt.get("action", "unknown"),
            "client_id": client_id,
            "data": pkt.get("data", {})
        }))

    server_mgr.on_inspector_data = on_inspector_data

    def on_timeline_data(client_id, pkt):
        asyncio.create_task(broadcast_timeline_event({
            "type": pkt.get("action", "unknown"),
            "client_id": client_id,
            "data": pkt.get("data", {})
        }))

    server_mgr.on_timeline_data = on_timeline_data

    def on_hierarchy_data(client_id, pkt):
        asyncio.create_task(broadcast_hierarchy_event({
            "type": pkt.get("action", "unknown"),
            "client_id": client_id,
            "data": pkt.get("data", {})
        }))

    server_mgr.on_hierarchy_data = on_hierarchy_data

    def on_subpkg_monitor_data(client_id, pkt):
        asyncio.create_task(broadcast_subpkg_monitor_event({
            "type": pkt.get("action", "unknown"),
            "client_id": client_id,
            "data": pkt.get("data", {})
        }))

    server_mgr.on_subpkg_monitor_data = on_subpkg_monitor_data

    def on_player_prefs_data(client_id, pkt):
        data = pkt.get("data", {})
        if pkt.get("error"):
            data = {**data, "error": pkt.get("error")}
        asyncio.create_task(broadcast_player_prefs_event({
            "type": pkt.get("action", "unknown"),
            "client_id": client_id,
            "data": data,
        }))

    server_mgr.on_player_prefs_data = on_player_prefs_data

    def on_av_monitor_data(client_id, pkt):
        data = pkt.get("data", {})
        if pkt.get("error"):
            data = {**data, "error": pkt.get("error")}
        asyncio.create_task(broadcast_av_monitor_event({
            "type": pkt.get("action", "unknown"),
            "client_id": client_id,
            "data": data,
        }))

    server_mgr.on_av_monitor_data = on_av_monitor_data

    def on_proto_call_resp(client_id, pkt):
        asyncio.create_task(broadcast_proto_call_event({
            "type": "PROTO_CALL_RESP",
            "client_id": client_id,
            "reqId": pkt.get("reqId", ""),
            "protocol": pkt.get("protocol", ""),
            "code": pkt.get("code"),
            "data": pkt.get("data", {}),
        }))

    server_mgr.on_proto_call_resp = on_proto_call_resp

    # --- Table Monitor ---
    def on_table_monitor_data(client_id, pkt):
        data = pkt.get("data", {})
        if pkt.get("error"):
            data = {**data, "error": pkt.get("error")}
        asyncio.create_task(broadcast_table_monitor_event({
            "type": pkt.get("action", "unknown"),
            "client_id": client_id,
            "data": data,
            "error": pkt.get("error"),
        }))

    server_mgr.on_table_monitor_data = on_table_monitor_data

    # --- Game Log Tail ---
    def on_game_log_meta(client_id, pkt):
        meta = {
            key: value
            for key, value in pkt.items()
            if key not in {"type", "entries"}
        }
        state = _get_game_log_state(client_id)
        state["meta"] = meta
        asyncio.create_task(broadcast_game_log_event(client_id, {
            "type": "meta",
            "meta": meta,
        }))

    def on_game_log_status(client_id, pkt):
        status = {
            key: value
            for key, value in pkt.items()
            if key != "type"
        }
        state = _get_game_log_state(client_id)
        state["status"] = status
        asyncio.create_task(broadcast_game_log_event(client_id, {
            "type": "status",
            "status": status,
        }))

    def on_game_log_entries(client_id, pkt):
        entries = _cache_game_log_entries(client_id, pkt.get("entries", []))
        if not entries:
            return
        state = _get_game_log_state(client_id)
        asyncio.create_task(broadcast_game_log_event(client_id, {
            "type": "entries",
            "entries": entries,
            "droppedCount": state.get("droppedCount", 0),
        }))

    server_mgr.on_game_log_meta = on_game_log_meta
    server_mgr.on_game_log_status = on_game_log_status
    server_mgr.on_game_log_entries = on_game_log_entries

    # --- Screenshot ---
    def on_screenshot(client_id, pkt):
        target_session_id = _pop_screenshot_session(client_id)
        asyncio.create_task(broadcast_event({
            "type": "screenshot",
            "client_id": client_id,
            "image": pkt.get("image", ""),
            "width": pkt.get("width", 0),
            "height": pkt.get("height", 0),
        }, target_session_id=target_session_id))

    server_mgr.on_screenshot = on_screenshot

    # 启动默认监听
    success, msg = await server_mgr.add_listener(DEFAULT_TCP_PORT)
    if success:
        print(f"[GmConsole] TCP 监听启动: {DEFAULT_TCP_PORT}")
    else:
        print(f"[GmConsole] TCP 监听失败: {msg}")

    print(f"[GmConsole] HTTP 服务启动: {HOST}:{PORT}")

    yield

    # 关闭
    await server_mgr.shutdown()
    print("[GmConsole] 已关闭")


app = FastAPI(title="GM Console", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ============================================================================
# API Models
# ============================================================================

class ExecRequest(BaseModel):
    cmd: str


class ExecWaitRequest(BaseModel):
    cmd: str
    timeout: float = 10.0


class ExecGmRequest(BaseModel):
    gm_id: Any
    value: Any = None


class CustomGmRequest(BaseModel):
    name: str
    cmd: str


# ============================================================================
# RuntimeGM Code API
# ============================================================================

@app.get("/runtime-gm-code")
async def get_runtime_gm_code(port: int = DEFAULT_TCP_PORT):
    """获取可直接粘贴到客户端入口文件的 RuntimeGM Lua 代码。"""
    try:
        host = detect_local_lan_ip()
        code = build_runtime_gm_code(host, port)
    except ValueError as e:
        raise HTTPException(400, str(e))
    except FileNotFoundError:
        raise HTTPException(500, "RuntimeGM Lua 源文件不存在")
    return {
        "code": code,
        "host": host,
        "port": port,
    }


# ============================================================================
# Clients API
# ============================================================================

@app.get("/clients")
async def get_clients():
    """获取已连接客户端"""
    return {
        "clients": server_mgr.get_clients_info(),
        "clientStateRev": server_mgr.client_state_rev,
    }


@app.post("/clients/{client_id}/exec")
async def exec_lua(client_id: str, req: ExecRequest):
    """执行 Lua 命令"""
    success, msg = await server_mgr.send_to_client(client_id, req.cmd)
    if not success:
        raise HTTPException(400, msg)
    return {"message": msg}


@app.post("/clients/{client_id}/exec-wait")
async def exec_lua_wait(client_id: str, req: ExecWaitRequest):
    """执行 Lua 命令并等待结果返回"""
    timeout = min(max(req.timeout, 1.0), 60.0)
    success, logs, error = await server_mgr.exec_wait(client_id, req.cmd, timeout)
    return {"success": success, "logs": logs, "error": error}


@app.post("/clients/{client_id}/exec-gm")
async def exec_gm(client_id: str, req: ExecGmRequest):
    """执行 GM 指令"""
    # 调试：打印接收到的参数
    val_type = type(req.value).__name__
    gm_id_type = type(req.gm_id).__name__
    val_repr = repr(req.value) if req.value is not None else "None"
    print(f"[GmConsole API] exec_gm 接收: client_id={client_id}, gm_id={req.gm_id} (type={gm_id_type}), value={val_repr} (type={val_type})")
    success, msg = await server_mgr.send_gm_to_client(client_id, req.gm_id, req.value)
    if not success:
        raise HTTPException(400, msg)
    return {"message": msg}


# ============================================================================
# Broadcast API
# ============================================================================

@app.post("/broadcast")
async def broadcast(req: ExecRequest):
    """广播命令到所有客户端"""
    await server_mgr.broadcast(req.cmd)
    return {"message": "已广播"}


@app.post("/broadcast-gm")
async def broadcast_gm(req: ExecGmRequest):
    """广播 GM 指令到所有客户端"""
    # 调试：打印接收到的参数
    val_type = type(req.value).__name__
    gm_id_type = type(req.gm_id).__name__
    val_repr = repr(req.value) if req.value is not None else "None"
    print(f"[GmConsole API] broadcast_gm 接收: gm_id={req.gm_id} (type={gm_id_type}), value={val_repr} (type={val_type})")
    await server_mgr.broadcast_gm(req.gm_id, req.value)
    return {"message": "已广播 GM 指令"}


@app.post("/clients/{client_id}/screenshot")
async def request_screenshot(client_id: str, session_id: Optional[str] = None):
    """请求客户端截图"""
    _remember_screenshot_session(client_id, session_id)
    await server_mgr.send_screenshot_request(client_id)
    return {"message": "已请求截图"}


# ============================================================================
# Logs API
# ============================================================================

@app.get("/logs")
async def get_logs(limit: int = 100):
    """获取日志"""
    return {"logs": server_mgr.get_logs(limit)}


# ============================================================================
# Custom GM API
# ============================================================================

@app.get("/custom-gm")
async def get_custom_gm():
    """获取自定义命令列表"""
    return {"commands": custom_gm_mgr.get_all()}


@app.post("/custom-gm")
async def add_custom_gm(req: CustomGmRequest):
    """添加自定义命令"""
    item = custom_gm_mgr.add(req.name, req.cmd)
    return {"message": "已添加", "item": item}


@app.put("/custom-gm/{index}")
async def edit_custom_gm(index: int, req: CustomGmRequest):
    """编辑自定义命令"""
    if not custom_gm_mgr.edit(index, req.name, req.cmd):
        raise HTTPException(404, "命令不存在")
    return {"message": "已更新"}


@app.post("/custom-gm/reorder")
async def reorder_custom_gm(req: Request):
    """整体重排自定义命令。Body: { "commands": [{name, cmd}, ...] }
    长度必须等于当前列表，且每项需含 name/cmd，否则 400 拒绝避免误清空。"""
    body = await req.json()
    commands = body.get("commands")
    if not custom_gm_mgr.reorder(commands):
        raise HTTPException(400, "重排失败：长度不一致或字段缺失")
    return {"message": "已重排"}


@app.delete("/custom-gm/{index}")
async def delete_custom_gm(index: int):
    """删除自定义命令"""
    if not custom_gm_mgr.delete(index):
        raise HTTPException(404, "命令不存在")
    return {"message": "已删除"}


# === Animator Viewer API ===

animator_ws_connections: list = []

async def broadcast_animator_event(data: dict):
    dead = []
    for ws in animator_ws_connections:
        try:
            await ws.send_json(data)
        except Exception:
            dead.append(ws)
    for ws in dead:
        animator_ws_connections.remove(ws)

@app.get("/animators/{client_id}")
async def get_animators(client_id: str):
    await server_mgr.send_anim_list_request(client_id)
    await asyncio.sleep(0.3)
    animators = server_mgr.get_cached_animator_list(client_id)
    return {"animators": animators}

@app.post("/animators/{client_id}/subscribe/{animator_id}")
async def subscribe_animator(client_id: str, animator_id: int):
    await server_mgr.send_anim_subscribe(client_id, animator_id)
    return {"status": "subscribed", "animatorId": animator_id}

@app.post("/animators/{client_id}/unsubscribe")
async def unsubscribe_animator(client_id: str):
    await server_mgr.send_anim_unsubscribe(client_id)
    return {"status": "unsubscribed"}

@app.post("/animators/{client_id}/set-param/{animator_id}")
async def set_animator_param(client_id: str, animator_id: int, request: Request):
    body = await request.json()
    await server_mgr.send_anim_set_param(
        client_id, animator_id,
        body.get("paramName", ""),
        body.get("paramType", ""),
        body.get("floatValue", 0),
        body.get("intValue", 0),
        body.get("boolValue", False)
    )
    return {"status": "sent"}

@app.websocket("/ws/animator")
async def websocket_animator(websocket: WebSocket):
    await websocket.accept()
    animator_ws_connections.append(websocket)
    try:
        while True:
            data = await websocket.receive_text()
            if data == "ping":
                await websocket.send_text("pong")
    except WebSocketDisconnect:
        pass
    finally:
        if websocket in animator_ws_connections:
            animator_ws_connections.remove(websocket)


# === Lua UI Inspector API ===

inspector_ws_connections: list = []

async def broadcast_inspector_event(data: dict):
    dead = []
    for ws in inspector_ws_connections:
        try:
            await ws.send_json(data)
        except Exception:
            dead.append(ws)
    for ws in dead:
        inspector_ws_connections.remove(ws)

@app.post("/inspector/{client_id}/command")
async def inspector_command(client_id: str, request: Request):
    body = await request.json()
    action = body.pop("action", "")
    if not action:
        raise HTTPException(400, "Missing action")
    await server_mgr.send_inspector_request(client_id, action, body)
    return {"status": "requested"}

# === Hierarchy API ===

hierarchy_ws_connections: list = []

async def broadcast_hierarchy_event(data: dict):
    dead = []
    for ws in hierarchy_ws_connections:
        try:
            await ws.send_json(data)
        except Exception:
            dead.append(ws)
    for ws in dead:
        hierarchy_ws_connections.remove(ws)

@app.post("/hierarchy/{client_id}/command")
async def hierarchy_command(client_id: str, request: Request):
    body = await request.json()
    action = body.pop("action", "")
    if not action:
        raise HTTPException(400, "Missing action")
    await server_mgr.send_hierarchy_request(client_id, action, body)
    return {"status": "requested"}

@app.websocket("/ws/hierarchy")
async def websocket_hierarchy(websocket: WebSocket):
    await websocket.accept()
    hierarchy_ws_connections.append(websocket)
    try:
        while True:
            data = await websocket.receive_text()
            if data == "ping":
                await websocket.send_text("pong")
    except WebSocketDisconnect:
        pass
    finally:
        if websocket in hierarchy_ws_connections:
            hierarchy_ws_connections.remove(websocket)

# 兼容旧 URL：前端已迁到 /hierarchy，保留这里避免外部书签或旧调试脚本瞬断。
@app.post("/cs_monitor/{client_id}/command")
async def legacy_cs_monitor_command(client_id: str, request: Request):
    return await hierarchy_command(client_id, request)

@app.websocket("/ws/cs_monitor")
async def legacy_websocket_cs_monitor(websocket: WebSocket):
    await websocket_hierarchy(websocket)


# === Timeline Monitor API ===

timeline_ws_connections: list = []

async def broadcast_timeline_event(data: dict):
    dead = []
    for ws in timeline_ws_connections:
        try:
            await ws.send_json(data)
        except Exception:
            dead.append(ws)
    for ws in dead:
        timeline_ws_connections.remove(ws)

@app.post("/timeline/{client_id}/command")
async def timeline_command(client_id: str, request: Request):
    body = await request.json()
    action = body.pop("action", "")
    if not action:
        raise HTTPException(400, "Missing action")
    await server_mgr.send_timeline_request(client_id, action, body)
    return {"status": "requested"}

@app.websocket("/ws/timeline")
async def websocket_timeline(websocket: WebSocket):
    await websocket.accept()
    timeline_ws_connections.append(websocket)
    try:
        while True:
            data = await websocket.receive_text()
            if data == "ping":
                await websocket.send_text("pong")
    except WebSocketDisconnect:
        pass
    finally:
        if websocket in timeline_ws_connections:
            timeline_ws_connections.remove(websocket)


@app.websocket("/ws/inspector")
async def websocket_inspector(websocket: WebSocket):
    await websocket.accept()
    inspector_ws_connections.append(websocket)
    try:
        while True:
            data = await websocket.receive_text()
            if data == "ping":
                await websocket.send_text("pong")
    except WebSocketDisconnect:
        pass
    finally:
        if websocket in inspector_ws_connections:
            inspector_ws_connections.remove(websocket)


# === SubPackage Monitor API ===

subpkg_monitor_ws_connections: list = []

async def broadcast_subpkg_monitor_event(data: dict):
    dead = []
    for ws in subpkg_monitor_ws_connections:
        try:
            await ws.send_json(data)
        except Exception:
            dead.append(ws)
    for ws in dead:
        subpkg_monitor_ws_connections.remove(ws)

@app.post("/subpkg_monitor/{client_id}/command")
async def subpkg_monitor_command(client_id: str, request: Request):
    body = await request.json()
    action = body.pop("action", "")
    if not action:
        raise HTTPException(400, "Missing action")
    await server_mgr.send_subpkg_monitor_request(client_id, action, body)
    return {"status": "requested"}

# === PlayerPrefs Viewer API ===

player_prefs_ws_connections: list = []

async def broadcast_player_prefs_event(data: dict):
    dead = []
    for ws in player_prefs_ws_connections:
        try:
            await ws.send_json(data)
        except Exception:
            dead.append(ws)
    for ws in dead:
        player_prefs_ws_connections.remove(ws)

@app.post("/player_prefs/{client_id}/command")
async def player_prefs_command(client_id: str, request: Request):
    body = await request.json()
    action = body.pop("action", "")
    if not action:
        raise HTTPException(400, "Missing action")
    await server_mgr.send_player_prefs_request(client_id, action, body)
    return {"status": "requested"}

@app.websocket("/ws/player_prefs")
async def websocket_player_prefs(websocket: WebSocket):
    await websocket.accept()
    player_prefs_ws_connections.append(websocket)
    try:
        while True:
            data = await websocket.receive_text()
            if data == "ping":
                await websocket.send_text("pong")
    except WebSocketDisconnect:
        pass
    finally:
        if websocket in player_prefs_ws_connections:
            player_prefs_ws_connections.remove(websocket)


# === AV Monitor API ===

av_monitor_ws_connections: list = []

async def broadcast_av_monitor_event(data: dict):
    dead = []
    for ws in av_monitor_ws_connections:
        try:
            await ws.send_json(data)
        except Exception:
            dead.append(ws)
    for ws in dead:
        av_monitor_ws_connections.remove(ws)

@app.post("/av_monitor/{client_id}/command")
async def av_monitor_command(client_id: str, request: Request):
    body = await request.json()
    action = body.pop("action", "")
    if not action:
        raise HTTPException(400, "Missing action")
    await server_mgr.send_av_monitor_request(client_id, action, body)
    return {"status": "requested"}

@app.websocket("/ws/av_monitor")
async def websocket_av_monitor(websocket: WebSocket):
    await websocket.accept()
    av_monitor_ws_connections.append(websocket)
    try:
        while True:
            data = await websocket.receive_text()
            if data == "ping":
                await websocket.send_text("pong")
    except WebSocketDisconnect:
        pass
    finally:
        if websocket in av_monitor_ws_connections:
            av_monitor_ws_connections.remove(websocket)


# === Table Monitor API ===

table_monitor_ws_connections: list = []

async def broadcast_table_monitor_event(data: dict):
    dead = []
    for ws in table_monitor_ws_connections:
        try:
            await ws.send_json(data)
        except Exception:
            dead.append(ws)
    for ws in dead:
        table_monitor_ws_connections.remove(ws)

@app.post("/table_monitor/{client_id}/command")
async def table_monitor_command(client_id: str, request: Request):
    body = await request.json()
    action = body.pop("action", "")
    if not action:
        raise HTTPException(400, "Missing action")
    await server_mgr.send_table_monitor_request(client_id, action, body)
    return {"status": "requested"}

@app.websocket("/ws/table_monitor")
async def websocket_table_monitor(websocket: WebSocket):
    await websocket.accept()
    table_monitor_ws_connections.append(websocket)
    try:
        while True:
            data = await websocket.receive_text()
            if data == "ping":
                await websocket.send_text("pong")
    except WebSocketDisconnect:
        pass
    finally:
        if websocket in table_monitor_ws_connections:
            table_monitor_ws_connections.remove(websocket)


# === Proto Requester API ===

proto_call_ws_connections: list = []

async def broadcast_proto_call_event(data: dict):
    dead = []
    for ws in proto_call_ws_connections:
        try:
            await ws.send_json(data)
        except Exception:
            dead.append(ws)
    for ws in dead:
        proto_call_ws_connections.remove(ws)


class ProtoConfigRequest(BaseModel):
    haruroot: str


class ProtoCallRequest(BaseModel):
    client_id: str
    protocol: str
    params: dict = {}
    markTableFields: list = []
    nilFields: list = []


@app.get("/proto/config")
async def get_proto_config():
    """获取 HaruRoot 配置"""
    config = proto_parser.load_config()
    haruroot = config.get("haruroot", "")
    return {
        "haruroot": haruroot,
        "valid": validate_haruroot(haruroot)[0] if haruroot else False,
        "protocolCount": proto_parser.protocol_count,
        "parseTime": proto_parser.parse_time,
    }


@app.post("/proto/config")
async def set_proto_config(req: ProtoConfigRequest):
    """设置 HaruRoot 路径（空字符串清除配置）"""
    if not req.haruroot:
        # 清除配置
        proto_parser.save_config("")
        proto_parser.protocols = {}
        proto_parser.types = {}
        proto_parser.protocol_count = 0
        return {"message": "已清除", "valid": False, "haruroot": ""}
    valid, msg = validate_haruroot(req.haruroot)
    if not valid:
        raise HTTPException(400, f"无效的 HaruRoot: {msg}")
    proto_parser.save_config(req.haruroot)
    return {"message": "已保存", "valid": True, "haruroot": req.haruroot}


@app.post("/proto/parse")
async def parse_protocols():
    """触发协议解析"""
    if not proto_parser.haruroot:
        raise HTTPException(400, "请先配置 HaruRoot 路径")
    valid, msg = validate_haruroot(proto_parser.haruroot)
    if not valid:
        raise HTTPException(400, f"HaruRoot 无效: {msg}")
    result = proto_parser.parse(proto_parser.haruroot)
    return {"message": "解析完成", **result}


@app.get("/proto/search")
async def search_protocols(q: str = "", limit: int = 50):
    """搜索协议"""
    if not proto_parser.protocols:
        raise HTTPException(400, "请先解析协议")
    results = proto_parser.search(q, limit)
    return {"results": results, "total": len(proto_parser.protocols)}


@app.get("/proto/detail")
async def get_proto_detail(name: str):
    """获取协议详情"""
    detail = proto_parser.get_detail(name)
    if not detail:
        raise HTTPException(404, f"协议 {name} 不存在")
    return detail


@app.post("/proto/call")
async def proto_call(req: ProtoCallRequest):
    """发送协议请求"""
    if not server_mgr:
        raise HTTPException(500, "服务未初始化")

    lua_code, req_id = generate_lua_code(req.protocol, req.params, req.markTableFields, req.nilFields)

    success, msg = await server_mgr.send_to_client(req.client_id, lua_code)
    if not success:
        raise HTTPException(400, msg)

    return {"message": "已发送", "protocol": req.protocol, "reqId": req_id}


@app.post("/proto/import-log")
async def import_log(request: Request):
    """从日志文件导入预设"""
    # 检查是否有上传文件
    content_type = request.headers.get("content-type", "")
    if "multipart/form-data" not in content_type:
        raise HTTPException(400, "请使用 multipart/form-data 上传文件")

    form = await request.form()
    file = form.get("file")
    if not file:
        raise HTTPException(400, "未找到上传文件")

    # 读取文件内容到临时文件
    import tempfile
    content = await file.read()
    filename = file.filename or "unknown.log"

    if len(content) > 50 * 1024 * 1024:
        raise HTTPException(400, "文件过大，限制 50MB")

    with tempfile.NamedTemporaryFile(mode='wb', suffix=os.path.splitext(filename)[1], delete=False) as tmp:
        tmp.write(content)
        tmp_path = tmp.name

    try:
        known_protocols = proto_parser.get_all_request_names() if proto_parser.protocols else None
        result = parse_log_file(tmp_path, known_protocols)
        result["fileName"] = os.path.splitext(filename)[0]
        return result
    finally:
        try:
            os.unlink(tmp_path)
        except:
            pass


@app.websocket("/ws/proto_call")
async def websocket_proto_call(websocket: WebSocket):
    await websocket.accept()
    proto_call_ws_connections.append(websocket)
    try:
        while True:
            data = await websocket.receive_text()
            if data == "ping":
                await websocket.send_text("pong")
    except WebSocketDisconnect:
        pass
    finally:
        if websocket in proto_call_ws_connections:
            proto_call_ws_connections.remove(websocket)


@app.websocket("/ws/subpkg_monitor")
async def websocket_subpkg_monitor(websocket: WebSocket):
    await websocket.accept()
    subpkg_monitor_ws_connections.append(websocket)
    try:
        while True:
            data = await websocket.receive_text()
            if data == "ping":
                await websocket.send_text("pong")
    except WebSocketDisconnect:
        pass
    finally:
        if websocket in subpkg_monitor_ws_connections:
            subpkg_monitor_ws_connections.remove(websocket)


# ============================================================================
# WebSocket
# ============================================================================

@app.websocket("/ws/game-log")
async def websocket_game_log(websocket: WebSocket):
    """指定客户端的游戏端日志流。"""
    await websocket.accept()
    client_id = websocket.query_params.get("client_id")
    if not client_id:
        await websocket.send_json({
            "type": "status",
            "status": {"state": "error", "error": "missing client_id"},
        })
        await websocket.close(code=1008)
        return

    conns = game_log_ws_connections.setdefault(client_id, [])
    conns.append(websocket)
    stop_task = game_log_stop_tasks.pop(client_id, None)
    if stop_task and not stop_task.done():
        stop_task.cancel()

    state = _get_game_log_state(client_id)
    await websocket.send_json({
        "type": "init",
        "client_id": client_id,
        "entries": [],
        "meta": state.get("meta", {}),
        "status": state.get("status", {}),
        "droppedCount": state.get("droppedCount", 0),
    })

    if not server_mgr or client_id not in server_mgr.clients:
        await websocket.send_json({
            "type": "status",
            "client_id": client_id,
            "status": {"state": "error", "error": f"客户端 {client_id} 不存在或已断开"},
        })
    else:
        ok, msg = await server_mgr.send_game_log_request(client_id, "start", {
            "bootstrapBytes": GAME_LOG_BOOTSTRAP_BYTES,
            "maxEntries": GAME_LOG_BOOTSTRAP_MAX_ENTRIES,
            "pollIntervalMs": GAME_LOG_POLL_INTERVAL_MS,
            "readChunkBytes": GAME_LOG_READ_CHUNK_BYTES,
        })
        if not ok:
            await websocket.send_json({
                "type": "status",
                "client_id": client_id,
                "status": {"state": "error", "error": msg},
            })

    try:
        while True:
            data = await websocket.receive_text()
            if data == "ping":
                await websocket.send_text("pong")
    except WebSocketDisconnect:
        pass
    finally:
        conns = game_log_ws_connections.get(client_id, [])
        if websocket in conns:
            conns.remove(websocket)
        if not conns:
            game_log_ws_connections.pop(client_id, None)
            _schedule_game_log_stop(client_id)


@app.websocket("/ws/events")
async def websocket_events(websocket: WebSocket):
    """实时事件流"""
    await websocket.accept()
    session_id = websocket.query_params.get("session_id") or None
    entry = {"ws": websocket, "session_id": session_id}
    ws_connections.append(entry)
    print(f"[GmConsole] WS 客户端连接, session={session_id or '-'}, 当前连接数={len(ws_connections)}")

    # 发送初始状态
    init_data = {
        "type": "init",
        "listeners": server_mgr.get_listeners_info(),
        "clients": server_mgr.get_clients_info(),
        "clientStateRev": server_mgr.client_state_rev,
        "logs": server_mgr.get_logs(50),
    }
    print(f"[GmConsole] 发送 init: listeners={len(init_data['listeners'])}, clients={len(init_data['clients'])}")
    await websocket.send_json(init_data)

    try:
        while True:
            # 保持连接，接收心跳
            data = await websocket.receive_text()
            if data == "ping":
                await websocket.send_text("pong")
    except WebSocketDisconnect:
        pass
    finally:
        if entry in ws_connections:
            ws_connections.remove(entry)
        print(f"[GmConsole] WS 客户端断开, 剩余连接数={len(ws_connections)}")


# ============================================================================
# Health Check
# ============================================================================

@app.get("/")
async def index():
    """健康检查"""
    return {
        "name": "GM Console",
        "status": "running",
        "listeners": len(server_mgr.listeners),
        "clients": len(server_mgr.clients),
    }


if __name__ == "__main__":
    uvicorn.run(app, host=HOST, port=PORT)
