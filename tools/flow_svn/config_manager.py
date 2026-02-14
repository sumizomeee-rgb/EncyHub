"""Configuration manager for FlowSVN - handles JSON persistence"""
import json
import os
import sys
from pathlib import Path
from typing import List, Optional, Dict, Any
from .models import Task, Template
import shutil


class ConfigManager:
    """Manages FlowSVN configuration stored in JSON"""
    
    def __init__(self, config_path: str = None):
        """
        Initialize configuration manager
        
        Args:
            config_path: Path to config.json. Defaults to data/config.json
        """
        if config_path is None:
            # Determine base directory:
            # If frozen (EXE), use the directory of the executable
            # If not frozen (source), use the project root
            if getattr(sys, 'frozen', False):
                # Running as a bundled executable
                base_dir = Path(sys.executable).parent
                # If we are in 'dist' directory during development, 
                # we might want to look one level up to share data with source
                if base_dir.name.lower() == 'dist':
                    parent_dir = base_dir.parent
                    if (parent_dir / "flowsvn").exists():
                        base_dir = parent_dir
            else:
                # Running from source
                base_dir = Path(__file__).parent.parent
            
            config_path = base_dir / "data" / "config.json"
        
        self.config_path = Path(config_path)
        self.config_path.parent.mkdir(parents=True, exist_ok=True)
        
        # Initialize with empty config if not exists
        if not self.config_path.exists():
            self._create_default_config()
        
        self.config = self._load_config()
    
    def _create_default_config(self):
        """Create default configuration file"""
        default_config = {
            "settings": {
                "svn_idle_timeout": 300,  # 5 minutes
                "svn_max_timeout": 7200   # 2 hours
            },
            "tasks": [],
            "templates": []
        }
        self._atomic_save(default_config)
    
    def _load_config(self) -> Dict[str, Any]:
        """Load configuration from JSON file"""
        try:
            with open(self.config_path, 'r', encoding='utf-8') as f:
                config = json.load(f)
                
            # Ensure settings exist (migration for old configs)
            if "settings" not in config:
                config["settings"] = {
                    "svn_idle_timeout": 300,
                    "svn_max_timeout": 7200
                }
                # We don't save immediately to avoid write churn, 
                # but it will be saved on next update
            
            return config
        except json.JSONDecodeError as e:
            raise ValueError(f"Invalid JSON in config file: {e}")
        except Exception as e:
            raise IOError(f"Failed to load config: {e}")

    def get_setting(self, key: str, default: Any = None) -> Any:
        """Get a global setting value"""
        return self.config.get("settings", {}).get(key, default)

    
    def _atomic_save(self, config: Dict[str, Any]):
        """
        Atomically save configuration using temp file + rename
        Prevents corruption if program crashes during write
        """
        temp_path = self.config_path.with_suffix('.tmp')
        try:
            with open(temp_path, 'w', encoding='utf-8') as f:
                json.dump(config, f, indent=2, ensure_ascii=False)
            
            # Atomic rename
            shutil.move(str(temp_path), str(self.config_path))
        except Exception as e:
            if temp_path.exists():
                temp_path.unlink()
            raise IOError(f"Failed to save config: {e}")
    
    def save(self):
        """Save current configuration to disk"""
        self._atomic_save(self.config)
    
    # ==================== Task Management ====================
    
    def get_all_tasks(self) -> List[Task]:
        """Get all tasks (reloads from disk to get latest status)"""
        # Always reload to get latest status/logs from disk
        self.config = self._load_config()
        return [Task.from_dict(t) for t in self.config.get("tasks", [])]
    
    def get_task(self, task_id: str) -> Optional[Task]:
        """Get task by ID"""
        for task_dict in self.config.get("tasks", []):
            if task_dict["id"] == task_id:
                return Task.from_dict(task_dict)
        return None
    
    def add_task(self, task: Task) -> bool:
        """
        Add a new task
        
        Returns:
            True if successful, False if task ID already exists
        """
        if self.get_task(task.id) is not None:
            return False
        
        self.config.setdefault("tasks", []).append(task.to_dict())
        self.save()
        return True
    
    def update_task(self, task: Task) -> bool:
        """
        Update an existing task
        
        Returns:
            True if successful, False if task not found
        """
        tasks = self.config.get("tasks", [])
        for i, t in enumerate(tasks):
            if t["id"] == task.id:
                tasks[i] = task.to_dict()
                self.save()
                return True
        return False
    
    def delete_task(self, task_id: str) -> bool:
        """
        Delete a task
        
        Returns:
            True if successful, False if task not found
        """
        tasks = self.config.get("tasks", [])
        original_len = len(tasks)
        self.config["tasks"] = [t for t in tasks if t["id"] != task_id]
        
        if len(self.config["tasks"]) < original_len:
            self.save()
            return True
        return False
    
    # ==================== Template Management ====================
    
    def get_all_templates(self) -> List[Template]:
        """Get all templates"""
        return [Template.from_dict(t) for t in self.config.get("templates", [])]
    
    def get_template(self, template_id: str) -> Optional[Template]:
        """Get template by ID"""
        for template_dict in self.config.get("templates", []):
            if template_dict["id"] == template_id:
                return Template.from_dict(template_dict)
        return None
    
    def add_template(self, template: Template) -> bool:
        """
        Add a new template
        
        Returns:
            True if successful, False if template ID already exists
        """
        if self.get_template(template.id) is not None:
            return False
        
        self.config.setdefault("templates", []).append(template.to_dict())
        self.save()
        return True
    
    def update_template(self, template: Template) -> bool:
        """
        Update an existing template
        
        Returns:
            True if successful, False if template not found
        """
        templates = self.config.get("templates", [])
        for i, t in enumerate(templates):
            if t["id"] == template.id:
                templates[i] = template.to_dict()
                self.save()
                return True
        return False
    
    def delete_template(self, template_id: str) -> bool:
        """
        Delete a template
        
        Returns:
            True if successful, False if template not found or in use
        """
        # Check if template is in use by any task
        for task in self.get_all_tasks():
            if task.template_id == template_id:
                return False  # Cannot delete template in use
        
        templates = self.config.get("templates", [])
        original_len = len(templates)
        self.config["templates"] = [t for t in templates if t["id"] != template_id]
        
        if len(self.config["templates"]) < original_len:
            self.save()
            return True
        return False
    
    # ==================== Path Conflict Detection ====================
    
    def check_path_conflict(self, new_path: str, exclude_task_id: str = None) -> Optional[str]:
        """
        Check if new path conflicts with existing tasks
        
        A conflict occurs when:
        - new_path is a parent of an existing path
        - new_path is a child of an existing path
        
        Args:
            new_path: Path to check
            exclude_task_id: Task ID to exclude from check (for updates)
        
        Returns:
            Conflicting task name if conflict found, None otherwise
        """
        new_path_obj = Path(new_path).resolve()
        
        for task in self.get_all_tasks():
            if exclude_task_id and task.id == exclude_task_id:
                continue
            
            existing_path = Path(task.svn_path).resolve()
            
            # Check if one path is a parent of the other
            try:
                new_path_obj.relative_to(existing_path)
                return task.name  # new_path is child of existing
            except ValueError:
                pass
            
            try:
                existing_path.relative_to(new_path_obj)
                return task.name  # existing is child of new_path
            except ValueError:
                pass
        
        return None
