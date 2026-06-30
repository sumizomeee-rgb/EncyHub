"""
FlowSVN CLI - 独立执行脚本，用于 Windows 任务计划
"""
import argparse
import os
import sys
from pathlib import Path

# Add project root to path
PROJECT_ROOT = Path(__file__).parent.parent.parent
sys.path.insert(0, str(PROJECT_ROOT))

from tools.flow_svn.config_manager import ConfigManager
from tools.flow_svn.task_runner import run_task_by_id as run_configured_task


def run_task_by_id(task_id: str):
    """通过任务 ID 执行任务"""
    # 设置 DATA_DIR
    data_dir = PROJECT_ROOT / "data" / "flow_svn"
    os.makedirs(data_dir, exist_ok=True)
    config_path = data_dir / "config.json"

    config_mgr = ConfigManager(str(config_path))
    result = run_configured_task(
        config_mgr=config_mgr,
        task_id=task_id,
        stream=print,
        respect_enabled=True,
    )

    if not result.task:
        print(f"错误: {result.message}", file=sys.stderr)
        return 1

    if result.skipped:
        print(f"警告: {result.message}", file=sys.stderr)
        return 0

    print(f"\n任务执行完成: {result.task.name} (状态: {result.task.last_status})")
    return 0 if result.success else 1


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
