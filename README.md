# EncyHub 🛠️

**开发工具聚合平台** - 为游戏开发、测试与运维打造的一站式工具箱。

EncyHub 将分散的开发工具（如 ADB 管理、SVN 自动化、GM 指令台）统一整合到一个现代化的 Web 界面中。基于 **FastAPI (Python)** 和 **React (Vite + Tailwind CSS)** 构建，支持插件化扩展、热重启和内网访问，是提升团队效率的理想选择。

![License](https://img.shields.io/badge/license-MIT-blue.svg)
![Python](https://img.shields.io/badge/backend-FastAPI-green.svg)
![React](https://img.shields.io/badge/frontend-React-61DAFB.svg)

---

## ✨ 核心特性

- **🔌 统一入口**：在一个网页中管理所有开发工具，无需切换多个窗口或命令行。
- **🚀 进程管理 V2**：
  - **自动清理**：启动时自动识别并清理僵尸进程和端口占用，告别 "Address already in use"。
  - **热重启**：支持单个工具的独立停止、启动和重启，不影响平台其他功能。
- **🌐 远程协作**：天然支持内网访问，手机、平板均可作为控制器。
- **⚡ 高性能**：
  - 前端采用 React + Tailwind CSS，响应迅速，界面美观。
  - 后端使用 FastAPI 异步框架，支持 WebSocket 实时通信。
  - **连接稳健**：优化的 WebSocket 代理机制，自动处理连接异常，提升稳定性。
  - 针对长连接任务（如 Logcat、文件传输）优化了代理超时策略（支持 5分钟+ 长连接）。
- **🎨 现代化 UI**：
  - 支持暗色模式（Dark Mode）。
  - 动态标题显示，清晰区分当前工具。
  - 响应式设计，适配不同屏幕尺寸。

---

## 📦 内置工具

平台目前集成以下核心工具：

### 1. 📱 ADB Master (安卓设备管理)
专为游戏开发和测试设计的 ADB 图形化工具。
- **设备概览**：实时显示连接设备，支持 **WiFi 无线调试**（自动显示 WiFi IP）。
- **文件管理**：可视化的 Push/Pull 操作，支持进度条显示和本地路径记忆。
- **Logcat 查看器**：Web 端实时查看日志，支持过滤、暂停和错误检测。
- **应用管理**：一键安装 APK，卸载应用。

### 2. 🎮 GM Console (游戏控制台)
连接游戏服务器的调试利器。
- **TCP 通信**：直接与游戏服务器建立 TCP 连接。
- **Lua 执行**：即时发送 Lua 代码并获取返回结果，**支持命令历史保留**，便于重复调试。
- **广播模式**：支持向所有连接客户端广播指令，**智能屏蔽特定设备差异**，防止误操作。
- **宏按钮**：可自定义的常用指令网格（支持 1-5 列布局调节）。
- **参数控件**：
  - **滑块控制**：精细的参数调节（如时间流速、视野距离），支持范围修正。
  - **开关/输入框**：丰富的参数输入类型。

### 3. 🔄 FlowSVN (SVN 自动化)
版本控制自动化助手。
- **定时更新**：配置定时任务自动更新指定目录。
- **界面优化**：全新设计的任务列表与防误触开关控件，更加直观易用。
- **以及更多**：支持触发器和钩子脚本（WIP）。

---

## 🚀 快速开始

### 环境要求
- **Python** 3.10+
- **Node.js** 18+
- **uv** (推荐) 或 pip

### 安装与运行

#### Windows (推荐)
直接运行根目录下的启动脚本：
```bash
start.bat
```
脚本会自动检查依赖并启动服务。

#### 手动启动
1. **安装依赖**:
   ```bash
   # 后端
   uv sync
   
   # 前端
   cd frontend
   npm install
   ```

2. **启动开发服务**:
   ```bash
   # 终端 1: 启动后端 API
   uv run main.py
   
   # 终端 2: 启动前端 (开发模式)
   cd frontend
   npm run dev
   ```

3. **构建生产版本**:
   ```bash
   cd frontend
   npm run build
   cd ..
   uv run main.py
   ```

启动后访问：
- **本机**: `http://localhost:9524`
- **内网**: `http://<本机IP>:9524`

---

## 🛠️ 目录结构

```text
EncyHub/
├── main.py                 # 平台主入口 (FastAPI)
├── start.bat               # Windows 一键启动脚本
├── pyproject.toml          # Python 依赖配置
├── hub_core/               # 平台核心框架
│   ├── api.py              # 核心 API 与 代理逻辑
│   ├── process_manager.py  # 子进程生命周期管理
│   └── registry.py         # 工具注册表
├── tools/                  # 插件化工具目录
│   ├── adb_master/         # ADB 工具后端
│   ├── gm_console/         # GM 控制台后端
│   └── flow_svn/           # SVN 工具后端
├── frontend/               # 前端项目 (React + Vite)
│   ├── src/pages/          # 页面组件
│   └── ...
└── data/                   # 运行时数据 (日志、配置)
```

## 📝 开发指南

想要添加新工具？只需三步：

1. **后端**：在 `tools/` 下创建新目录（如 `my_tool`），编写 `main.py` (FastAPI app)。
2. **注册**：在 `hub_core/registry.py` 中注册该工具的元数据（ID、名称、端口）。
3. **前端**：在 `frontend/src/pages/` 下创建对应页面组件，并在路由中配置。

详情请参考 `docs/dev_guide.md` (计划中)。

---

## 📄 许可证

本项目采用 [MIT 许可证](LICENSE) 开源。
