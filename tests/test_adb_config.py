"""
ADB Master ConfigManager 单元测试
"""
import os
import json
import tempfile
import pytest

# 直接导入 ConfigManager 类
import sys
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
from tools.adb_master.config_manager import ConfigManager


@pytest.fixture
def config_mgr(tmp_path):
    """创建临时 ConfigManager 实例"""
    config_path = str(tmp_path / "test_config.json")
    return ConfigManager(config_path)


class TestDeviceConfig:
    """设备配置测试"""

    def test_get_empty_config(self, config_mgr):
        result = config_mgr.get_device_config("abc123")
        assert result == {}

    def test_set_and_get_nickname(self, config_mgr):
        config_mgr.set_device_config("device_001", nickname="我的手机")
        result = config_mgr.get_device_config("device_001")
        assert result["nickname"] == "我的手机"

    def test_update_existing_config(self, config_mgr):
        config_mgr.set_device_config("device_001", nickname="旧名称")
        config_mgr.set_device_config("device_001", nickname="新名称")
        result = config_mgr.get_device_config("device_001")
        assert result["nickname"] == "新名称"

    def test_multiple_devices(self, config_mgr):
        config_mgr.set_device_config("dev_a", nickname="设备A")
        config_mgr.set_device_config("dev_b", nickname="设备B")
        assert config_mgr.get_device_config("dev_a")["nickname"] == "设备A"
        assert config_mgr.get_device_config("dev_b")["nickname"] == "设备B"

    def test_hardware_id_sanitization(self, config_mgr):
        """硬件 ID 中的特殊字符应被替换"""
        config_mgr.set_device_config("192.168.1.100:5555", nickname="WiFi设备")
        result = config_mgr.get_device_config("192.168.1.100:5555")
        assert result["nickname"] == "WiFi设备"

    def test_persistence(self, tmp_path):
        """配置应持久化到文件"""
        config_path = str(tmp_path / "persist_test.json")
        mgr1 = ConfigManager(config_path)
        mgr1.set_device_config("dev1", nickname="持久化测试")

        # 创建新实例读取同一文件
        mgr2 = ConfigManager(config_path)
        result = mgr2.get_device_config("dev1")
        assert result["nickname"] == "持久化测试"


class TestPathHistory:
    """路径历史测试"""

    def test_empty_history(self, config_mgr):
        result = config_mgr.get_path_history("push")
        assert result == []

    def test_add_push_history(self, config_mgr):
        config_mgr.add_path_history("/sdcard/Download/", "push")
        result = config_mgr.get_path_history("push")
        assert len(result) == 1
        assert result[0] == "/sdcard/Download/"

    def test_add_pull_history(self, config_mgr):
        config_mgr.add_path_history("/sdcard/DCIM/photo.jpg", "pull")
        result = config_mgr.get_path_history("pull")
        assert len(result) == 1
        assert result[0] == "/sdcard/DCIM/photo.jpg"

    def test_deduplication(self, config_mgr):
        """重复路径应去重并置顶"""
        config_mgr.add_path_history("/sdcard/a/", "push")
        config_mgr.add_path_history("/sdcard/b/", "push")
        config_mgr.add_path_history("/sdcard/a/", "push")  # 重复
        result = config_mgr.get_path_history("push")
        assert len(result) == 2
        assert result[0] == "/sdcard/a/"  # 最近使用的在前
        assert result[1] == "/sdcard/b/"

    def test_max_items_limit(self, config_mgr):
        """历史记录应限制最大条数"""
        for i in range(25):
            config_mgr.add_path_history(f"/path/{i}", "push", max_items=20)
        result = config_mgr.get_path_history("push")
        assert len(result) == 20
        # 最新的应在前面
        assert result[0] == "/path/24"

    def test_push_pull_independent(self, config_mgr):
        """push 和 pull 历史应独立"""
        config_mgr.add_path_history("/push/path", "push")
        config_mgr.add_path_history("/pull/path", "pull")
        assert len(config_mgr.get_path_history("push")) == 1
        assert len(config_mgr.get_path_history("pull")) == 1
        assert config_mgr.get_path_history("push")[0] == "/push/path"
        assert config_mgr.get_path_history("pull")[0] == "/pull/path"

    def test_corrupted_config_recovery(self, tmp_path):
        """损坏的配置文件应能恢复"""
        config_path = str(tmp_path / "corrupt.json")
        with open(config_path, 'w') as f:
            f.write("{invalid json")

        mgr = ConfigManager(config_path)
        result = mgr.get_path_history("push")
        assert result == []
        # 应该能正常写入
        mgr.add_path_history("/test", "push")
        assert len(mgr.get_path_history("push")) == 1
