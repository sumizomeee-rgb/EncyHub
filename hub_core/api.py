"""
EncyHub 平台 API
"""
from fastapi import APIRouter, HTTPException, WebSocket, WebSocketDisconnect, Request, Response
from fastapi.responses import JSONResponse
from typing import Optional
import httpx
import asyncio
import websockets

from .registry import registry
from .process_manager import process_manager
from .config import LOGS_DIR

router = APIRouter(prefix="/api/hub")


@router.get("/tools")
async def list_tools():
    """获取所有工具状态"""
    tools = []
    for tool_id, tool in registry.get_all().items():
        # 检查健康状态
        is_healthy = process_manager.check_health(tool_id) if tool.pid else False
        tools.append({
            "tool_id": tool.tool_id,
            "display_name": tool.display_name,
            "description": tool.description,
            "enabled": tool.enabled,
            "running": is_healthy,
            "port": tool.port if is_healthy else None,
            "last_started": tool.last_started,
        })
    return {"tools": tools}


@router.get("/tools/{tool_id}")
async def get_tool(tool_id: str):
    """获取单个工具状态"""
    tool = registry.get(tool_id)
    if not tool:
        raise HTTPException(404, "工具不存在")

    is_healthy = process_manager.check_health(tool_id) if tool.pid else False
    return {
        "tool_id": tool.tool_id,
        "display_name": tool.display_name,
        "description": tool.description,
        "enabled": tool.enabled,
        "running": is_healthy,
        "port": tool.port if is_healthy else None,
        "last_started": tool.last_started,
    }


@router.post("/tools/{tool_id}/start")
async def start_tool(tool_id: str):
    """启动工具"""
    success, msg = await process_manager.start_tool(tool_id)
    if not success:
        raise HTTPException(400, msg)
    tool = registry.get(tool_id)
    return {"message": msg, "port": tool.port if tool else None}


@router.post("/tools/{tool_id}/stop")
async def stop_tool(tool_id: str):
    """停止工具"""
    success, msg = await process_manager.stop_tool(tool_id)
    if not success:
        raise HTTPException(400, msg)
    return {"message": msg}


@router.post("/tools/{tool_id}/restart")
async def restart_tool(tool_id: str):
    """热重启工具"""
    success, msg = await process_manager.restart_tool(tool_id)
    if not success:
        raise HTTPException(400, msg)
    tool = registry.get(tool_id)
    return {"message": msg, "port": tool.port if tool else None}


@router.get("/tools/{tool_id}/logs")
async def get_tool_logs(tool_id: str, lines: int = 100):
    """获取工具日志"""
    tool = registry.get(tool_id)
    if not tool:
        raise HTTPException(404, "工具不存在")

    log_file = LOGS_DIR / "tools" / f"{tool_id}.log"
    if not log_file.exists():
        return {"logs": []}

    try:
        content = log_file.read_text(encoding="utf-8", errors="ignore")
        log_lines = content.strip().split("\n")
        return {"logs": log_lines[-lines:]}
    except Exception as e:
        raise HTTPException(500, f"读取日志失败: {str(e)}")


# 代理路由 - 转发请求到工具子进程
proxy_router = APIRouter()


@proxy_router.api_route(
    "/api/{tool_id}/{path:path}",
    methods=["GET", "POST", "PUT", "DELETE", "PATCH"]
)
async def proxy_to_tool(tool_id: str, path: str, request: Request):
    """代理请求到工具子进程"""
    # 排除 hub 自身的 API
    if tool_id == "hub":
        raise HTTPException(404, "Not Found")

    tool = registry.get(tool_id)
    if not tool:
        raise HTTPException(404, f"工具不存在: {tool_id}")

    if not tool.port or not process_manager.check_health(tool_id):
        raise HTTPException(503, f"工具未运行: {tool_id}")

    target_url = f"http://127.0.0.1:{tool.port}/{path}"
    if request.url.query:
        target_url += f"?{request.url.query}"

    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            # 转发请求
            body = await request.body()
            headers = dict(request.headers)
            # 移除 host 头
            headers.pop("host", None)

            resp = await client.request(
                method=request.method,
                url=target_url,
                content=body,
                headers=headers,
            )

            return Response(
                content=resp.content,
                status_code=resp.status_code,
                headers=dict(resp.headers),
            )
    except httpx.ConnectError:
        raise HTTPException(503, f"无法连接到工具: {tool_id}")
    except Exception as e:
        raise HTTPException(500, f"代理请求失败: {str(e)}")


@proxy_router.websocket("/api/{tool_id}/{path:path}")
async def proxy_websocket(websocket: WebSocket, tool_id: str, path: str):
    """WebSocket 代理 - 双向转发到工具子进程"""
    if tool_id == "hub":
        await websocket.close(code=4004, reason="Not Found")
        return

    tool = registry.get(tool_id)
    if not tool:
        await websocket.close(code=4004, reason=f"工具不存在: {tool_id}")
        return

    if not tool.port or not process_manager.check_health(tool_id):
        await websocket.close(code=4003, reason=f"工具未运行: {tool_id}")
        return

    # 构建目标 WebSocket URL
    target_url = f"ws://127.0.0.1:{tool.port}/{path}"
    query = str(websocket.scope.get("query_string", b""), "utf-8")
    if query:
        target_url += f"?{query}"

    await websocket.accept()

    upstream_ws = None
    try:
        upstream_ws = await websockets.connect(target_url)

        async def forward_to_upstream():
            """前端 → 工具子进程"""
            try:
                while True:
                    msg = await websocket.receive()
                    if msg.get("type") == "websocket.disconnect":
                        break
                    if "text" in msg:
                        await upstream_ws.send(msg["text"])
                    elif "bytes" in msg:
                        await upstream_ws.send(msg["bytes"])
            except (WebSocketDisconnect, Exception):
                pass

        async def forward_to_client():
            """工具子进程 → 前端"""
            try:
                async for message in upstream_ws:
                    if isinstance(message, str):
                        await websocket.send_text(message)
                    elif isinstance(message, bytes):
                        await websocket.send_bytes(message)
            except (WebSocketDisconnect, Exception):
                pass

        # 双向转发，任一方断开则结束
        done, pending = await asyncio.wait(
            [
                asyncio.create_task(forward_to_upstream()),
                asyncio.create_task(forward_to_client()),
            ],
            return_when=asyncio.FIRST_COMPLETED,
        )
        for task in pending:
            task.cancel()

    except Exception:
        pass
    finally:
        if upstream_ws and not upstream_ws.closed:
            await upstream_ws.close()
        try:
            await websocket.close()
        except Exception:
            pass
