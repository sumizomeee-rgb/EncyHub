"""
EncyHub - 开发工具聚合平台
"""
import asyncio
import json
import signal
import sys
import time
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
import psutil
import uvicorn

# !! 在导入 hub_core 之前，先读取 registry 中的旧 PID !!
# 因为 hub_core 导入时 Registry._load() 会清除 pid/port 并回写文件
_REGISTRY_PATH = Path(__file__).resolve().parent / "data" / "registry.json"
_OLD_PIDS: dict[str, int] = {}
if _REGISTRY_PATH.exists():
    try:
        _reg_data = json.loads(_REGISTRY_PATH.read_text(encoding="utf-8"))
        for _tid, _tdata in _reg_data.items():
            if _tdata.get("pid"):
                _OLD_PIDS[_tid] = _tdata["pid"]
    except Exception:
        pass

from hub_core import (
    ROOT_DIR,
    HUB_HOST,
    HUB_PORT,
    registry,
    process_manager,
    router as hub_router,
    proxy_router,
)
from hub_core.config import FRONTEND_DIST


def cleanup_before_start():
    """启动前清理旧进程：杀死 registry 中记录的旧工具子进程 + 占用 Hub 端口的旧进程"""
    cleaned = False

    # 1. 杀死 registry 中记录的旧工具子进程
    for tool_id, old_pid in _OLD_PIDS.items():
        try:
            proc = psutil.Process(old_pid)
            if proc.is_running():
                children = proc.children(recursive=True)
                for child in children:
                    try:
                        child.kill()
                    except psutil.NoSuchProcess:
                        pass
                proc.kill()
                proc.wait(timeout=3)
                print(f"[Cleanup] 已杀死旧工具进程: {tool_id} (PID={old_pid})")
                cleaned = True
        except psutil.NoSuchProcess:
            pass
        except Exception as e:
            print(f"[Cleanup] 清理旧工具进程失败 {tool_id}: {e}")

    # 2. 杀死占用 Hub 端口的旧进程
    try:
        for conn in psutil.net_connections(kind='tcp'):
            if conn.laddr.port == HUB_PORT and conn.status == 'LISTEN':
                try:
                    proc = psutil.Process(conn.pid)
                    children = proc.children(recursive=True)
                    for child in children:
                        try:
                            child.kill()
                        except psutil.NoSuchProcess:
                            pass
                    proc.kill()
                    proc.wait(timeout=3)
                    print(f"[Cleanup] 已杀死占用端口 {HUB_PORT} 的旧进程 (PID={conn.pid})")
                    cleaned = True
                except psutil.NoSuchProcess:
                    pass
                except psutil.AccessDenied:
                    print(f"[Cleanup] 无权杀死 PID={conn.pid}，请手动关闭或以管理员身份运行")
                except Exception as e:
                    print(f"[Cleanup] 清理端口占用失败: {e}")
    except psutil.AccessDenied:
        # Windows 下 net_connections 可能需要管理员权限，降级用 netstat
        import subprocess
        try:
            result = subprocess.run(
                ['netstat', '-aon'],
                capture_output=True, text=True, timeout=5,
                creationflags=0x08000000 if sys.platform == 'win32' else 0,
            )
            for line in result.stdout.splitlines():
                if f':{HUB_PORT} ' in line and 'LISTENING' in line:
                    parts = line.split()
                    pid = int(parts[-1])
                    try:
                        proc = psutil.Process(pid)
                        proc.kill()
                        proc.wait(timeout=3)
                        print(f"[Cleanup] 已杀死占用端口 {HUB_PORT} 的旧进程 (PID={pid})")
                        cleaned = True
                    except Exception:
                        pass
        except Exception:
            pass

    if cleaned:
        time.sleep(1)
        print("[Cleanup] 旧进程清理完成")


@asynccontextmanager
async def lifespan(app: FastAPI):
    """应用生命周期管理"""
    print("=" * 50)
    print("  EncyHub 启动中...")
    print("=" * 50)

    # 启动时恢复上次启用的工具
    await process_manager.startup_restore()

    # 启动健康检查任务
    health_check_task = asyncio.create_task(health_check_loop())

    print(f"\n  访问地址: http://localhost:{HUB_PORT}")
    print(f"  内网访问: http://0.0.0.0:{HUB_PORT}")
    print("=" * 50)

    yield

    # 关闭时停止所有工具
    print("\n[EncyHub] 正在关闭...")
    health_check_task.cancel()
    await process_manager.shutdown_all()
    print("[EncyHub] 已关闭")


async def health_check_loop():
    """定期健康检查"""
    while True:
        await asyncio.sleep(30)
        await process_manager.check_all_health()


app = FastAPI(
    title="EncyHub",
    description="开发工具聚合平台",
    version="1.0.0",
    lifespan=lifespan,
)

# CORS 配置（支持内网访问）
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# 挂载 API 路由（顺序重要）
app.include_router(hub_router)  # /api/hub/*
app.include_router(proxy_router)  # /api/{tool_id}/*

# 挂载前端静态文件（最后）
if FRONTEND_DIST.exists():
    app.mount("/", StaticFiles(directory=str(FRONTEND_DIST), html=True), name="frontend")
else:
    @app.get("/")
    async def index():
        return {
            "message": "EncyHub API Server",
            "docs": "/docs",
            "note": "前端未构建，请运行 cd frontend && npm install && npm run build"
        }


def main():
    """主入口"""
    # 启动前清理旧进程
    cleanup_before_start()

    # 处理 Ctrl+C
    def signal_handler(sig, frame):
        print("\n[EncyHub] 收到退出信号...")
        sys.exit(0)

    signal.signal(signal.SIGINT, signal_handler)

    uvicorn.run(
        app,
        host=HUB_HOST,
        port=HUB_PORT,
        log_level="info",
    )


if __name__ == "__main__":
    main()
