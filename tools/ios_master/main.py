"""
iOS Master - FastAPI 入口
"""
import os
import asyncio
import json
import uuid
import shutil
import zipfile
from contextlib import asynccontextmanager
from typing import Optional

from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect, UploadFile, File, BackgroundTasks
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, Response
from pydantic import BaseModel
import uvicorn

from .ios_device_manager import iOSDeviceManager
from .config_manager import ConfigManager

PORT = int(os.environ.get("PORT", 8001))
HOST = os.environ.get("HOST", "0.0.0.0")
DATA_DIR = os.environ.get("DATA_DIR", os.path.join(os.path.dirname(__file__), "../../.local/data/ios_master"))

ios_mgr: Optional[iOSDeviceManager] = None
config_mgr: Optional[ConfigManager] = None

syslog_connections: dict[str, list[WebSocket]] = {}


@asynccontextmanager
async def lifespan(app: FastAPI):
    global ios_mgr, config_mgr

    os.makedirs(DATA_DIR, exist_ok=True)
    ios_mgr = iOSDeviceManager()
    config_mgr = ConfigManager(os.path.join(DATA_DIR, "config.json"))

    print(f"[iOSMaster] 服务启动: {HOST}:{PORT}")

    yield

    for udid in list(ios_mgr._syslog_tasks.keys()):
        ios_mgr.stop_syslog(udid)

    print("[iOSMaster] 已关闭")


app = FastAPI(title="iOS Master", lifespan=lifespan)

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


class AfcPathRequest(BaseModel):
    path: str


class AfcPushRequest(BaseModel):
    local_path: str
    remote_path: str = "/Downloads/"


class AfcPullRequest(BaseModel):
    path: str
    local_path: str = ""


class AppAfcPushRequest(BaseModel):
    bundle_id: str
    local_path: str
    remote_path: str = "/Documents/"


class AppAfcPullRequest(BaseModel):
    bundle_id: str
    path: str
    local_path: str = ""


class UninstallRequest(BaseModel):
    bundle_id: str


class PathHistoryRequest(BaseModel):
    path: str
    category: str = "push"


class OpenFolderRequest(BaseModel):
    path: str


# ============================================================================
# Devices API
# ============================================================================

@app.get("/devices")
async def get_devices():
    devices = await ios_mgr.get_devices()
    result = []
    for dev in devices:
        config = config_mgr.get_device_config(dev.udid)
        result.append({
            "udid": dev.udid,
            "name": dev.name,
            "product_type": dev.product_type,
            "ios_version": dev.ios_version,
            "connection_type": dev.connection_type,
            "nickname": config.get("nickname", ""),
        })
    return {"devices": result}


@app.get("/devices/{udid}/info")
async def get_device_info(udid: str):
    info = await ios_mgr.get_device_info(udid)
    if 'error' in info:
        raise HTTPException(400, info['error'])
    return info


@app.put("/devices/{udid}/nickname")
async def set_nickname(udid: str, req: NicknameRequest):
    config_mgr.set_device_config(udid, nickname=req.nickname)
    return {"message": "昵称已更新"}


# ============================================================================
# App Management API
# ============================================================================

@app.get("/devices/{udid}/apps")
async def list_apps(udid: str, app_type: str = "User"):
    apps = await ios_mgr.list_apps(udid, app_type)
    if apps and 'error' in apps[0]:
        raise HTTPException(400, apps[0]['error'])
    return {"apps": apps}


@app.post("/devices/{udid}/apps/uninstall")
async def uninstall_app(udid: str, req: UninstallRequest):
    success, msg = await ios_mgr.uninstall_app(udid, req.bundle_id)
    if not success:
        raise HTTPException(400, msg)
    return {"message": msg}


# ============================================================================
# Syslog API
# ============================================================================

@app.websocket("/devices/{udid}/syslog")
async def websocket_syslog(websocket: WebSocket, udid: str):
    await websocket.accept()

    if udid not in syslog_connections:
        syslog_connections[udid] = []
    syslog_connections[udid].append(websocket)

    def on_line(line: str):
        for ws in syslog_connections.get(udid, [])[:]:
            try:
                asyncio.create_task(ws.send_text(line))
            except Exception:
                if ws in syslog_connections.get(udid, []):
                    syslog_connections[udid].remove(ws)

    try:
        await ios_mgr.start_syslog(udid, on_line)
    except Exception as e:
        await websocket.send_json({"error": f"Syslog 启动失败: {str(e)}"})
        if websocket in syslog_connections.get(udid, []):
            syslog_connections[udid].remove(websocket)
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
        if websocket in syslog_connections.get(udid, []):
            syslog_connections[udid].remove(websocket)
        if not syslog_connections.get(udid):
            ios_mgr.stop_syslog(udid)


# ============================================================================
# File Transfer API (AFC - Media)
# ============================================================================

@app.post("/devices/{udid}/afc/ls")
async def afc_ls(udid: str, req: AfcPathRequest):
    entries = await ios_mgr.afc_ls(udid, req.path)
    if entries and isinstance(entries[0], dict) and 'error' in entries[0]:
        raise HTTPException(400, entries[0]['error'])
    return {"entries": entries}


@app.post("/devices/{udid}/push")
async def push_file(udid: str, req: AfcPushRequest):
    if not os.path.exists(req.local_path):
        raise HTTPException(400, f"本地路径不存在: {req.local_path}")

    success, msg = await ios_mgr.afc_push(udid, req.local_path, req.remote_path)
    if not success:
        raise HTTPException(400, msg)

    config_mgr.add_path_history(req.remote_path, "push")
    return {"message": msg}


@app.post("/devices/{udid}/pull")
async def pull_file(udid: str, req: AfcPullRequest):
    if req.local_path and req.local_path.strip():
        local_path = req.local_path.strip()
        os.makedirs(os.path.dirname(local_path) or ".", exist_ok=True)
    else:
        from .path_utils import ensure_device_dirs
        dirs = ensure_device_dirs(udid)
        local_path = os.path.join(dirs['sync_area'], os.path.basename(req.path))
        os.makedirs(os.path.dirname(local_path), exist_ok=True)

    success, msg = await ios_mgr.afc_pull(udid, req.path, local_path)
    if not success:
        raise HTTPException(400, msg)

    config_mgr.add_path_history(req.path, "pull")

    if req.local_path and req.local_path.strip():
        return {"message": f"已保存到 {local_path}", "local_path": local_path}
    return FileResponse(local_path, filename=os.path.basename(req.path))


@app.post("/devices/{udid}/push-upload")
async def push_upload(udid: str, file: UploadFile = File(...), remote_path: str = "/Downloads/"):
    transfer_id = uuid.uuid4().hex[:8]
    temp_dir = os.path.join(DATA_DIR, "temp", "push_upload", transfer_id)
    os.makedirs(temp_dir, exist_ok=True)

    original_filename = file.filename or "upload"
    temp_path = os.path.join(temp_dir, original_filename)

    try:
        content = await file.read()
        with open(temp_path, "wb") as f:
            f.write(content)

        push_src = temp_path
        if original_filename.lower().endswith('.zip'):
            extract_dir = os.path.join(temp_dir, original_filename[:-4])
            try:
                with zipfile.ZipFile(temp_path, 'r') as zf:
                    zf.extractall(extract_dir)
                push_src = extract_dir
            except zipfile.BadZipFile:
                raise HTTPException(400, "无效的 ZIP 文件")

        success, msg = await ios_mgr.afc_push(udid, push_src, remote_path)
        if not success:
            raise HTTPException(400, msg)

        config_mgr.add_path_history(remote_path, "push")
        return {"message": msg, "filename": original_filename}
    finally:
        shutil.rmtree(temp_dir, ignore_errors=True)


@app.post("/devices/{udid}/pull-download")
async def pull_download(udid: str, req: AfcPullRequest, background_tasks: BackgroundTasks):
    transfer_id = uuid.uuid4().hex[:8]
    temp_dir = os.path.join(DATA_DIR, "temp", "pull_download", transfer_id)
    os.makedirs(temp_dir, exist_ok=True)

    basename = os.path.basename(req.path.rstrip('/')) or 'file'
    local_path = os.path.join(temp_dir, basename)

    success, msg = await ios_mgr.afc_pull(udid, req.path, local_path)
    if not success:
        shutil.rmtree(temp_dir, ignore_errors=True)
        raise HTTPException(400, msg)

    config_mgr.add_path_history(req.path, "pull")

    def cleanup():
        shutil.rmtree(temp_dir, ignore_errors=True)

    if os.path.isfile(local_path):
        background_tasks.add_task(cleanup)
        return FileResponse(local_path, filename=basename, media_type='application/octet-stream')
    elif os.path.isdir(local_path):
        zip_basename = basename + '.zip'
        zip_path = os.path.join(temp_dir, zip_basename)
        shutil.make_archive(os.path.join(temp_dir, basename), 'zip', temp_dir, basename)
        background_tasks.add_task(cleanup)
        return FileResponse(zip_path, filename=zip_basename, media_type='application/zip')
    else:
        shutil.rmtree(temp_dir, ignore_errors=True)
        raise HTTPException(500, "拉取结果异常")


# ============================================================================
# File Transfer API (App Sandbox)
# ============================================================================

@app.post("/devices/{udid}/app-afc/ls")
async def app_afc_ls(udid: str, req: AfcPathRequest, bundle_id: str = ""):
    if not bundle_id:
        raise HTTPException(400, "需要提供 bundle_id")
    entries = await ios_mgr.app_afc_ls(udid, bundle_id, req.path)
    if entries and isinstance(entries[0], dict) and 'error' in entries[0]:
        raise HTTPException(400, entries[0]['error'])
    return {"entries": entries}


@app.post("/devices/{udid}/app-push")
async def app_push(udid: str, req: AppAfcPushRequest):
    if not os.path.exists(req.local_path):
        raise HTTPException(400, f"本地路径不存在: {req.local_path}")

    success, msg = await ios_mgr.app_afc_push(udid, req.bundle_id, req.local_path, req.remote_path)
    if not success:
        raise HTTPException(400, msg)

    config_mgr.add_path_history(f"{req.bundle_id}:{req.remote_path}", "push")
    return {"message": msg}


@app.post("/devices/{udid}/app-pull")
async def app_pull(udid: str, req: AppAfcPullRequest):
    if req.local_path and req.local_path.strip():
        local_path = req.local_path.strip()
        os.makedirs(os.path.dirname(local_path) or ".", exist_ok=True)
    else:
        from .path_utils import ensure_device_dirs
        dirs = ensure_device_dirs(udid)
        local_path = os.path.join(dirs['sync_area'], os.path.basename(req.path))
        os.makedirs(os.path.dirname(local_path), exist_ok=True)

    success, msg = await ios_mgr.app_afc_pull(udid, req.bundle_id, req.path, local_path)
    if not success:
        raise HTTPException(400, msg)

    config_mgr.add_path_history(f"{req.bundle_id}:{req.path}", "pull")

    if req.local_path and req.local_path.strip():
        return {"message": f"已保存到 {local_path}", "local_path": local_path}
    return FileResponse(local_path, filename=os.path.basename(req.path))


@app.post("/devices/{udid}/app-push-upload")
async def app_push_upload(udid: str, bundle_id: str, file: UploadFile = File(...), remote_path: str = "/Documents/"):
    transfer_id = uuid.uuid4().hex[:8]
    temp_dir = os.path.join(DATA_DIR, "temp", "app_push_upload", transfer_id)
    os.makedirs(temp_dir, exist_ok=True)

    original_filename = file.filename or "upload"
    temp_path = os.path.join(temp_dir, original_filename)

    try:
        content = await file.read()
        with open(temp_path, "wb") as f:
            f.write(content)

        push_src = temp_path
        if original_filename.lower().endswith('.zip'):
            extract_dir = os.path.join(temp_dir, original_filename[:-4])
            try:
                with zipfile.ZipFile(temp_path, 'r') as zf:
                    zf.extractall(extract_dir)
                push_src = extract_dir
            except zipfile.BadZipFile:
                raise HTTPException(400, "无效的 ZIP 文件")

        success, msg = await ios_mgr.app_afc_push(udid, bundle_id, push_src, remote_path)
        if not success:
            raise HTTPException(400, msg)

        config_mgr.add_path_history(f"{bundle_id}:{remote_path}", "push")
        return {"message": msg, "filename": original_filename}
    finally:
        shutil.rmtree(temp_dir, ignore_errors=True)


# ============================================================================
# Screenshot API
# ============================================================================

@app.post("/devices/{udid}/screenshot")
async def take_screenshot(udid: str):
    png_bytes = await ios_mgr.take_screenshot(udid)
    if not png_bytes:
        raise HTTPException(400, "截图失败（可能需要先挂载 Developer Disk Image）")
    return Response(content=png_bytes, media_type="image/png")


# ============================================================================
# IPA Install API
# ============================================================================

@app.post("/devices/{udid}/install")
async def install_ipa(udid: str, file: UploadFile = File(...)):
    temp_path = os.path.join(DATA_DIR, "temp", file.filename or "app.ipa")
    os.makedirs(os.path.dirname(temp_path), exist_ok=True)

    with open(temp_path, "wb") as f:
        content = await file.read()
        f.write(content)

    success, msg = await ios_mgr.install_ipa(udid, temp_path)

    try:
        os.remove(temp_path)
    except Exception:
        pass

    if not success:
        raise HTTPException(400, msg)
    return {"message": msg}


# ============================================================================
# Path History API
# ============================================================================

@app.post("/open-folder")
async def open_folder(req: OpenFolderRequest):
    import subprocess, sys
    target = req.path.strip()
    if not target:
        raise HTTPException(400, "路径不能为空")

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
    if category not in ("push", "pull"):
        raise HTTPException(400, "category 必须为 push 或 pull")
    history = config_mgr.get_path_history(category)
    return {"history": history}


@app.post("/path-history")
async def add_path_history(req: PathHistoryRequest):
    if req.category not in ("push", "pull"):
        raise HTTPException(400, "category 必须为 push 或 pull")
    config_mgr.add_path_history(req.path, req.category)
    return {"message": "已添加"}


# ============================================================================
# Health Check
# ============================================================================

@app.get("/")
async def index():
    devices = await ios_mgr.get_devices()
    return {
        "name": "iOS Master",
        "status": "running",
        "devices": len(devices),
    }


if __name__ == "__main__":
    uvicorn.run(app, host=HOST, port=PORT)
