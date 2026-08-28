"""
EncyHub 全局配置
"""
from pathlib import Path
import socket

# 路径配置
ROOT_DIR = Path(__file__).resolve().parent.parent
TOOLS_DIR = ROOT_DIR / "tools"
DATA_DIR = ROOT_DIR / "data"
ASSETS_DIR = ROOT_DIR / "assets"
LOGS_DIR = ROOT_DIR / "logs"
FRONTEND_DIST = ROOT_DIR / "frontend" / "dist"

# 注册表文件
REGISTRY_FILE = DATA_DIR / "registry.json"

# 服务配置
HUB_HOST = "0.0.0.0"
HUB_PORT = 9524

# 约定的重启退出码：Hub 以此退出码退出时，由唯一的外层启动脚本负责重新拉起
# （Windows: start.bat；Linux: start.sh 或 systemd Restart=on-failure）
# start.bat / start.sh 中的退出码判断必须与此一致，见 tests/test_restart_hub.py 契约测试
RESTART_EXIT_CODE = 42

# 确保目录存在
DATA_DIR.mkdir(parents=True, exist_ok=True)
LOGS_DIR.mkdir(parents=True, exist_ok=True)

# 为每个工具创建独立的日志目录
TOOL_IDS = ["adb_master", "flow_svn", "gm_console", "ios_master"]
for tool_id in TOOL_IDS:
    (LOGS_DIR / tool_id).mkdir(parents=True, exist_ok=True)


def get_tool_log_path(tool_id: str) -> Path:
    """获取工具日志文件路径（带时间戳）"""
    from datetime import datetime
    tool_log_dir = LOGS_DIR / tool_id
    tool_log_dir.mkdir(parents=True, exist_ok=True)
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    return tool_log_dir / f"{timestamp}.log"


def find_free_port() -> int:
    """查找可用端口"""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]
