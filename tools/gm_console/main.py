"""
GM Console - FastAPI 入口
"""
import os
import asyncio
from contextlib import asynccontextmanager
from typing import Optional, Any

from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect, Request
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
import uvicorn

from .server_mgr import ServerMgr
from .custom_gm import CustomGmManager

# 环境变量
PORT = int(os.environ.get("PORT", 8000))
HOST = os.environ.get("HOST", "0.0.0.0")
DATA_DIR = os.environ.get("DATA_DIR", os.path.join(os.path.dirname(__file__), "../../data/gm_console"))

# 默认 TCP 监听端口
DEFAULT_TCP_PORT = 12581

# 全局实例
server_mgr: Optional[ServerMgr] = None
custom_gm_mgr: Optional[CustomGmManager] = None

# WebSocket 连接池
ws_connections: list[WebSocket] = []


async def broadcast_event(event: dict):
    """广播事件到所有 WebSocket 连接"""
    if not ws_connections:
        print(f"[GmConsole] 广播跳过: 无 WS 连接 (event.type={event.get('type')})")
        return
    print(f"[GmConsole] 广播事件: type={event.get('type')}, ws连接数={len(ws_connections)}, clients={len(event.get('clients', []))}")
    for ws in ws_connections[:]:
        try:
            await ws.send_json(event)
        except Exception as e:
            print(f"[GmConsole] WS 广播失败, 移除连接: {e}")
            if ws in ws_connections:
                ws_connections.remove(ws)


@asynccontextmanager
async def lifespan(app: FastAPI):
    """应用生命周期"""
    global server_mgr, custom_gm_mgr

    # 初始化
    os.makedirs(DATA_DIR, exist_ok=True)
    server_mgr = ServerMgr()
    custom_gm_mgr = CustomGmManager(DATA_DIR)

    # 设置回调
    def on_update():
        asyncio.create_task(broadcast_event({
            "type": "update",
            "listeners": server_mgr.get_listeners_info(),
            "clients": server_mgr.get_clients_info(),
        }))

    def on_log(log):
        asyncio.create_task(broadcast_event({
            "type": "log",
            "log": log.to_dict(),
        }))

    server_mgr.on_update = on_update
    server_mgr.on_log = on_log

    def on_client_data_update(client_id):
        asyncio.create_task(broadcast_event({
            "type": "update",
            "listeners": server_mgr.get_listeners_info(),
            "clients": server_mgr.get_clients_info(),
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

class AddListenerRequest(BaseModel):
    port: int


class ExecRequest(BaseModel):
    cmd: str


class ExecGmRequest(BaseModel):
    gm_id: Any
    value: Any = None


class CustomGmRequest(BaseModel):
    name: str
    cmd: str


# ============================================================================
# Listeners API
# ============================================================================

@app.get("/listeners")
async def get_listeners():
    """获取监听端口列表"""
    return {"listeners": server_mgr.get_listeners_info()}


@app.post("/listeners")
async def add_listener(req: AddListenerRequest):
    """添加监听端口"""
    success, msg = await server_mgr.add_listener(req.port)
    if not success:
        raise HTTPException(400, msg)
    return {"message": msg}


@app.delete("/listeners/{port}")
async def remove_listener(port: int):
    """移除监听端口"""
    success, msg = await server_mgr.remove_listener(port)
    if not success:
        raise HTTPException(400, msg)
    return {"message": msg}


# ============================================================================
# Clients API
# ============================================================================

@app.get("/clients")
async def get_clients():
    """获取已连接客户端"""
    return {"clients": server_mgr.get_clients_info()}


@app.post("/clients/{client_id}/exec")
async def exec_lua(client_id: str, req: ExecRequest):
    """执行 Lua 命令"""
    success, msg = await server_mgr.send_to_client(client_id, req.cmd)
    if not success:
        raise HTTPException(400, msg)
    return {"message": msg}


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


# ============================================================================
# WebSocket
# ============================================================================

@app.websocket("/ws/events")
async def websocket_events(websocket: WebSocket):
    """实时事件流"""
    await websocket.accept()
    ws_connections.append(websocket)
    print(f"[GmConsole] WS 客户端连接, 当前连接数={len(ws_connections)}")

    # 发送初始状态
    init_data = {
        "type": "init",
        "listeners": server_mgr.get_listeners_info(),
        "clients": server_mgr.get_clients_info(),
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
        if websocket in ws_connections:
            ws_connections.remove(websocket)
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
