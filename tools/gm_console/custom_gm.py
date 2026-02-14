"""
GM Console - 自定义命令管理
"""
import json
import os
from typing import List, Dict, Any


class CustomGmManager:
    """自定义 GM 命令管理器"""

    def __init__(self, data_dir: str):
        self.file_path = os.path.join(data_dir, "custom_gm.json")
        self.commands: List[Dict[str, str]] = self._load()

    def _load(self) -> List[Dict[str, str]]:
        """加载命令列表"""
        if not os.path.exists(self.file_path):
            return []
        try:
            with open(self.file_path, 'r', encoding='utf-8') as f:
                return json.load(f)
        except:
            return []

    def _save(self):
        """保存命令列表"""
        try:
            os.makedirs(os.path.dirname(self.file_path), exist_ok=True)
            with open(self.file_path, 'w', encoding='utf-8') as f:
                json.dump(self.commands, f, indent=2, ensure_ascii=False)
        except Exception as e:
            print(f"[CustomGmManager] 保存失败: {e}")

    def get_all(self) -> List[Dict[str, str]]:
        """获取所有命令"""
        return self.commands.copy()

    def add(self, name: str, cmd: str) -> Dict[str, str]:
        """添加命令"""
        item = {"name": name, "cmd": cmd}
        self.commands.append(item)
        self._save()
        return item

    def delete(self, index: int) -> bool:
        """删除命令"""
        if 0 <= index < len(self.commands):
            self.commands.pop(index)
            self._save()
            return True
        return False

    def edit(self, index: int, name: str, cmd: str) -> bool:
        """编辑命令"""
        if 0 <= index < len(self.commands):
            self.commands[index] = {"name": name, "cmd": cmd}
            self._save()
            return True
        return False
