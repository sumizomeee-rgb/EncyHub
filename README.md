# EncyHub

开发工具聚合平台 - 将分散的开发工具统一管理，采用现代前端技术栈（React + Tailwind），便于 AI 辅助开发和维护。

## 功能特性

- 🔧 **工具聚合**：统一管理多个开发工具，告别目录翻找
- 🚀 **热重启**：修改工具代码后，单独重启该工具即可生效
- 🌐 **内网访问**：支持局域网内其他设备访问
- 📦 **独立打包**：各工具保留独立 build.py，可单独打包成 EXE
- 🎨 **现代 UI**：React + Tailwind CSS，AI 友好

## 集成工具

| 工具 | 功能 |
|------|------|
| **ADB Master** | Android 设备管理（Logcat、文件传输、APK 安装） |
| **FlowSVN** | SVN 定时更新 + 触发器自动化 |
| **GM Console** | 游戏 GM 控制台（TCP 服务器 + Lua 执行） |

## 快速开始

### 环境要求

- Python 3.10+
- Node.js 18+
- [uv](https://docs.astral.sh/uv/) (Python 包管理器)

### 启动

```bash
# Windows
start.bat

# 或手动启动
uv sync
cd frontend && npm install && npm run build && cd ..
uv run main.py
```

启动后访问：
- 本机：http://localhost:9524
- 内网：http://[本机IP]:9524

## 目录结构

```
EncyHub/
├── main.py                 # 平台入口
├── pyproject.toml          # Python 依赖
├── start.bat               # 启动脚本
├── hub_core/               # 平台核心模块
│   ├── config.py           # 全局配置
│   ├── registry.py         # 工具注册表
│   ├── process_manager.py  # 进程管理
│   └── api.py              # 平台 API
├── tools/                  # 工具后端模块
│   ├── adb_master/
│   ├── flow_svn/
│   └── gm_console/
├── frontend/               # React 前端
├── data/                   # 运行时数据
├── assets/                 # 静态资源
└── logs/                   # 日志目录
```

## API 文档

启动后访问 http://localhost:9524/docs 查看 Swagger API 文档。

### 平台 API

| 端点 | 方法 | 功能 |
|------|------|------|
| `/api/hub/tools` | GET | 获取所有工具状态 |
| `/api/hub/tools/{id}/start` | POST | 启动工具 |
| `/api/hub/tools/{id}/stop` | POST | 停止工具 |
| `/api/hub/tools/{id}/restart` | POST | 热重启工具 |
| `/api/hub/tools/{id}/logs` | GET | 获取工具日志 |

### 工具 API

各工具的 API 通过代理访问：`/api/{tool_id}/...`

## 开发指南

### 添加新工具

1. 在 `tools/` 下创建工具目录
2. 创建 `main.py`（FastAPI 入口）
3. 在 `hub_core/registry.py` 的 `DEFAULT_TOOLS` 中注册
4. 创建对应的前端页面

### 工具入口模板

```python
# tools/my_tool/main.py
import os
from fastapi import FastAPI
import uvicorn

app = FastAPI(title="My Tool")

@app.get("/")
async def index():
    return {"message": "Hello from My Tool"}

if __name__ == "__main__":
    port = int(os.environ.get("PORT", 8000))
    host = os.environ.get("HOST", "0.0.0.0")
    uvicorn.run(app, host=host, port=port)
```

## 许可证

MIT License
