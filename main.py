"""
EncyHub - 开发工具聚合平台
"""
import asyncio
import signal
import sys
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
import uvicorn

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
