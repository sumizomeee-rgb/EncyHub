"""
FlowSVN - FastAPI 入口
"""
import os
import uuid
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Literal, Optional, List

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
import uvicorn

from .config_manager import ConfigManager
from .task_scheduler import TaskScheduler
from .svn_executor import SVNExecutor
from .models import Task, Template
from .task_runner import run_task_by_id

# 环境变量
PORT = int(os.environ.get("PORT", 8000))
HOST = os.environ.get("HOST", "0.0.0.0")
DATA_DIR = os.environ.get("DATA_DIR", os.path.join(os.path.dirname(__file__), "../../.local/data/flow_svn"))

# 全局实例
config_mgr: Optional[ConfigManager] = None
task_scheduler: Optional[TaskScheduler] = None
svn_executor: Optional[SVNExecutor] = None


def is_svn_working_copy_path(path: str) -> bool:
    """Check whether a path is inside an SVN working copy."""
    path_obj = Path(path)
    if not path_obj.exists() or not path_obj.is_dir():
        return False

    current_path = path_obj.resolve()
    while current_path != current_path.parent:
        svn_dir = current_path / ".svn"
        if svn_dir.exists() and svn_dir.is_dir():
            return True
        current_path = current_path.parent

    return False


@asynccontextmanager
async def lifespan(app: FastAPI):
    """应用生命周期"""
    global config_mgr, task_scheduler, svn_executor

    os.makedirs(DATA_DIR, exist_ok=True)
    config_path = os.path.join(DATA_DIR, "config.json")

    config_mgr = ConfigManager(config_path)
    task_scheduler = TaskScheduler()
    svn_executor = SVNExecutor()

    # 同步配置中的任务到 Windows 任务计划
    tasks = config_mgr.get_all_tasks()
    for task in tasks:
        if task.enabled:
            success, msg = task_scheduler.create_task(task.id, task.name, task.schedule_time)
            if success:
                print(f"[FlowSVN] Scheduled task: {task.name} at {task.schedule_time}")
            else:
                print(f"[FlowSVN] Failed to schedule task {task.name}: {msg}")

    print(f"[FlowSVN] Started: {HOST}:{PORT}")

    yield

    print("[FlowSVN] Stopped")


app = FastAPI(title="FlowSVN", lifespan=lifespan)

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

class TaskCreate(BaseModel):
    name: str
    svn_path: str
    schedule_time: str  # HH:MM format
    operation: Literal["update", "cleanup"] = "update"
    template_id: Optional[str] = None
    enabled: bool = True


class TaskUpdate(BaseModel):
    name: Optional[str] = None
    svn_path: Optional[str] = None
    schedule_time: Optional[str] = None
    operation: Optional[Literal["update", "cleanup"]] = None
    template_id: Optional[str] = None
    enabled: Optional[bool] = None


class TemplateCreate(BaseModel):
    name: str
    actions: List[dict]


class TemplateUpdate(BaseModel):
    name: Optional[str] = None
    actions: Optional[List[dict]] = None


# ============================================================================
# Tasks API
# ============================================================================

@app.get("/tasks")
async def get_tasks():
    """获取任务列表"""
    tasks = config_mgr.get_all_tasks()
    return {"tasks": [t.to_dict() for t in tasks]}


@app.post("/tasks")
async def create_task(req: TaskCreate):
    """创建任务"""
    # SVN 路径验证
    if not os.path.isdir(req.svn_path):
        raise HTTPException(400, f"路径不存在: {req.svn_path}")
    if not is_svn_working_copy_path(req.svn_path):
        raise HTTPException(400, f"不是有效的 SVN 工作副本: {req.svn_path}")

    template_id = req.template_id or ""
    if req.operation == "cleanup":
        template_id = ""

    task = Task(
        id=str(uuid.uuid4())[:8],
        name=req.name,
        svn_path=req.svn_path,
        schedule_time=req.schedule_time,
        operation=req.operation,
        template_id=template_id,
        enabled=req.enabled,
    )

    if not config_mgr.add_task(task):
        raise HTTPException(400, "任务创建失败")

    # 注册到 Windows 任务计划
    if task.enabled:
        success, msg = task_scheduler.create_task(task.id, task.name, task.schedule_time)
        if not success:
            print(f"[FlowSVN] Task schedule creation failed: {msg}")

    return {"message": "任务已创建", "task": task.to_dict()}


@app.get("/tasks/{task_id}")
async def get_task(task_id: str):
    """获取单个任务"""
    task = config_mgr.get_task(task_id)
    if not task:
        raise HTTPException(404, "任务不存在")
    return {"task": task.to_dict()}


@app.put("/tasks/{task_id}")
async def update_task(task_id: str, req: TaskUpdate):
    """更新任务"""
    task = config_mgr.get_task(task_id)
    if not task:
        raise HTTPException(404, "任务不存在")

    old_name = task.name

    # SVN 路径验证
    if req.svn_path is not None:
        if not os.path.isdir(req.svn_path):
            raise HTTPException(400, f"路径不存在: {req.svn_path}")
        if not is_svn_working_copy_path(req.svn_path):
            raise HTTPException(400, f"不是有效的 SVN 工作副本: {req.svn_path}")

    # 更新字段
    if req.name is not None:
        task.name = req.name
    if req.svn_path is not None:
        task.svn_path = req.svn_path
    if req.schedule_time is not None:
        task.schedule_time = req.schedule_time
    if req.operation is not None:
        task.operation = req.operation
    if req.template_id is not None:
        task.template_id = req.template_id or ""
    if req.enabled is not None:
        task.enabled = req.enabled
    if task.operation == "cleanup":
        task.template_id = ""

    if not config_mgr.update_task(task):
        raise HTTPException(400, "任务更新失败")

    # 更新任务计划
    if task.enabled:
        task_scheduler.delete_task(task_id, old_name)
        task_scheduler.create_task(task.id, task.name, task.schedule_time)
    else:
        task_scheduler.delete_task(task_id, old_name)

    return {"message": "任务已更新", "task": task.to_dict()}


@app.delete("/tasks/{task_id}")
async def delete_task(task_id: str):
    """删除任务"""
    task = config_mgr.get_task(task_id)
    if not task:
        raise HTTPException(404, "任务不存在")

    # 删除任务计划
    task_scheduler.delete_task(task_id, task.name)

    # 删除配置
    config_mgr.delete_task(task_id)

    return {"message": "任务已删除"}


@app.post("/tasks/{task_id}/run")
async def run_task(task_id: str):
    """立即执行任务"""
    task = config_mgr.get_task(task_id)
    if not task:
        raise HTTPException(404, "任务不存在")

    result = run_task_by_id(
        config_mgr=config_mgr,
        task_id=task_id,
        svn_executor=svn_executor,
        respect_enabled=False,
    )
    return {"message": result.message, "output": result.output, "success": result.success}


# ============================================================================
# Templates API
# ============================================================================

@app.get("/templates")
async def get_templates():
    """获取模板列表"""
    templates = config_mgr.get_all_templates()
    return {"templates": [t.to_dict() for t in templates]}


@app.post("/templates")
async def create_template(req: TemplateCreate):
    """创建模板"""
    template = Template(
        id=str(uuid.uuid4())[:8],
        name=req.name,
        actions=req.actions,
    )

    if not config_mgr.add_template(template):
        raise HTTPException(400, "模板创建失败")

    return {"message": "模板已创建", "template": template.to_dict()}


@app.get("/templates/{template_id}")
async def get_template(template_id: str):
    """获取单个模板"""
    template = config_mgr.get_template(template_id)
    if not template:
        raise HTTPException(404, "模板不存在")
    return {"template": template.to_dict()}


@app.put("/templates/{template_id}")
async def update_template(template_id: str, req: TemplateUpdate):
    """更新模板"""
    template = config_mgr.get_template(template_id)
    if not template:
        raise HTTPException(404, "模板不存在")

    if req.name is not None:
        template.name = req.name
    if req.actions is not None:
        template.actions = req.actions

    if not config_mgr.update_template(template):
        raise HTTPException(400, "模板更新失败")

    return {"message": "模板已更新", "template": template.to_dict()}


@app.delete("/templates/{template_id}")
async def delete_template(template_id: str):
    """删除模板"""
    template = config_mgr.get_template(template_id)
    if not template:
        raise HTTPException(404, "模板不存在")

    if not config_mgr.delete_template(template_id):
        raise HTTPException(400, "模板正在被使用，无法删除")

    return {"message": "模板已删除"}


# ============================================================================
# Health Check
# ============================================================================

@app.get("/")
async def index():
    """健康检查"""
    tasks = config_mgr.get_all_tasks()
    templates = config_mgr.get_all_templates()
    return {
        "name": "FlowSVN",
        "status": "running",
        "tasks": len(tasks),
        "templates": len(templates),
    }


if __name__ == "__main__":
    uvicorn.run(app, host=HOST, port=PORT)
