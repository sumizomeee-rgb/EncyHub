"""
EncyHub 进程管理器
"""
import os
import sys
import asyncio
import subprocess
from pathlib import Path
from typing import Optional

import psutil

from .config import ROOT_DIR, TOOLS_DIR, DATA_DIR, LOGS_DIR, find_free_port, get_tool_log_path
from .registry import registry


class ProcessManager:
    """工具进程管理"""

    def __init__(self):
        self._processes: dict[str, subprocess.Popen] = {}

    async def start_tool(self, tool_id: str) -> tuple[bool, str]:
        """启动工具子进程"""
        tool = registry.get(tool_id)
        if not tool:
            return False, f"工具不存在: {tool_id}"

        if registry.is_running(tool_id):
            return False, f"工具已在运行: {tool_id}"

        tool_main = TOOLS_DIR / tool_id / "main.py"
        if not tool_main.exists():
            return False, f"工具入口不存在: {tool_main}"

        # 分配端口
        port = find_free_port()
        data_dir = DATA_DIR / tool_id
        log_file = get_tool_log_path(tool_id)  # 使用带时间戳的日志文件

        # 环境变量
        env = os.environ.copy()
        env["PORT"] = str(port)
        env["HOST"] = "0.0.0.0"
        env["DATA_DIR"] = str(data_dir)
        env["ENCYHUB_MODE"] = "1"  # 标记为聚合模式

        try:
            # 启动子进程（使用模块方式运行，支持相对导入）
            module_name = f"tools.{tool_id}.main"
            with open(log_file, "a", encoding="utf-8") as log:
                process = subprocess.Popen(
                    [sys.executable, "-u", "-m", module_name],
                    env=env,
                    cwd=str(ROOT_DIR),
                    stdout=log,
                    stderr=subprocess.STDOUT,
                    creationflags=subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0,
                )

            self._processes[tool_id] = process

            # 等待启动
            await asyncio.sleep(1.5)

            # 检查是否启动成功
            if process.poll() is not None:
                return False, f"工具启动失败，请查看日志: {log_file}"

            # 更新注册表
            registry.set_running(tool_id, port, process.pid)
            print(f"[ProcessManager] 启动工具: {tool_id} (PID={process.pid}, PORT={port})")
            return True, f"工具已启动: {tool.display_name}"

        except Exception as e:
            return False, f"启动失败: {str(e)}"

    async def stop_tool(self, tool_id: str) -> tuple[bool, str]:
        """停止工具子进程"""
        tool = registry.get(tool_id)
        if not tool:
            return False, f"工具不存在: {tool_id}"

        if not tool.pid:
            registry.set_stopped(tool_id)
            return True, "工具未运行"

        try:
            # 递归杀死子进程树
            parent = psutil.Process(tool.pid)
            children = parent.children(recursive=True)
            for child in children:
                try:
                    child.kill()
                except psutil.NoSuchProcess:
                    pass
            parent.kill()
            parent.wait(timeout=5)
        except psutil.NoSuchProcess:
            pass
        except Exception as e:
            print(f"[ProcessManager] 停止工具异常: {e}")

        # 清理
        if tool_id in self._processes:
            del self._processes[tool_id]

        registry.set_stopped(tool_id)
        print(f"[ProcessManager] 停止工具: {tool_id}")
        return True, f"工具已停止: {tool.display_name}"

    async def restart_tool(self, tool_id: str) -> tuple[bool, str]:
        """热重启工具"""
        await self.stop_tool(tool_id)
        await asyncio.sleep(0.5)
        return await self.start_tool(tool_id)

    def check_health(self, tool_id: str) -> bool:
        """检查工具健康状态"""
        tool = registry.get(tool_id)
        if not tool or not tool.pid:
            return False

        try:
            process = psutil.Process(tool.pid)
            return process.is_running()
        except psutil.NoSuchProcess:
            # 进程已死，更新状态
            registry.set_stopped(tool_id)
            return False

    async def check_all_health(self):
        """检查所有工具健康状态"""
        for tool_id in registry.get_all():
            if registry.is_running(tool_id):
                if not self.check_health(tool_id):
                    print(f"[ProcessManager] 检测到工具崩溃: {tool_id}")

    async def startup_restore(self):
        """启动时恢复上次启用的工具"""
        for tool_id, tool in registry.get_all().items():
            if tool.enabled:
                print(f"[ProcessManager] 恢复启动: {tool_id}")
                success, msg = await self.start_tool(tool_id)
                if not success:
                    print(f"[ProcessManager] 恢复失败: {msg}")

    async def shutdown_all(self):
        """关闭所有工具"""
        for tool_id in list(registry.get_all().keys()):
            if registry.is_running(tool_id):
                await self.stop_tool(tool_id)


# 全局进程管理器实例
process_manager = ProcessManager()
