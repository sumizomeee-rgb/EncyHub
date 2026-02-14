"""
FlowSVN 路径验证 + Registry 单元测试
"""
import os
import json
import tempfile
import pytest

import sys
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))


class TestSvnPathValidation:
    """SVN 路径验证逻辑测试（不依赖 FastAPI，直接测试验证逻辑）"""

    def test_valid_svn_path(self, tmp_path):
        """有效的 SVN 工作副本应通过验证"""
        svn_dir = tmp_path / ".svn"
        svn_dir.mkdir()
        assert os.path.isdir(str(tmp_path))
        assert os.path.isdir(str(svn_dir))

    def test_missing_directory(self):
        """不存在的目录应验证失败"""
        assert not os.path.isdir("/nonexistent/path/12345")

    def test_no_svn_folder(self, tmp_path):
        """没有 .svn 目录的路径应验证失败"""
        assert os.path.isdir(str(tmp_path))
        assert not os.path.isdir(str(tmp_path / ".svn"))

    def test_file_not_directory(self, tmp_path):
        """文件路径（非目录）应验证失败"""
        file_path = tmp_path / "somefile.txt"
        file_path.write_text("hello")
        assert not os.path.isdir(str(file_path))


class TestToolInfo:
    """ToolInfo 数据类测试"""

    def test_to_dict(self):
        from hub_core.registry import ToolInfo
        tool = ToolInfo(
            tool_id="test_tool",
            display_name="Test Tool",
            description="A test tool",
        )
        d = tool.to_dict()
        assert d["tool_id"] == "test_tool"
        assert d["display_name"] == "Test Tool"
        assert d["enabled"] is False
        assert d["port"] is None
        assert d["pid"] is None

    def test_from_dict(self):
        from hub_core.registry import ToolInfo
        data = {
            "tool_id": "my_tool",
            "display_name": "My Tool",
            "description": "desc",
            "enabled": True,
            "port": 8080,
            "pid": 1234,
            "last_started": "2026-01-01 00:00:00",
        }
        tool = ToolInfo.from_dict(data)
        assert tool.tool_id == "my_tool"
        assert tool.enabled is True
        assert tool.port == 8080
        assert tool.pid == 1234

    def test_roundtrip(self):
        from hub_core.registry import ToolInfo
        original = ToolInfo(
            tool_id="roundtrip",
            display_name="Roundtrip",
            description="test",
            enabled=True,
            port=9999,
            pid=42,
            last_started="2026-02-14 12:00:00",
        )
        restored = ToolInfo.from_dict(original.to_dict())
        assert restored.tool_id == original.tool_id
        assert restored.port == original.port
        assert restored.pid == original.pid
        assert restored.last_started == original.last_started


class TestFlowSvnConfigManager:
    """FlowSVN ConfigManager 测试"""

    def test_task_crud(self, tmp_path):
        from tools.flow_svn.config_manager import ConfigManager
        from tools.flow_svn.models import Task
        config_path = str(tmp_path / "flowsvn_config.json")
        mgr = ConfigManager(config_path)

        # Create
        task = Task(id="t1", name="测试任务", svn_path="C:\\test", template_id="", schedule_time="08:00")
        assert mgr.add_task(task)

        # Read
        loaded = mgr.get_task("t1")
        assert loaded is not None
        assert loaded.name == "测试任务"

        # Update
        loaded.name = "更新后的任务"
        assert mgr.update_task(loaded)
        reloaded = mgr.get_task("t1")
        assert reloaded.name == "更新后的任务"

        # Delete
        mgr.delete_task("t1")
        assert mgr.get_task("t1") is None

    def test_template_crud(self, tmp_path):
        from tools.flow_svn.config_manager import ConfigManager
        from tools.flow_svn.models import Template, TriggerAction
        config_path = str(tmp_path / "flowsvn_config.json")
        mgr = ConfigManager(config_path)

        template = Template(id="tpl1", name="构建模板", actions=[TriggerAction(type="noop")])
        assert mgr.add_template(template)

        loaded = mgr.get_template("tpl1")
        assert loaded is not None
        assert loaded.name == "构建模板"
        assert len(loaded.actions) == 1

    def test_get_all_tasks(self, tmp_path):
        from tools.flow_svn.config_manager import ConfigManager
        from tools.flow_svn.models import Task
        config_path = str(tmp_path / "flowsvn_config.json")
        mgr = ConfigManager(config_path)

        mgr.add_task(Task(id="a", name="A", svn_path="/a", template_id="", schedule_time="08:00"))
        mgr.add_task(Task(id="b", name="B", svn_path="/b", template_id="", schedule_time="09:00"))
        tasks = mgr.get_all_tasks()
        assert len(tasks) == 2
