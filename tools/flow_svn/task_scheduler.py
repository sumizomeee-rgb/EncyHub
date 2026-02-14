"""Windows Task Scheduler integration for FlowSVN"""
import subprocess
import sys
from pathlib import Path
from typing import List, Optional, Tuple
from datetime import datetime
import xml.etree.ElementTree as ET


class TaskScheduler:
    """Manages Windows Task Scheduler integration"""
    
    TASK_PREFIX = "FlowSVN_"
    
    def __init__(self):
        """Initialize task scheduler"""
        # Get path to Python executable and flowsvn script
        if getattr(sys, "frozen", False):
            # Running as EXE
            self.python_exe = sys.executable
            self.is_frozen = True
            # Script path is not needed when running as EXE
            self.script_path = None
        else:
            # Running from source
            self.python_exe = sys.executable
            self.script_path = Path(__file__).parent.parent / "flowsvn.py"
            self.is_frozen = False
    
    def create_task(self, task_id: str, task_name: str, schedule_time: str) -> Tuple[bool, str]:
        """
        Create a scheduled task in Windows Task Scheduler
        
        Args:
            task_id: UUID of the task
            task_name: Human-readable task name
            schedule_time: Schedule time in HH:mm format
        
        Returns:
            (success: bool, message: str)
        """
        scheduler_task_name = f"{self.TASK_PREFIX}{task_name}_{task_id[:8]}"
        
        try:
            # Parse schedule time
            hour, minute = schedule_time.split(":")
            
            # Build command to execute
            if self.is_frozen:
                command = f'"{self.python_exe}" run-id {task_id}'
            else:
                command = f'"{self.python_exe}" "{self.script_path}" run-id {task_id}'
            
            # Create task using schtasks
            # /SC DAILY = daily schedule
            # /ST = start time
            # /TN = task name
            # /TR = task run (command)
            cmd = [
                "schtasks",
                "/Create",
                "/SC", "DAILY",
                "/TN", scheduler_task_name,
                "/TR", command,
                "/ST", schedule_time,
                "/F"  # Force create (overwrite if exists)
            ]
            
            result = subprocess.run(
                cmd,
                capture_output=True,
                text=True,
                check=False
            )
            
            if result.returncode == 0:
                return True, f"Task created: {scheduler_task_name}"
            else:
                return False, f"Failed to create task: {result.stderr}"
                
        except Exception as e:
            return False, f"Error creating task: {str(e)}"
    
    def delete_task(self, task_id: str, task_name: str) -> Tuple[bool, str]:
        """
        Delete a scheduled task from Windows Task Scheduler
        
        Args:
            task_id: UUID of the task
            task_name: Human-readable task name
        
        Returns:
            (success: bool, message: str)
        """
        scheduler_task_name = f"{self.TASK_PREFIX}{task_name}_{task_id[:8]}"
        
        try:
            cmd = [
                "schtasks",
                "/Delete",
                "/TN", scheduler_task_name,
                "/F"  # Force delete without confirmation
            ]
            
            result = subprocess.run(
                cmd,
                capture_output=True,
                text=True,
                check=False
            )
            
            if result.returncode == 0:
                return True, f"Task deleted: {scheduler_task_name}"
            else:
                # Task might not exist, which is okay
                return True, f"Task removed (may not have existed): {scheduler_task_name}"
                
        except Exception as e:
            return False, f"Error deleting task: {str(e)}"
    
    def update_task(self, task_id: str, old_name: str, new_name: str, schedule_time: str) -> Tuple[bool, str]:
        """
        Update a scheduled task
        
        Args:
            task_id: UUID of the task
            old_name: Previous task name
            new_name: New task name
            schedule_time: New schedule time in HH:mm format
        
        Returns:
            (success: bool, message: str)
        """
        # Delete old task
        success, msg = self.delete_task(task_id, old_name)
        if not success:
            return False, f"Failed to delete old task: {msg}"
        
        # Create new task
        return self.create_task(task_id, new_name, schedule_time)
    
    def list_flowsvn_tasks(self) -> List[str]:
        """
        List all FlowSVN tasks in Task Scheduler
        
        Returns:
            List of task names with FlowSVN_ prefix
        """
        try:
            cmd = ["schtasks", "/Query", "/FO", "LIST", "/V"]
            result = subprocess.run(
                cmd,
                capture_output=True,
                text=True,
                check=False,
                encoding='utf-8',
                errors='ignore'
            )
            
            if result.returncode != 0:
                return []
            
            # Parse output to find FlowSVN tasks
            tasks = []
            for line in result.stdout.split('\n'):
                if 'TaskName:' in line or '任务名:' in line:  # Support both English and Chinese
                    task_name = line.split(':', 1)[1].strip()
                    if self.TASK_PREFIX in task_name:
                        # Extract just the task name without path
                        tasks.append(task_name.split('\\')[-1])
            
            return tasks
            
        except Exception as e:
            print(f"Error listing tasks: {e}")
            return []
    
    def sync_with_config(self, config_tasks: List[dict]) -> Tuple[int, int]:
        """
        Synchronize Task Scheduler with configuration
        
        Removes orphaned tasks and ensures all config tasks are scheduled
        
        Args:
            config_tasks: List of task dictionaries from config
        
        Returns:
            (tasks_added: int, tasks_removed: int)
        """
        # Get current scheduled tasks
        scheduled_tasks = set(self.list_flowsvn_tasks())
        
        # Get expected tasks from config
        expected_tasks = set()
        for task in config_tasks:
            task_name = f"{self.TASK_PREFIX}{task['name']}_{task['id'][:8]}"
            expected_tasks.add(task_name)
        
        # Remove orphaned tasks
        orphaned = scheduled_tasks - expected_tasks
        removed_count = 0
        for task in orphaned:
            # Extract task_id from name (last 8 chars before any extension)
            try:
                cmd = ["schtasks", "/Delete", "/TN", task, "/F"]
                subprocess.run(cmd, capture_output=True, check=False)
                removed_count += 1
            except:
                pass
        
        # Add missing tasks
        missing = expected_tasks - scheduled_tasks
        added_count = 0
        for task in config_tasks:
            task_name = f"{self.TASK_PREFIX}{task['name']}_{task['id'][:8]}"
            if task_name in missing:
                success, _ = self.create_task(
                    task['id'],
                    task['name'],
                    task['schedule_time']
                )
                if success:
                    added_count += 1
        
        return added_count, removed_count
