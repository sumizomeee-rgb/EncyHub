"""
ADB Master - FastAPI 入口
"""
import os
import asyncio
from contextlib import asynccontextmanager
from typing import Optional

from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect, UploadFile, File
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from pydantic import BaseModel
import uvicorn

from .adb_manager import AdbManager
from .config_manager import ConfigManager

# 环境变量
PORT = int(os.environ.get("PORT", 8000))
HOST = os.environ.get("HOST", "0.0.0.0")
DATA_DIR = os.environ.get("DATA_DIR", os.path.join(os.path.dirname(__file__), "../../data/adb_master"))

# 全局实例
adb_mgr: Optional[AdbManager] = None
config_mgr: Optional[ConfigManager] = None

# WebSocket 连接池（用于 Logcat）
logcat_connections: dict[str, list[WebSocket]] = {}


@asynccontextmanager
async def lifespan(app: FastAPI):
    """应用生命周期"""
    global adb_mgr, config_mgr

    os.makedirs(DATA_DIR, exist_ok=True)
    adb_mgr = AdbManager()
    config_mgr = ConfigManager(os.path.join(DATA_DIR, "config.json"))

    print(f"[AdbMaster] 服务启动: {HOST}:{PORT}")

    yield

    # 停止所有 Logcat
    for serial in list(adb_mgr._logcat_tasks.keys()):
        adb_mgr.stop_logcat(serial)

    print("[AdbMaster] 已关闭")


app = FastAPI(title="ADB Master", lifespan=lifespan)

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

class NicknameRequest(BaseModel):
    nickname: str


class PathRequest(BaseModel):
    path: str
    local_path: str = ""


class InstallRequest(BaseModel):
    apk_path: str


class PathHistoryRequest(BaseModel):
    path: str
    category: str = "push"


# ============================================================================
# Devices API
# ============================================================================

@app.get("/devices")
async def get_devices():
    """获取设备列表"""
    devices = await adb_mgr.get_unified_devices()
    result = []
    for dev in devices:
        config = config_mgr.get_device_config(dev.hardware_id)
        result.append({
            "hardware_id": dev.hardware_id,
            "model": dev.model,
            "usb_connected": dev.usb_serial is not None,
            "wifi_connected": dev.wifi_address is not None,
            "wifi_ip": dev.wifi_ip,
            "connection_status": dev.connection_status,
            "nickname": config.get("nickname", ""),
            "active_serial": dev.active_serial,
        })
    return {"devices": result}


@app.post("/devices/refresh")
async def refresh_devices():
    """刷新设备列表"""
    devices = await adb_mgr.get_unified_devices()
    return {"message": f"发现 {len(devices)} 个设备"}


@app.get("/devices/{hw_id}")
async def get_device(hw_id: str):
    """获取单个设备信息"""
    devices = await adb_mgr.get_unified_devices()
    dev = next((d for d in devices if d.hardware_id == hw_id), None)
    if not dev:
        raise HTTPException(404, "设备不存在")

    config = config_mgr.get_device_config(hw_id)
    return {
        "hardware_id": dev.hardware_id,
        "model": dev.model,
        "usb_connected": dev.usb_serial is not None,
        "wifi_connected": dev.wifi_address is not None,
        "wifi_ip": dev.wifi_ip,
        "connection_status": dev.connection_status,
        "nickname": config.get("nickname", ""),
        "active_serial": dev.active_serial,
    }


@app.put("/devices/{hw_id}/nickname")
async def set_nickname(hw_id: str, req: NicknameRequest):
    """设置设备昵称"""
    config_mgr.set_device_config(hw_id, nickname=req.nickname)
    return {"message": "昵称已更新"}


@app.post("/devices/{hw_id}/connect-wifi")
async def connect_wifi(hw_id: str):
    """连接 WiFi"""
    devices = await adb_mgr.get_unified_devices()
    dev = next((d for d in devices if d.hardware_id == hw_id), None)
    if not dev:
        raise HTTPException(404, "设备不存在")

    if not dev.usb_serial:
        raise HTTPException(400, "需要先通过 USB 连接设备")

    success, msg = await adb_mgr.connect_wifi(dev.usb_serial)
    if not success:
        raise HTTPException(400, msg)
    return {"message": msg}


@app.post("/devices/{hw_id}/disconnect")
async def disconnect_device(hw_id: str):
    """断开设备连接"""
    devices = await adb_mgr.get_unified_devices()
    dev = next((d for d in devices if d.hardware_id == hw_id), None)
    if not dev:
        raise HTTPException(404, "设备不存在")

    if dev.wifi_address:
        await adb_mgr.disconnect_wifi(dev.wifi_address)

    return {"message": "已断开连接"}


# ============================================================================
# Logcat API
# ============================================================================

@app.websocket("/devices/{hw_id}/logcat")
async def websocket_logcat(websocket: WebSocket, hw_id: str):
    """Logcat WebSocket 流"""
    await websocket.accept()

    # 添加到连接池
    if hw_id not in logcat_connections:
        logcat_connections[hw_id] = []
    logcat_connections[hw_id].append(websocket)

    # 获取设备
    devices = await adb_mgr.get_unified_devices()
    dev = next((d for d in devices if d.hardware_id == hw_id), None)
    if not dev or not dev.active_serial:
        await websocket.send_json({"error": "设备不存在或离线"})
        await websocket.close()
        return

    # 定义回调（同步，因为 adb_manager 同步调用它）
    def on_line(line: str):
        for ws in logcat_connections.get(hw_id, [])[:]:
            try:
                asyncio.create_task(ws.send_text(line))
            except:
                if ws in logcat_connections.get(hw_id, []):
                    logcat_connections[hw_id].remove(ws)

    # 启动 Logcat
    try:
        await adb_mgr.start_logcat(dev.active_serial, on_line)
    except Exception as e:
        print(f"[AdbMaster] Logcat 启动失败 ({dev.active_serial}): {e}")
        await websocket.send_json({"error": f"Logcat 启动失败: {str(e)}"})
        if websocket in logcat_connections.get(hw_id, []):
            logcat_connections[hw_id].remove(websocket)
        await websocket.close()
        return

    try:
        while True:
            data = await websocket.receive_text()
            if data == "stop":
                break
    except WebSocketDisconnect:
        pass
    finally:
        if websocket in logcat_connections.get(hw_id, []):
            logcat_connections[hw_id].remove(websocket)
        # 如果没有其他连接，停止 Logcat
        if not logcat_connections.get(hw_id):
            adb_mgr.stop_logcat(dev.active_serial)


# ============================================================================
# File Transfer API
# ============================================================================

class PushRequest(BaseModel):
    local_path: str
    remote_path: str = "/sdcard/"


@app.post("/devices/{hw_id}/push")
async def push_file(hw_id: str, req: PushRequest):
    """推送文件/文件夹到设备"""
    devices = await adb_mgr.get_unified_devices()
    dev = next((d for d in devices if d.hardware_id == hw_id), None)
    if not dev or not dev.active_serial:
        raise HTTPException(404, "设备不存在或离线")

    # 验证本地路径存在
    if not os.path.exists(req.local_path):
        raise HTTPException(400, f"本地路径不存在: {req.local_path}")

    # 推送到设备（adb push 原生支持文件夹递归）
    success, msg = await adb_mgr.push_file(dev.active_serial, req.local_path, req.remote_path)

    if not success:
        raise HTTPException(400, msg)

    # 记录路径历史
    config_mgr.add_path_history(req.remote_path, "push")

    return {"message": msg}


@app.post("/devices/{hw_id}/pull")
async def pull_file(hw_id: str, req: PathRequest):
    """从设备拉取文件"""
    devices = await adb_mgr.get_unified_devices()
    dev = next((d for d in devices if d.hardware_id == hw_id), None)
    if not dev or not dev.active_serial:
        raise HTTPException(404, "设备不存在或离线")

    # 确定本地保存路径
    if req.local_path and req.local_path.strip():
        local_path = req.local_path.strip()
        os.makedirs(os.path.dirname(local_path) or ".", exist_ok=True)
    else:
        # 默认保存到设备专属目录
        from .path_utils import ensure_device_dirs
        dirs = ensure_device_dirs(hw_id)
        local_path = os.path.join(dirs['sync_area'], os.path.basename(req.path))
        os.makedirs(os.path.dirname(local_path), exist_ok=True)

    success, msg = await adb_mgr.pull_file(dev.active_serial, req.path, local_path)
    if not success:
        raise HTTPException(400, msg)

    # 记录路径历史
    config_mgr.add_path_history(req.path, "pull")

    # 如果指定了本地路径，返回 JSON 而非文件流
    if req.local_path and req.local_path.strip():
        return {"message": f"已保存到 {local_path}", "local_path": local_path}

    return FileResponse(local_path, filename=os.path.basename(req.path))


# ============================================================================
# APK Install API
# ============================================================================

@app.post("/devices/{hw_id}/install")
async def install_apk(hw_id: str, file: UploadFile = File(...)):
    """安装 APK"""
    devices = await adb_mgr.get_unified_devices()
    dev = next((d for d in devices if d.hardware_id == hw_id), None)
    if not dev or not dev.active_serial:
        raise HTTPException(404, "设备不存在或离线")

    # 保存上传的 APK
    temp_path = os.path.join(DATA_DIR, "temp", file.filename)
    os.makedirs(os.path.dirname(temp_path), exist_ok=True)
    with open(temp_path, "wb") as f:
        content = await file.read()
        f.write(content)

    # 安装
    success, msg = await adb_mgr.install_apk(dev.active_serial, temp_path)

    # 清理临时文件
    try:
        os.remove(temp_path)
    except:
        pass

    if not success:
        raise HTTPException(400, msg)
    return {"message": msg}


# ============================================================================
# App Control API
# ============================================================================

@app.post("/devices/{hw_id}/restart-app")
async def restart_app(hw_id: str):
    """重启前台应用"""
    devices = await adb_mgr.get_unified_devices()
    dev = next((d for d in devices if d.hardware_id == hw_id), None)
    if not dev or not dev.active_serial:
        raise HTTPException(404, "设备不存在或离线")

    success, msg, _pkg = await adb_mgr.restart_app(dev.active_serial)
    if not success:
        raise HTTPException(400, msg)
    return {"message": msg}


# ============================================================================
# Path History API
# ============================================================================

class OpenFolderRequest(BaseModel):
    path: str


@app.post("/open-folder")
async def open_folder(req: OpenFolderRequest):
    """在系统文件管理器中打开本地文件夹"""
    import subprocess, sys
    target = req.path.strip()
    if not target:
        raise HTTPException(400, "路径不能为空")

    # 如果是文件路径，取其所在目录
    if os.path.isfile(target):
        target = os.path.dirname(target)

    if not os.path.isdir(target):
        raise HTTPException(400, f"目录不存在: {target}")

    try:
        if sys.platform == 'win32':
            os.startfile(target)
        elif sys.platform == 'darwin':
            subprocess.Popen(['open', target])
        else:
            subprocess.Popen(['xdg-open', target])
        return {"message": f"已打开: {target}"}
    except Exception as e:
        raise HTTPException(500, f"打开失败: {e}")


@app.get("/path-history/{category}")
async def get_path_history(category: str):
    """获取路径历史"""
    if category not in ("push", "pull"):
        raise HTTPException(400, "category 必须为 push 或 pull")
    history = config_mgr.get_path_history(category)
    return {"history": history}


@app.post("/path-history")
async def add_path_history(req: PathHistoryRequest):
    """添加路径到历史"""
    if req.category not in ("push", "pull"):
        raise HTTPException(400, "category 必须为 push 或 pull")
    config_mgr.add_path_history(req.path, req.category)
    return {"message": "已添加"}


# ============================================================================
# Health Check
# ============================================================================

@app.get("/")
async def index():
    """健康检查"""
    devices = await adb_mgr.get_unified_devices()
    return {
        "name": "ADB Master",
        "status": "running",
        "devices": len(devices),
    }


if __name__ == "__main__":
    uvicorn.run(app, host=HOST, port=PORT)
