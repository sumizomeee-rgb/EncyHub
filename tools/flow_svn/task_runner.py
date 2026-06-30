"""Shared task execution logic for FlowSVN."""
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Callable, Optional
import time

from .config_manager import ConfigManager
from .models import Task
from .svn_executor import SVNExecutor


VALID_OPERATIONS = {"update", "cleanup"}
OPERATION_LABELS = {
    "update": "更新",
    "cleanup": "清理",
}
SUCCESS_MARKERS = {
    "update": "SVN update completed successfully",
    "cleanup": "SVN cleanup completed successfully",
}
LOG_EXCERPT_LIMIT = 8000


@dataclass
class TaskRunResult:
    """Result returned after running a FlowSVN task."""
    success: bool
    message: str
    output: str = ""
    task: Optional[Task] = None
    skipped: bool = False


def _get_timeout(config_mgr: ConfigManager, key: str, default: int) -> int:
    """Read timeout settings defensively from config."""
    value = config_mgr.get_setting(key, default)
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _normalize_operation(operation: str) -> str:
    """Return a supported task operation, defaulting old/invalid configs to update."""
    if operation in VALID_OPERATIONS:
        return operation
    return "update"


def _get_task_log_dir(config_mgr: ConfigManager) -> Path:
    """Resolve the directory used for full task run logs."""
    try:
        root_dir = config_mgr.config_path.parent.parent.parent
    except Exception:
        root_dir = Path.cwd()

    log_dir = root_dir / "logs" / "flow_svn" / "task_runs"
    log_dir.mkdir(parents=True, exist_ok=True)
    return log_dir


def _write_full_log(config_mgr: ConfigManager, task: Task, operation: str, output: str) -> str:
    """Persist full task output so scheduler stdout is not the only copy."""
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    safe_task_id = "".join(ch for ch in task.id if ch.isalnum() or ch in ("-", "_")) or "task"
    log_path = _get_task_log_dir(config_mgr) / f"{timestamp}_{safe_task_id}_{operation}.log"
    log_path.write_text(output, encoding="utf-8", errors="replace")
    return str(log_path)


def _build_log_excerpt(output: str, limit: int = LOG_EXCERPT_LIMIT) -> str:
    """Keep both the beginning and the error tail in config/UI logs."""
    if len(output) <= limit:
        return output

    head_len = limit // 3
    tail_len = limit - head_len
    omitted = len(output) - head_len - tail_len
    return (
        output[:head_len]
        + f"\n\n--- FlowSVN log truncated: omitted {omitted} chars; showing tail below ---\n\n"
        + output[-tail_len:]
    )


def run_task_by_id(
    config_mgr: ConfigManager,
    task_id: str,
    svn_executor: SVNExecutor | None = None,
    stream: Callable[[str], None] | None = None,
    respect_enabled: bool = True,
) -> TaskRunResult:
    """
    Run a configured FlowSVN task by ID.

    Args:
        config_mgr: FlowSVN configuration manager.
        task_id: Task ID to run.
        svn_executor: Optional executor instance for dependency injection.
        stream: Optional callback for each output line.
        respect_enabled: If true, disabled tasks are skipped.
    """
    task = config_mgr.get_task(task_id)
    if not task:
        return TaskRunResult(False, f"任务不存在: {task_id}")

    if respect_enabled and not task.enabled:
        return TaskRunResult(True, f"任务已禁用: {task.name}", task=task, skipped=True)

    executor = svn_executor or SVNExecutor()
    operation = _normalize_operation(task.operation)
    label = OPERATION_LABELS[operation]
    idle_timeout = _get_timeout(config_mgr, "svn_idle_timeout", 300)
    max_timeout = _get_timeout(config_mgr, "svn_max_timeout", 7200)

    start_time = time.time()
    task.update_status("running", f"{label}任务开始执行")
    config_mgr.update_task(task)

    output_lines: list[str] = []
    try:
        if operation == "cleanup":
            line_iter = executor.execute_cleanup(task.svn_path, idle_timeout, max_timeout)
        else:
            line_iter = executor.execute_update(task.svn_path, idle_timeout, max_timeout)

        for line in line_iter:
            if stream:
                stream(line)
            output_lines.append(line)
    except Exception as e:
        output_lines.append(f"ERROR: {str(e)}")

    output = "\n".join(output_lines)
    duration = time.time() - start_time
    success_marker = SUCCESS_MARKERS[operation]
    success = bool(output_lines and success_marker in output_lines[-1])
    log_path = _write_full_log(config_mgr, task, operation, output)
    log_excerpt = _build_log_excerpt(output)

    task.update_status("success" if success else "failed", log_excerpt, duration, log_path=log_path)
    config_mgr.update_task(task)

    message = f"{label}任务执行完成" if success else f"{label}任务执行失败"
    return TaskRunResult(success, message, output, task)
