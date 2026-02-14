"""
EncyHub 工具注册表
"""
import json
from pathlib import Path
from typing import Optional
from dataclasses import dataclass, field, asdict
from datetime import datetime

from .config import REGISTRY_FILE, DATA_DIR


@dataclass
class ToolInfo:
    """工具信息"""
    tool_id: str
    display_name: str
    description: str
    enabled: bool = False  # 上次状态（记忆）
    port: Optional[int] = None  # 运行时端口
    pid: Optional[int] = None  # 运行时 PID
    last_started: Optional[str] = None

    def to_dict(self) -> dict:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: dict) -> "ToolInfo":
        return cls(**data)


# 默认工具配置
DEFAULT_TOOLS = {
    "adb_master": ToolInfo(
        tool_id="adb_master",
        display_name="ADB Master",
        description="Android 设备管理工具",
    ),
    "flow_svn": ToolInfo(
        tool_id="flow_svn",
        display_name="FlowSVN",
        description="SVN 定时更新 + 触发器自动化",
    ),
    "gm_console": ToolInfo(
        tool_id="gm_console",
        display_name="GM Console",
        description="游戏 GM 控制台",
    ),
}


class Registry:
    """工具注册表管理"""

    def __init__(self):
        self._tools: dict[str, ToolInfo] = {}
        self._load()

    def _load(self):
        """加载注册表"""
        if REGISTRY_FILE.exists():
            try:
                data = json.loads(REGISTRY_FILE.read_text(encoding="utf-8"))
                for tool_id, tool_data in data.items():
                    # 清除运行时状态
                    tool_data["port"] = None
                    tool_data["pid"] = None
                    self._tools[tool_id] = ToolInfo.from_dict(tool_data)
            except Exception as e:
                print(f"[Registry] 加载注册表失败: {e}")
                self._tools = {}

        # 合并默认工具
        for tool_id, default_tool in DEFAULT_TOOLS.items():
            if tool_id not in self._tools:
                self._tools[tool_id] = default_tool
                # 创建工具数据目录
                (DATA_DIR / tool_id).mkdir(parents=True, exist_ok=True)

        self._save()

    def _save(self):
        """保存注册表"""
        data = {tool_id: tool.to_dict() for tool_id, tool in self._tools.items()}
        REGISTRY_FILE.parent.mkdir(parents=True, exist_ok=True)
        REGISTRY_FILE.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")

    def get(self, tool_id: str) -> Optional[ToolInfo]:
        """获取工具信息"""
        return self._tools.get(tool_id)

    def get_all(self) -> dict[str, ToolInfo]:
        """获取所有工具"""
        return self._tools.copy()

    def update(self, tool_id: str, **kwargs):
        """更新工具信息"""
        if tool_id in self._tools:
            tool = self._tools[tool_id]
            for key, value in kwargs.items():
                if hasattr(tool, key):
                    setattr(tool, key, value)
            self._save()

    def set_running(self, tool_id: str, port: int, pid: int):
        """设置工具为运行状态"""
        self.update(
            tool_id,
            port=port,
            pid=pid,
            enabled=True,
            last_started=datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        )

    def set_stopped(self, tool_id: str):
        """设置工具为停止状态"""
        self.update(tool_id, port=None, pid=None, enabled=False)

    def is_running(self, tool_id: str) -> bool:
        """检查工具是否运行中"""
        tool = self.get(tool_id)
        return tool is not None and tool.pid is not None


# 全局注册表实例
registry = Registry()
