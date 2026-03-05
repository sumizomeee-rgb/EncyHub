# ADB Master × Scrcpy 投屏集成 —— 施工方案书

> **版本**: v1.0  
> **日期**: 2026-03-05  
> **关联文档**: [Scrcpy投屏集成可行性分析报告](./Scrcpy投屏集成可行性分析报告.md)  
> **施工范围**: Phase 1 (MVP — scrcpy 独立窗口启动+参数控制)

---

## 一、总体设计

### 1.1 目标

在 ADB Master 的 Web 控制中心中，新增一个 **[投屏控制]** 可展开面板（与 [Logcat 日志]、[文件传输] 同级），
提供以下能力：

- ✅ 一键启动/停止 scrcpy 投屏窗口
- ✅ 可调参数：分辨率、码率、帧率、显示触点、保持亮屏、关闭设备屏幕
- ✅ 实时投屏状态监控（运行中/已停止/PID/运行时长）
- ✅ 支持多设备同时投屏（每设备独立窗口，窗口标题显示设备名）
- ✅ 设备切换/断连时自动感知投屏状态

### 1.2 资源内置策略

**核心决策**：将 scrcpy 运行所需的最小文件集复制到 EncyHub 项目内的 `assets/scrcpy/` 目录下，
确保项目迁移到任何同事电脑后开箱即用，无需额外安装 scrcpy。

#### 文件来源与内置清单

从 `D:\Program Files\scrcpy-win64-v2.5\scrcpy-win64-v2.5\` 中提取以下文件：

| 文件名 | 大小 | 用途 | 是否内置 |
|--------|------|------|---------|
| `scrcpy.exe` | 676 KB | scrcpy 主程序 | ✅ 必须 |
| `scrcpy-server` | 68 KB | 部署到 Android 设备的 server (zip格式) | ✅ 必须 |
| `SDL2.dll` | 1.7 MB | 图形渲染 (scrcpy 窗口) | ✅ 必须 |
| `avcodec-61.dll` | 3.2 MB | FFmpeg 视频解码 | ✅ 必须 |
| `avformat-61.dll` | 611 KB | FFmpeg 封装格式 | ✅ 必须 |
| `avutil-59.dll` | 1.0 MB | FFmpeg 基础工具 | ✅ 必须 |
| `swresample-5.dll` | 120 KB | FFmpeg 音频重采样 | ✅ 必须 |
| `libusb-1.0.dll` | 214 KB | USB 通信 | ✅ 必须 |
| `adb.exe` | 5.6 MB | ADB (scrcpy 自带) | ❌ **不复制** — 使用 EncyHub 自有的 |
| `AdbWinApi.dll` | 106 KB | ADB 依赖 | ❌ 不复制 |
| `AdbWinUsbApi.dll` | 72 KB | ADB 依赖 | ❌ 不复制 |
| `*.bat / *.vbs / *.png` | — | 启动脚本/图标 | ❌ 不复制 |

**内置文件总计**：约 **7.6 MB**（排除了 adb 相关的 5.8 MB，节省大量空间）

#### 不复制 ADB 的原因

苏格拉底自检中发现的关键问题：
- scrcpy 自带 ADB v35.0.0，EncyHub 使用 ADB v36.0.0
- 如果两个版本的 ADB 客户端共存，会触发 **"adb server version doesn't match"** 错误
- 该错误会导致 ADB server 被强制重启，**中断所有正在进行的 Logcat 和文件传输操作**
- **解决方案**：不复制 scrcpy 自带的 adb，启动 scrcpy 时通过 `ADB` 环境变量指向 EncyHub 的 adb.exe

### 1.3 目录结构变更

```
E:\Such_Proj\Other\EncyHub\
├── assets/
│   ├── adb.exe                          # 现有 (6.3 MB)
│   └── scrcpy/                          # 🆕 新增目录
│       ├── scrcpy.exe                   # 主程序
│       ├── scrcpy-server                # Android server
│       ├── SDL2.dll                     # 图形渲染
│       ├── avcodec-61.dll               # 视频解码
│       ├── avformat-61.dll              # 封装格式
│       ├── avutil-59.dll                # 基础工具
│       ├── swresample-5.dll             # 音频重采样
│       └── libusb-1.0.dll               # USB 通信
│
├── tools/adb_master/
│   ├── __init__.py
│   ├── adb_manager.py                   # 现有 (不修改)
│   ├── config_manager.py                # 现有 (不修改)
│   ├── main.py                          # ⚙️ 修改: 新增 scrcpy API 路由
│   ├── path_utils.py                    # ⚙️ 修改: 新增 scrcpy 路径函数
│   └── scrcpy_manager.py               # 🆕 新增: scrcpy 进程管理器
│
├── frontend/src/pages/
│   └── AdbMaster.jsx                    # ⚙️ 修改: 新增投屏控制面板
│
└── frontend/src/index.css               # ⚙️ 修改: 新增投屏面板样式 (可选)
```

---

## 二、后端施工

### 2.1 新增文件: `scrcpy_manager.py`

**职责**：管理 scrcpy 进程的启动、停止、状态查询。

```python
"""
Scrcpy Manager for ADB Master.
管理 scrcpy 投屏进程的生命周期。
"""

import asyncio
import os
import sys
import time
from dataclasses import dataclass, field
from typing import Optional, Dict

from .path_utils import get_scrcpy_exe_path, get_adb_path


@dataclass
class ScrcpySession:
    """单个设备的 scrcpy 投屏会话"""
    hw_id: str                          # 设备 hardware_id
    serial: str                         # ADB serial (用于 -s 参数)
    process: asyncio.subprocess.Process  # scrcpy 子进程
    start_time: float                   # 启动时间戳
    config: dict = field(default_factory=dict)  # 启动参数

    @property
    def is_running(self) -> bool:
        return self.process.returncode is None

    @property
    def uptime_seconds(self) -> float:
        if self.is_running:
            return time.time() - self.start_time
        return 0


class ScrcpyManager:
    """Scrcpy 进程管理器"""

    def __init__(self):
        self._sessions: Dict[str, ScrcpySession] = {}  # hw_id → session

    async def start(
        self,
        hw_id: str,
        serial: str,
        device_name: str = "",
        max_size: int = 800,
        max_fps: int = 30,
        video_bit_rate: str = "4M",
        stay_awake: bool = True,
        show_touches: bool = True,
        turn_screen_off: bool = False,
        no_audio: bool = True,
    ) -> dict:
        """
        启动 scrcpy 投屏。

        Args:
            hw_id: 设备 hardware_id
            serial: ADB serial (如 abc123 或 192.168.1.5:5555)
            device_name: 显示名称 (用于窗口标题)
            其余: scrcpy 启动参数

        Returns:
            {"success": bool, "message": str, "pid": int|None}
        """
        # 1. 检查是否已有投屏
        if hw_id in self._sessions and self._sessions[hw_id].is_running:
            session = self._sessions[hw_id]
            return {
                "success": False,
                "message": f"设备已在投屏中 (PID: {session.process.pid})",
                "pid": session.process.pid,
            }

        # 2. 构建启动命令
        scrcpy_exe = get_scrcpy_exe_path()
        if not os.path.exists(scrcpy_exe):
            return {
                "success": False,
                "message": f"scrcpy 未找到: {scrcpy_exe}",
                "pid": None,
            }

        cmd = [
            scrcpy_exe,
            "-s", serial,
            "-m", str(max_size),
            "--max-fps", str(max_fps),
            "-b", video_bit_rate,
        ]

        if stay_awake:
            cmd.append("--stay-awake")
        if show_touches:
            cmd.append("--show-touches")
        if turn_screen_off:
            cmd.append("--turn-screen-off")
        if no_audio:
            cmd.append("--no-audio")

        # 窗口标题
        window_title = f"[EncyHub] {device_name or serial}"
        cmd.extend(["--window-title", window_title])

        # 3. 设置环境变量 — 强制 scrcpy 使用 EncyHub 的 ADB
        env = os.environ.copy()
        env["ADB"] = get_adb_path()
        # SCRCPY_SERVER_PATH 指向内置的 scrcpy-server
        env["SCRCPY_SERVER_PATH"] = get_scrcpy_server_path()

        # 4. 启动进程 (Windows: 使用 CREATE_NO_WINDOW 抑制黑色控制台)
        creation_flags = 0x08000000 if sys.platform == "win32" else 0

        try:
            proc = await asyncio.create_subprocess_exec(
                *cmd,
                env=env,
                stdout=asyncio.subprocess.DEVNULL,
                stderr=asyncio.subprocess.PIPE,
                creationflags=creation_flags,
            )
        except Exception as e:
            return {
                "success": False,
                "message": f"启动 scrcpy 失败: {e}",
                "pid": None,
            }

        # 5. 等待短暂时间，检查是否立即崩溃
        try:
            await asyncio.wait_for(proc.wait(), timeout=1.5)
            # 如果 1.5 秒内就退出了，说明启动失败
            stderr_data = await proc.stderr.read()
            error_msg = stderr_data.decode("utf-8", errors="replace").strip()
            return {
                "success": False,
                "message": f"scrcpy 启动后立即退出: {error_msg[:200]}",
                "pid": None,
            }
        except asyncio.TimeoutError:
            # 1.5 秒内没退出 = 启动成功
            pass

        # 6. 记录会话
        session = ScrcpySession(
            hw_id=hw_id,
            serial=serial,
            process=proc,
            start_time=time.time(),
            config={
                "max_size": max_size,
                "max_fps": max_fps,
                "video_bit_rate": video_bit_rate,
                "show_touches": show_touches,
                "turn_screen_off": turn_screen_off,
            },
        )
        self._sessions[hw_id] = session

        # 7. 后台监控进程退出
        asyncio.create_task(self._monitor_exit(hw_id, proc))

        return {
            "success": True,
            "message": f"投屏已启动 (PID: {proc.pid})",
            "pid": proc.pid,
        }

    async def stop(self, hw_id: str) -> dict:
        """
        停止指定设备的 scrcpy 投屏。

        Returns:
            {"success": bool, "message": str}
        """
        session = self._sessions.get(hw_id)
        if not session or not session.is_running:
            self._sessions.pop(hw_id, None)
            return {"success": True, "message": "投屏已停止 (未运行)"}

        try:
            session.process.terminate()
            try:
                await asyncio.wait_for(session.process.wait(), timeout=3.0)
            except asyncio.TimeoutError:
                session.process.kill()
                await session.process.wait()
        except ProcessLookupError:
            pass  # 进程已退出

        self._sessions.pop(hw_id, None)
        return {"success": True, "message": "投屏已停止"}

    def get_status(self, hw_id: str) -> dict:
        """
        获取投屏状态。

        Returns:
            {"running": bool, "pid": int|None, "uptime": float, "config": dict}
        """
        session = self._sessions.get(hw_id)
        if not session or not session.is_running:
            self._sessions.pop(hw_id, None)
            return {"running": False, "pid": None, "uptime": 0, "config": {}}

        return {
            "running": True,
            "pid": session.process.pid,
            "uptime": round(session.uptime_seconds, 1),
            "config": session.config,
        }

    def get_all_sessions(self) -> dict:
        """获取所有活跃投屏会话的状态摘要。"""
        result = {}
        dead_keys = []
        for hw_id, session in self._sessions.items():
            if session.is_running:
                result[hw_id] = {
                    "pid": session.process.pid,
                    "serial": session.serial,
                    "uptime": round(session.uptime_seconds, 1),
                }
            else:
                dead_keys.append(hw_id)
        for k in dead_keys:
            self._sessions.pop(k, None)
        return result

    async def stop_all(self):
        """停止所有投屏 (用于应用关闭时清理)。"""
        for hw_id in list(self._sessions.keys()):
            await self.stop(hw_id)

    async def _monitor_exit(self, hw_id: str, proc: asyncio.subprocess.Process):
        """后台监控 scrcpy 进程退出，自动清理会话记录。"""
        await proc.wait()
        session = self._sessions.get(hw_id)
        if session and session.process is proc:
            self._sessions.pop(hw_id, None)
```

#### 设计要点说明

| 设计决策 | 理由 |
|----------|------|
| 使用 `asyncio.create_subprocess_exec` | 与现有 `adb_manager.py` 的 `_run_command` 模式保持一致 |
| 等待 1.5 秒检测启动失败 | scrcpy 如果设备不存在/adb 异常会在 1 秒内退出，通过这个窗口期捕获错误 |
| `CREATE_NO_WINDOW` (0x08000000) | 抑制 Windows 下的黑色控制台窗口，不影响 SDL 图形窗口 |
| `env["ADB"]` 强制指定 ADB 路径 | **关键**：防止 ADB 版本冲突导致 adb-server 被重启 |
| `env["SCRCPY_SERVER_PATH"]` | 让 scrcpy 从 EncyHub 内置路径加载 server，而非当前目录 |
| 多设备投屏 (`Dict[hw_id → session]`) | 每个设备独立窗口，互不干扰 |
| `_monitor_exit` 后台任务 | 自动感知用户手动关闭窗口的情况，及时清理状态 |
| `stop_all()` 方法 | 供 EncyHub 关闭时调用，确保不留僵尸进程 |

---

### 2.2 修改文件: `path_utils.py`

新增两个路径函数：

```python
# ===== 新增 =====

def get_scrcpy_dir() -> str:
    """
    获取内置 scrcpy 目录路径。
    - EncyHub mode: EncyHub/assets/scrcpy/
    - Standalone: assets/scrcpy/ relative to base
    """
    if getattr(sys, 'frozen', False) and hasattr(sys, '_MEIPASS'):
        return os.path.join(sys._MEIPASS, 'scrcpy')

    if os.environ.get("ENCYHUB_MODE"):
        encyhub_root = os.path.dirname(
            os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        )
        return os.path.join(encyhub_root, 'assets', 'scrcpy')

    return os.path.join(get_base_path(), 'assets', 'scrcpy')


def get_scrcpy_exe_path() -> str:
    """获取 scrcpy.exe 的完整路径。"""
    return os.path.join(get_scrcpy_dir(), 'scrcpy.exe')


def get_scrcpy_server_path() -> str:
    """获取 scrcpy-server 的完整路径。"""
    return os.path.join(get_scrcpy_dir(), 'scrcpy-server')
```

---

### 2.3 修改文件: `main.py`

在现有路由文件中新增 scrcpy 相关 API。

#### 新增导入和全局实例

```python
# 文件头部导入区新增
from .scrcpy_manager import ScrcpyManager

# 全局实例区域新增
scrcpy_mgr: Optional[ScrcpyManager] = None
```

#### lifespan 中初始化和清理

```python
@asynccontextmanager
async def lifespan(app: FastAPI):
    global adb_mgr, config_mgr, scrcpy_mgr  # 新增 scrcpy_mgr

    adb_mgr = AdbManager()
    config_mgr = ConfigManager(...)
    scrcpy_mgr = ScrcpyManager()  # 🆕 初始化

    yield

    # 清理
    await scrcpy_mgr.stop_all()  # 🆕 关闭时停止所有投屏
    for serial in list(adb_mgr._logcat_tasks.keys()):
        await adb_mgr.stop_logcat(serial)
```

#### 新增 API 模型

```python
# ============================================================================
# Scrcpy API Models
# ============================================================================

class ScrcpyStartRequest(BaseModel):
    max_size: int = 800           # 最大分辨率 (宽或高)
    max_fps: int = 30             # 最大帧率
    video_bit_rate: str = "4M"    # 视频码率
    stay_awake: bool = True       # 保持亮屏
    show_touches: bool = True     # 显示触摸点
    turn_screen_off: bool = False # 关闭设备屏幕
    no_audio: bool = True         # 禁用音频 (降低延迟)
```

#### 新增 API 端点

```python
# ============================================================================
# Scrcpy 投屏 API
# ============================================================================

@app.post("/devices/{hw_id}/scrcpy/start")
async def start_scrcpy(hw_id: str, req: ScrcpyStartRequest = ScrcpyStartRequest()):
    """启动 scrcpy 投屏"""
    devices = await adb_mgr.get_unified_devices()
    dev = next((d for d in devices if d.hardware_id == hw_id), None)
    if not dev or not dev.active_serial:
        raise HTTPException(404, "设备不存在或离线")

    # 组合显示名称
    device_name = ""
    dev_config = config_mgr.get_device_config(hw_id)
    device_name = dev_config.get("nickname") or dev.model or hw_id[:12]

    result = await scrcpy_mgr.start(
        hw_id=hw_id,
        serial=dev.active_serial,
        device_name=device_name,
        max_size=req.max_size,
        max_fps=req.max_fps,
        video_bit_rate=req.video_bit_rate,
        stay_awake=req.stay_awake,
        show_touches=req.show_touches,
        turn_screen_off=req.turn_screen_off,
        no_audio=req.no_audio,
    )

    if not result["success"]:
        raise HTTPException(400, result["message"])
    return result


@app.post("/devices/{hw_id}/scrcpy/stop")
async def stop_scrcpy(hw_id: str):
    """停止 scrcpy 投屏"""
    result = await scrcpy_mgr.stop(hw_id)
    return result


@app.get("/devices/{hw_id}/scrcpy/status")
async def get_scrcpy_status(hw_id: str):
    """获取投屏状态"""
    return scrcpy_mgr.get_status(hw_id)


@app.get("/scrcpy/sessions")
async def list_scrcpy_sessions():
    """获取所有活跃投屏会话"""
    return {"sessions": scrcpy_mgr.get_all_sessions()}
```

---

## 三、前端施工

### 3.1 修改文件: `AdbMaster.jsx`

在控制中心区域，[文件传输] 面板之后插入 [投屏控制] 面板。

#### 新增 State

```javascript
// 投屏控制 State
const [expandScrcpy, setExpandScrcpy] = useState(false)
const [scrcpyStatus, setScrcpyStatus] = useState({ running: false })
const [scrcpyConfig, setScrcpyConfig] = useState({
  max_size: 800,
  max_fps: 30,
  video_bit_rate: '4M',
  stay_awake: true,
  show_touches: true,
  turn_screen_off: false,
  no_audio: true,
})
const [scrcpyLoading, setScrcpyLoading] = useState(false)
```

#### 新增投屏状态轮询

```javascript
// 在 useEffect 中，当选中设备且面板展开时，定时查询投屏状态
useEffect(() => {
  if (!selectedDevice || !expandScrcpy) return
  const fetchScrcpyStatus = async () => {
    try {
      const res = await fetch(
        `/api/adb_master/devices/${selectedDevice.hardware_id}/scrcpy/status`
      )
      if (res.ok) {
        const data = await res.json()
        setScrcpyStatus(data)
      }
    } catch {}
  }
  fetchScrcpyStatus()
  const interval = setInterval(fetchScrcpyStatus, 2000)
  return () => clearInterval(interval)
}, [selectedDevice, expandScrcpy])
```

#### 新增操作函数

```javascript
// 启动投屏
const handleStartScrcpy = async () => {
  if (!selectedDevice) return
  setScrcpyLoading(true)
  try {
    const res = await fetch(
      `/api/adb_master/devices/${selectedDevice.hardware_id}/scrcpy/start`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(scrcpyConfig),
      }
    )
    const data = await res.json()
    if (res.ok) {
      toast.success(data.message || '投屏已启动')
      setScrcpyStatus({ running: true, pid: data.pid, uptime: 0 })
    } else {
      toast.error(data.detail || '启动失败')
    }
  } catch (err) {
    toast.error('启动失败: ' + err.message)
  } finally {
    setScrcpyLoading(false)
  }
}

// 停止投屏
const handleStopScrcpy = async () => {
  if (!selectedDevice) return
  try {
    const res = await fetch(
      `/api/adb_master/devices/${selectedDevice.hardware_id}/scrcpy/stop`,
      { method: 'POST' }
    )
    const data = await res.json()
    toast.success(data.message || '投屏已停止')
    setScrcpyStatus({ running: false })
  } catch (err) {
    toast.error('停止失败: ' + err.message)
  }
}
```

#### 面板 JSX (插入到 [文件传输] 面板之后)

```jsx
{/* Scrcpy 投屏控制面板 */}
<div className="mt-4">
  <button
    className="w-full flex items-center justify-between p-3 rounded-lg
               bg-[var(--cream-warm)]/50 hover:bg-[var(--cream-warm)] transition-colors"
    onClick={() => setExpandScrcpy(!expandScrcpy)}
  >
    <div className="flex items-center gap-2">
      {expandScrcpy ? <ChevronDown size={18} /> : <ChevronRight size={18} />}
      <Monitor size={18} className="text-[var(--caramel)]" />
      <span className="font-medium">投屏控制</span>
      {scrcpyStatus.running && (
        <span className="ml-2 flex items-center gap-1 px-2 py-0.5 rounded-full text-xs
                         bg-[var(--success-soft)] text-[var(--sage)] font-medium">
          <span className="w-1.5 h-1.5 rounded-full bg-[var(--sage)] animate-pulse" />
          投屏中
        </span>
      )}
    </div>
  </button>

  {expandScrcpy && (
    <div className="mt-2 p-4 bg-[var(--cream-warm)]/30 rounded-xl space-y-4">
      {/* 参数配置区 */}
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="block text-xs text-[var(--coffee-muted)] mb-1">分辨率上限</label>
          <select
            value={scrcpyConfig.max_size}
            onChange={e => setScrcpyConfig(c => ({...c, max_size: Number(e.target.value)}))}
            className="w-full text-sm rounded-lg border border-[var(--glass-border)] px-3 py-1.5"
            disabled={scrcpyStatus.running}
          >
            <option value={480}>480p (流畅)</option>
            <option value={720}>720p (标准)</option>
            <option value={800}>800p (推荐)</option>
            <option value={1024}>1024p (高清)</option>
            <option value={0}>原始分辨率</option>
          </select>
        </div>
        <div>
          <label className="block text-xs text-[var(--coffee-muted)] mb-1">视频码率</label>
          <select
            value={scrcpyConfig.video_bit_rate}
            onChange={e => setScrcpyConfig(c => ({...c, video_bit_rate: e.target.value}))}
            className="w-full text-sm rounded-lg border border-[var(--glass-border)] px-3 py-1.5"
            disabled={scrcpyStatus.running}
          >
            <option value="2M">2 Mbps (省带宽)</option>
            <option value="4M">4 Mbps (推荐)</option>
            <option value="8M">8 Mbps (高画质)</option>
            <option value="16M">16 Mbps (极限)</option>
          </select>
        </div>
        <div>
          <label className="block text-xs text-[var(--coffee-muted)] mb-1">最大帧率</label>
          <select
            value={scrcpyConfig.max_fps}
            onChange={e => setScrcpyConfig(c => ({...c, max_fps: Number(e.target.value)}))}
            className="w-full text-sm rounded-lg border border-[var(--glass-border)] px-3 py-1.5"
            disabled={scrcpyStatus.running}
          >
            <option value={15}>15 FPS</option>
            <option value={24}>24 FPS</option>
            <option value={30}>30 FPS (推荐)</option>
            <option value={60}>60 FPS</option>
          </select>
        </div>
        <div className="flex flex-col justify-end">
          <label className="flex items-center gap-2 text-sm text-[var(--coffee-deep)] cursor-pointer">
            <input
              type="checkbox"
              checked={scrcpyConfig.show_touches}
              onChange={e => setScrcpyConfig(c => ({...c, show_touches: e.target.checked}))}
              disabled={scrcpyStatus.running}
              className="rounded"
            />
            显示触摸点
          </label>
          <label className="flex items-center gap-2 text-sm text-[var(--coffee-deep)] cursor-pointer mt-1">
            <input
              type="checkbox"
              checked={scrcpyConfig.turn_screen_off}
              onChange={e => setScrcpyConfig(c => ({...c, turn_screen_off: e.target.checked}))}
              disabled={scrcpyStatus.running}
              className="rounded"
            />
            关闭设备屏幕
          </label>
        </div>
      </div>

      {/* 操作按钮区 */}
      <div className="flex items-center gap-3 pt-2 border-t border-[var(--glass-border)]">
        {!scrcpyStatus.running ? (
          <button
            className="btn-primary flex items-center gap-2"
            onClick={handleStartScrcpy}
            disabled={scrcpyLoading}
          >
            <Play size={14} />
            {scrcpyLoading ? '启动中...' : '启动投屏'}
          </button>
        ) : (
          <button
            className="btn-danger flex items-center gap-2"
            onClick={handleStopScrcpy}
          >
            <Square size={14} />
            停止投屏
          </button>
        )}

        {/* 运行状态 */}
        {scrcpyStatus.running && (
          <div className="flex items-center gap-3 text-xs text-[var(--coffee-muted)]">
            <span>PID: {scrcpyStatus.pid}</span>
            <span>运行: {Math.floor(scrcpyStatus.uptime || 0)}s</span>
          </div>
        )}
      </div>
    </div>
  )}
</div>
```

#### 新增图标导入

```javascript
// 在文件顶部 lucide-react 导入中新增:
import { ..., Monitor } from 'lucide-react'
```

---

## 四、实施步骤清单

### Step 0: 资源准备 (手动)

```
操作: 将 scrcpy 必要文件复制到 EncyHub 项目
源:   D:\Program Files\scrcpy-win64-v2.5\scrcpy-win64-v2.5\
目标: E:\Such_Proj\Other\EncyHub\assets\scrcpy\

复制清单:
  ✅ scrcpy.exe
  ✅ scrcpy-server
  ✅ SDL2.dll
  ✅ avcodec-61.dll
  ✅ avformat-61.dll
  ✅ avutil-59.dll
  ✅ swresample-5.dll
  ✅ libusb-1.0.dll

不复制:
  ❌ adb.exe (使用 EncyHub 自有 v36)
  ❌ AdbWinApi.dll / AdbWinUsbApi.dll (adb 依赖, 不需要)
  ❌ *.bat / *.vbs / *.png (启动脚本/图标)
```

### Step 1: 后端 — path_utils.py

```
文件: tools/adb_master/path_utils.py
操作: 新增 3 个函数
      get_scrcpy_dir()
      get_scrcpy_exe_path()
      get_scrcpy_server_path()
复杂度: 低
```

### Step 2: 后端 — scrcpy_manager.py

```
文件: tools/adb_master/scrcpy_manager.py (新建)
操作: 完整实现 ScrcpyManager 类
内容: ScrcpySession 数据类 + ScrcpyManager (start/stop/status/stop_all)
复杂度: 中
```

### Step 3: 后端 — main.py

```
文件: tools/adb_master/main.py
操作: 新增 scrcpy 相关代码
  1. 顶部新增 import
  2. 全局变量新增 scrcpy_mgr
  3. lifespan 中初始化 + 关闭清理
  4. 新增 ScrcpyStartRequest 数据模型
  5. 新增 4 个 API 端点:
     POST   /devices/{hw_id}/scrcpy/start
     POST   /devices/{hw_id}/scrcpy/stop
     GET    /devices/{hw_id}/scrcpy/status
     GET    /scrcpy/sessions
复杂度: 中
```

### Step 4: 前端 — AdbMaster.jsx

```
文件: frontend/src/pages/AdbMaster.jsx
操作: 新增投屏控制面板
  1. 新增 lucide-react 图标导入 (Monitor)
  2. 新增投屏相关 State (5个)
  3. 新增 useEffect 投屏状态轮询
  4. 新增 handleStartScrcpy / handleStopScrcpy 函数
  5. 在 [文件传输] 面板后插入 [投屏控制] 面板 JSX
复杂度: 中
```

### Step 5: 更新 .gitignore

```
文件: .gitignore
操作: 确认 assets/ 目录未被忽略 (当前未被忽略 ✅)
      确认 assets/scrcpy/ 下的 dll/exe 不在忽略列表中
注意: 如果 git 有 *.exe 或 *.dll 的全局忽略规则，需要添加例外
```

### Step 6: 编译前端 + 集成测试

```
操作:
  1. cd frontend && npm run build
  2. 启动 EncyHub (start.bat)
  3. 连接 Android 设备
  4. 选择设备 → 展开投屏控制面板 → 启动投屏
  5. 验证 scrcpy 窗口正常弹出
  6. 验证停止投屏、参数调整、多设备投屏
  7. 验证投屏期间 Logcat/文件传输不受影响
  8. 手动关闭 scrcpy 窗口后，验证前端状态同步
```

---

## 五、关键设计决策备忘

| # | 决策 | 理由 |
|---|------|------|
| 1 | scrcpy 文件内置到 `assets/scrcpy/` | 确保项目可移植，避免外部依赖 |
| 2 | 不复制 scrcpy 自带的 adb | 防止 ADB v35 vs v36 版本冲突 |
| 3 | 通过 `ADB` 环境变量指定 ADB 路径 | scrcpy 官方支持的指定方式 |
| 4 | 通过 `SCRCPY_SERVER_PATH` 指定 server | 让 scrcpy 从内置路径加载 server |
| 5 | `CREATE_NO_WINDOW` 抑制控制台 | SDL 窗口不受影响，只隐藏黑框 |
| 6 | 多设备保留各自窗口不自动关闭 | 窗口标题含设备名，用户可自行管理 |
| 7 | 1.5 秒启动失败检测 | 捕获设备不存在/ADB 异常等快速失败 |
| 8 | 后台 `_monitor_exit` 任务 | 自动感知用户手动关窗/设备断连 |

---

## 六、风险与注意事项

| 风险 | 等级 | 应对 |
|------|------|------|
| Git 推送 binary 文件 (7.6MB) | 🟡 | 一次性推送，后续不会频繁变更 |
| scrcpy 版本升级 | 🟢 | 替换 `assets/scrcpy/` 下的文件即可 |
| WiFi 设备投屏延迟略高 | 🟢 | 正常现象，降低码率/帧率可改善 |
| 设备未授权 USB 调试 | 🟢 | 与其他 ADB 操作一致，提示用户授权 |
| Windows Defender 拦截 scrcpy.exe | 🟡 | 首次运行可能需要放行，添加白名单即可 |

---

## 七、后续演进 (Phase 2 预留)

Phase 1 完成后，如有需要可演进到 Phase 2（Web 内嵌投屏），届时：
- `scrcpy_manager.py` 会扩展为直接与 `scrcpy-server` 通信（不启动 scrcpy.exe）
- 新增 WebSocket 端点用于视频流/控制指令双向转发
- 前端新增 Canvas + WebCodecs 解码渲染
- 内置的 `scrcpy.exe` 和 DLL 可能不再需要（只需 `scrcpy-server`）

Phase 2 的改动不影响 Phase 1 的目录结构和 API 设计。
