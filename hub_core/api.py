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


@router.post("/build-frontend")
async def build_frontend():
    """编译前端资源"""
    import subprocess
    import sys

    frontend_dir = str(LOGS_DIR.parent / "frontend")
    try:
        result = subprocess.run(
            ["npm", "run", "build"],
            cwd=frontend_dir,
            capture_output=True,
            text=True,
            timeout=60,
            shell=True,
        )
        if result.returncode == 0:
            return {"success": True, "message": "前端编译成功", "output": result.stdout[-500:] if result.stdout else ""}
        else:
            return {"success": False, "message": "编译失败", "output": (result.stderr or result.stdout)[-500:]}
    except subprocess.TimeoutExpired:
        return {"success": False, "message": "编译超时 (60秒)"}
    except Exception as e:
        return {"success": False, "message": f"编译出错: {str(e)}"}




@router.post("/shutdown")
async def shutdown_hub():
    """安全关闭 EncyHub 平台（先停所有工具，再退出进程）"""
    import os

    async def graceful_shutdown():
        await asyncio.sleep(0.5)
        # 停止所有工具子进程
        await process_manager.shutdown_all()
        print("[EncyHub] 所有工具已停止，正在退出...")
        os._exit(0)

    asyncio.create_task(graceful_shutdown())
    return {"success": True, "message": "平台正在安全关闭..."}


@router.post("/restart-hub")
async def restart_hub():
    """重启 EncyHub 平台"""
    import subprocess
    import sys
    import os
    from .config import ROOT_DIR

    start_bat = ROOT_DIR / "start.bat"
    
    # 延迟 1 秒后退出当前进程，给新进程清理时间
    async def delayed_exit():
        await asyncio.sleep(1)
        os._exit(0)

    try:
        # 启动新的 CMD 窗口运行 start.bat
        cmd = ["cmd", "/c", "start", str(start_bat)]
        subprocess.Popen(cmd, shell=True)
        
        asyncio.create_task(delayed_exit())
        return {"success": True, "message": "平台正在重启..."}
    except Exception as e:
        return {"success": False, "message": f"重启失败: {str(e)}"}


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
        async with httpx.AsyncClient(timeout=300.0) as client:
            content_type = request.headers.get("content-type", "")

            # multipart/form-data 需要特殊处理：解析后用 httpx files 重新编码
            if "multipart/form-data" in content_type:
                form = await request.form()
                files = []
                data = {}
                for key in form:
                    value = form[key]
                    if hasattr(value, "read"):  # UploadFile
                        file_bytes = await value.read()
                        files.append((key, (value.filename, file_bytes, value.content_type or "application/octet-stream")))
                    else:
                        data[key] = value
                resp = await client.request(
                    method=request.method,
                    url=target_url,
                    files=files if files else None,
                    data=data if data else None,
                )
                await form.close()
            else:
                # 普通请求：转发原始 body
                body = await request.body()
                headers = dict(request.headers)
                for h in ("host", "transfer-encoding", "connection", "content-length", "expect"):
                    headers.pop(h, None)
                resp = await client.request(
                    method=request.method,
                    url=target_url,
                    content=body,
                    headers=headers,
                )

            # 移除响应中的 hop-by-hop 头
            resp_headers = dict(resp.headers)
            for h in ("transfer-encoding", "connection", "content-length"):
                resp_headers.pop(h, None)

            return Response(
                content=resp.content,
                status_code=resp.status_code,
                headers=resp_headers,
            )
    except httpx.ConnectError:
        raise HTTPException(503, f"无法连接到工具: {tool_id}")
    except Exception as e:
        print(f"[Hub] 代理请求失败 ({request.method} {tool_id}/{path}): {e}")
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
                    # FastAPI WebSocket.receive() 返回值可能是字符串、字节或字典
                    if isinstance(msg, dict):
                        # 字典格式：{"type": "websocket.receive"|"websocket.disconnect", "text": "...", "bytes": b"..."}
                        msg_type = msg.get("type")
                        if msg_type == "websocket.disconnect":
                            print(f"[Hub WS] 前端断开连接")
                            break
                        if "text" in msg:
                            print(f"[Hub WS] 前端→后端 文本: {msg['text'][:50]}...")
                            await upstream_ws.send(msg["text"])
                        elif "bytes" in msg:
                            await upstream_ws.send(msg["bytes"])
                    elif isinstance(msg, str):
                        print(f"[Hub WS] 前端→后端 字符串: {msg[:50]}...")
                        await upstream_ws.send(msg)
                    elif isinstance(msg, bytes):
                        await upstream_ws.send(msg)
            except (WebSocketDisconnect, Exception) as e:
                print(f"[Hub WS] 前端转发错误: {e}")

        async def forward_to_client():
            """工具子进程 → 前端"""
            try:
                async for message in upstream_ws:
                    print(f"[Hub WS] 上游收到消息: type={type(message)}, len={len(message) if isinstance(message, (str, bytes)) else 'N/A'}")
                    if isinstance(message, str):
                        await websocket.send_text(message)
                    elif isinstance(message, bytes):
                        await websocket.send_bytes(message)
            except (WebSocketDisconnect, Exception) as e:
                print(f"[Hub] WS 上游转发错误 ({tool_id}/{path}): {e}")

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

    except Exception as e:
        # 连接上游失败时，向前端发送错误消息
        try:
            await websocket.send_text(f'{{"error": "无法连接到工具服务: {tool_id}"}}')
        except Exception:
            pass
        print(f"[Hub] WS 代理连接失败 ({tool_id}/{path}): {e}")
    finally:
        if upstream_ws:
            try:
                await upstream_ws.close()
            except Exception:
                pass
        try:
            await websocket.close()
        except Exception:
            pass
