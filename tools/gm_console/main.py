"""
GM Console - FastAPI 入口
"""
import os
import asyncio
from contextlib import asynccontextmanager
from typing import Optional, Any

from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
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
    for ws in ws_connections[:]:
        try:
            await ws.send_json(event)
        except:
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
    gm_id: str
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


# ============================================================================
# WebSocket
# ============================================================================

@app.websocket("/ws/events")
async def websocket_events(websocket: WebSocket):
    """实时事件流"""
    await websocket.accept()
    ws_connections.append(websocket)

    # 发送初始状态
    await websocket.send_json({
        "type": "init",
        "listeners": server_mgr.get_listeners_info(),
        "clients": server_mgr.get_clients_info(),
        "logs": server_mgr.get_logs(50),
    })

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
