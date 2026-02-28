"""Data models for FlowSVN tasks and templates"""
from dataclasses import dataclass, field, asdict
from typing import List, Dict, Any, Optional
from datetime import datetime
import uuid


@dataclass
class TriggerAction:
    """Represents a single trigger action in a template"""
    type: str  # noop, kill_process, start_exe, unity_project, open_directory, shutdown, restart
    target: Optional[str] = None  # Process name for kill_process
    path: Optional[str] = None  # Path for start_exe, unity_project, open_directory
    args: Optional[str] = None  # Arguments for start_exe
    
    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary, omitting None values"""
        result = {"type": self.type}
        if self.target is not None:
            result["target"] = self.target
        if self.path is not None:
            result["path"] = self.path
        if self.args is not None:
            result["args"] = self.args
        return result
    
    @staticmethod
    def from_dict(data: Dict[str, Any]) -> 'TriggerAction':
        """Create from dictionary"""
        return TriggerAction(
            type=data["type"],
            target=data.get("target"),
            path=data.get("path"),
            args=data.get("args")
        )
    
    def validate(self) -> tuple[bool, str]:
        """Validate action configuration"""
        valid_types = ["noop", "kill_process", "start_exe", "unity_project", 
                      "open_directory", "shutdown", "restart", "focus_window", "touch_file"]
        
        if self.type not in valid_types:
            return False, f"Invalid action type: {self.type}"
        
        if self.type in ["kill_process", "focus_window"] and not self.target:
            return False, f"{self.type} requires target"
        
        if self.type in ["start_exe", "unity_project", "open_directory", "touch_file"] and not self.path:
            return False, f"{self.type} requires path"
        
        return True, "OK"


@dataclass
class Template:
    """Template containing ordered trigger actions"""
    id: str
    name: str
    actions: List[TriggerAction] = field(default_factory=list)
    
    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary for JSON serialization"""
        return {
            "id": self.id,
            "name": self.name,
            "actions": [action.to_dict() for action in self.actions]
        }
    
    @staticmethod
    def from_dict(data: Dict[str, Any]) -> 'Template':
        """Create from dictionary"""
        return Template(
            id=data["id"],
            name=data["name"],
            actions=[TriggerAction.from_dict(a) for a in data.get("actions", [])]
        )
    
    @staticmethod
    def create_new(name: str) -> 'Template':
        """Create a new template with generated UUID"""
        return Template(
            id=str(uuid.uuid4()),
            name=name
        )
    
    def validate(self) -> tuple[bool, str]:
        """Validate all actions in template"""
        for i, action in enumerate(self.actions):
            valid, msg = action.validate()
            if not valid:
                return False, f"Action {i}: {msg}"
        return True, "OK"


@dataclass
class Task:
    """SVN automation task"""
    id: str
    name: str
    svn_path: str
    template_id: str
    schedule_time: str  # HH:mm format
    enabled: bool = True  # Whether the task is enabled
    last_run: Optional[str] = None  # ISO8601 timestamp
    last_status: str = "pending"  # pending, success, failed, running
    last_log: str = ""
    execution_history: List[Dict[str, Any]] = field(default_factory=list)  # History of all executions
    total_runs: int = 0  # Total number of executions

    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary for JSON serialization"""
        return {
            "id": self.id,
            "name": self.name,
            "svn_path": self.svn_path,
            "template_id": self.template_id,
            "schedule_time": self.schedule_time,
            "enabled": self.enabled,
            "last_run": self.last_run,
            "last_status": self.last_status,
            "last_log": self.last_log,
            "execution_history": self.execution_history,
            "total_runs": self.total_runs
        }

    @staticmethod
    def from_dict(data: Dict[str, Any]) -> 'Task':
        """Create from dictionary"""
        return Task(
            id=data["id"],
            name=data["name"],
            svn_path=data["svn_path"],
            template_id=data["template_id"],
            schedule_time=data["schedule_time"],
            enabled=data.get("enabled", True),
            last_run=data.get("last_run"),
            last_status=data.get("last_status", "pending"),
            last_log=data.get("last_log", ""),
            execution_history=data.get("execution_history", []),
            total_runs=data.get("total_runs", 0)
        )

    @staticmethod
    def create_new(name: str, svn_path: str, template_id: str, schedule_time: str) -> 'Task':
        """Create a new task with generated UUID"""
        return Task(
            id=str(uuid.uuid4()),
            name=name,
            svn_path=svn_path,
            template_id=template_id,
            schedule_time=schedule_time
        )
    
    def update_status(self, status: str, log: str = "", duration_seconds: float = 0):
        """Update task execution status and add to history"""
        now = datetime.now().isoformat()
        self.last_run = now
        self.last_status = status
        self.last_log = log
        
        # Add to execution history (keep last 20 records)
        history_entry = {
            "time": now,
            "status": status,
            "duration": duration_seconds,
            "message": log[:200] if log else ""  # Store preview only
        }
        self.execution_history.insert(0, history_entry)
        if len(self.execution_history) > 20:
            self.execution_history = self.execution_history[:20]
        
        # Increment total runs if completed (success or failed)
        if status in ["success", "failed"]:
            self.total_runs += 1

