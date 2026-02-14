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

# 确保目录存在
DATA_DIR.mkdir(parents=True, exist_ok=True)
LOGS_DIR.mkdir(parents=True, exist_ok=True)

# 为每个工具创建独立的日志目录
TOOL_IDS = ["adb_master", "flow_svn", "gm_console"]
for tool_id in TOOL_IDS:
    (LOGS_DIR / tool_id).mkdir(parents=True, exist_ok=True)


def get_tool_log_path(tool_id: str) -> Path:
    """获取工具日志文件路径（带时间戳）"""
    from datetime import datetime
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    return LOGS_DIR / tool_id / f"{timestamp}.log"


def find_free_port() -> int:
    """查找可用端口"""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]
