"""
FlowSVN CLI - 独立执行脚本，用于 Windows 任务计划
"""
import argparse
import os
import sys
from pathlib import Path

# Add project root to path
PROJECT_ROOT = Path(__file__).parent
sys.path.insert(0, str(PROJECT_ROOT))

from tools.flow_svn.config_manager import ConfigManager
from tools.flow_svn.svn_executor import SVNExecutor


def run_task_by_id(task_id: str):
    """通过任务 ID 执行任务"""
    import time

    # 设置 DATA_DIR
    data_dir = PROJECT_ROOT / "data" / "flow_svn"
    os.makedirs(data_dir, exist_ok=True)
    config_path = data_dir / "config.json"

    config_mgr = ConfigManager(str(config_path))
    task = config_mgr.get_task(task_id)

    if not task:
        print(f"错误: 任务不存在: {task_id}", file=sys.stderr)
        return 1

    if not task.enabled:
        print(f"警告: 任务已禁用: {task.name}", file=sys.stderr)
        return 0

    # 设置任务状态为 running
    start_time = time.time()
    task.update_status("running", "任务开始执行")
    config_mgr.update_task(task)

    # 执行 SVN 更新
    executor = SVNExecutor()
    output_lines = []
    success = False

    for line in executor.execute_update(task.svn_path):
        print(line)
        output_lines.append(line)

    # 检查最后一行来判断是否成功
    if output_lines and "SVN update completed successfully" in output_lines[-1]:
        success = True

    output = "\n".join(output_lines)
    duration = time.time() - start_time

    # 更新任务状态
    if success:
        task.update_status("success", output[:1000], duration)
    else:
        task.update_status("failed", output[:1000], duration)
    config_mgr.update_task(task)

    print(f"\n任务执行完成: {task.name} (状态: {task.last_status})")

    return 0 if success else 1


def main():
    parser = argparse.ArgumentParser(description="FlowSVN CLI")
    subparsers = parser.add_subparsers(dest="command", help="命令")

    # run-id 子命令
    run_parser = subparsers.add_parser("run-id", help="通过任务 ID 执行")
    run_parser.add_argument("task_id", help="任务 ID")

    args = parser.parse_args()

    if args.command == "run-id":
        return run_task_by_id(args.task_id)
    else:
        parser.print_help()
        return 1


if __name__ == "__main__":
    sys.exit(main())
