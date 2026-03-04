"""
Configuration Manager for Kuro ADB Master.
Handles persistent storage of device-specific settings.
"""

import json
import os
from typing import Optional, Dict, Any


class ConfigManager:
    """设备配置管理器"""

    def __init__(self, config_path: str):
        self.config_path = config_path
        os.makedirs(os.path.dirname(config_path), exist_ok=True)

    def _load(self) -> Dict[str, Any]:
        """加载配置"""
        if os.path.exists(self.config_path):
            try:
                with open(self.config_path, 'r', encoding='utf-8') as f:
                    return json.load(f)
            except (json.JSONDecodeError, IOError):
                return {'devices': {}}
        return {'devices': {}}

    def _save(self, config: Dict[str, Any]) -> bool:
        """保存配置"""
        try:
            with open(self.config_path, 'w', encoding='utf-8') as f:
                json.dump(config, f, indent=2, ensure_ascii=False)
            return True
        except IOError:
            return False

    def get_device_config(self, hardware_id: str) -> Dict[str, Any]:
        """获取设备配置"""
        config = self._load()
        safe_id = hardware_id.replace(':', '_').replace('.', '_')
        return config.get('devices', {}).get(safe_id, {})

    def set_device_config(self, hardware_id: str, **kwargs) -> bool:
        """设置设备配置"""
        config = self._load()
        safe_id = hardware_id.replace(':', '_').replace('.', '_')

        if 'devices' not in config:
            config['devices'] = {}

        if safe_id not in config['devices']:
            config['devices'][safe_id] = {}

        config['devices'][safe_id].update(kwargs)
        return self._save(config)

    def get_all_known_devices(self) -> Dict[str, Dict[str, Any]]:
        """获取所有已知设备配置（hardware_id -> config）"""
        config = self._load()
        return config.get('devices', {})

    def remove_device_config(self, hardware_id: str) -> bool:
        """移除设备配置"""
        config = self._load()
        safe_id = hardware_id.replace(':', '_').replace('.', '_')
        if safe_id in config.get('devices', {}):
            del config['devices'][safe_id]
            return self._save(config)
        return False

    # 路径历史
    def get_path_history(self, category: str = "push") -> list:
        """获取路径历史 (category: push/pull)"""
        config = self._load()
        return config.get('path_history', {}).get(category, [])

    def add_path_history(self, path: str, category: str = "push", max_items: int = 20) -> bool:
        """添加路径到历史"""
        config = self._load()
        if 'path_history' not in config:
            config['path_history'] = {}
        if category not in config['path_history']:
            config['path_history'][category] = []

        history = config['path_history'][category]
        # 去重并置顶
        if path in history:
            history.remove(path)
        history.insert(0, path)
        config['path_history'][category] = history[:max_items]
        return self._save(config)
