"""
Configuration Manager for iOS Master.
Handles persistent storage of device-specific settings.
"""

import json
import os
from typing import Dict, Any


class ConfigManager:

    def __init__(self, config_path: str):
        self.config_path = config_path
        os.makedirs(os.path.dirname(config_path), exist_ok=True)

    def _load(self) -> Dict[str, Any]:
        if os.path.exists(self.config_path):
            try:
                with open(self.config_path, 'r', encoding='utf-8') as f:
                    return json.load(f)
            except (json.JSONDecodeError, IOError):
                return {'devices': {}}
        return {'devices': {}}

    def _save(self, config: Dict[str, Any]) -> bool:
        try:
            with open(self.config_path, 'w', encoding='utf-8') as f:
                json.dump(config, f, indent=2, ensure_ascii=False)
            return True
        except IOError:
            return False

    def get_device_config(self, udid: str) -> Dict[str, Any]:
        config = self._load()
        return config.get('devices', {}).get(udid, {})

    def set_device_config(self, udid: str, **kwargs) -> bool:
        config = self._load()
        if 'devices' not in config:
            config['devices'] = {}
        if udid not in config['devices']:
            config['devices'][udid] = {}
        config['devices'][udid].update(kwargs)
        return self._save(config)

    def get_all_known_devices(self) -> Dict[str, Dict[str, Any]]:
        config = self._load()
        return config.get('devices', {})

    def get_path_history(self, category: str = "push") -> list:
        config = self._load()
        return config.get('path_history', {}).get(category, [])

    def add_path_history(self, path: str, category: str = "push", max_items: int = 20) -> bool:
        config = self._load()
        if 'path_history' not in config:
            config['path_history'] = {}
        if category not in config['path_history']:
            config['path_history'][category] = []

        history = config['path_history'][category]
        if path in history:
            history.remove(path)
        history.insert(0, path)
        config['path_history'][category] = history[:max_items]
        return self._save(config)
