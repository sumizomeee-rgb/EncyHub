# Scrcpy 投屏功能集成到 ADB Master —— 可行性分析报告

> **编写日期**: 2026-03-05  
> **项目**: EncyHub / ADB Master  
> **分析目标**: 将 scrcpy (v2.5) 的投屏+控制功能以 Web 形式集成到 ADB Master 工具中  

---

## 一、概述

### 1.1 需求描述

在 ADB Master 的 Web 前端中，当用户切换到某个已连接设备时，新增一个可展开的 **[投屏控制]** 面板（与现有的 [Logcat 日志] / [文件传输] 面板同级），面板内提供类似 scrcpy 原生客户端的投屏+操控功能：

- ✅ 实时画面投屏（低延迟）
- ✅ 触摸/点击操作（鼠标映射到手机点击）
- ✅ 滑动操作
- ✅ 物理按键（返回、Home、多任务、音量）
- ✅ 键盘输入
- ✅ 投屏参数可调（分辨率、码率、帧率）

### 1.2 现有环境

| 项目 | 详情 |
|------|------|
| **EncyHub 架构** | FastAPI (Python) 后端 + Vite/React 前端 SPA |
| **ADB Master** | 独立 FastAPI 子服务 (port 14046)，通过 Hub 代理路由转发 |
| **Scrcpy 版本** | v2.5 (Windows 64-bit) |
| **Scrcpy 路径** | `D:\Program Files\scrcpy-win64-v2.5\scrcpy-win64-v2.5\` |
| **前端路由** | `/adb-master` → `AdbMaster.jsx` (921行，含 Logcat/文件传输/APK安装等功能面板) |
| **设备识别** | 以 `hardware_id` (ro.serialno) 为唯一标识，支持 USB/WiFi 双通道 |
| **已有通信模式** | REST API + WebSocket (Logcat 实时推送) |

---

## 二、技术调研

### 2.1 Scrcpy 工作原理

```
┌─────────────────────────────────────────────────────┐
│  Host (PC)                                          │
│  ┌─────────────────┐     ADB Forward/Reverse        │
│  │  scrcpy.exe      │ ◄──────────────────────────┐  │
│  │  (SDL2 渲染窗口)  │     H.264 Video Stream      │  │
│  │  (FFmpeg 解码)    │     Control Socket (双向)    │  │
│  └─────────────────┘                              │  │
│                                                    │  │
└────────────────────────────────────────────────────┘  │
                                                        │
┌───────────────────────────────────────────────────────┘
│  Android Device
│  ┌──────────────────┐
│  │  scrcpy-server   │  (Java, 通过 adb push 部署)
│  │  MediaCodec 编码  │  → H.264 NALUs
│  │  InputManager     │  ← 注入触摸/按键事件
│  └──────────────────┘
└───────────────────────────────────────────────────────
```

**关键要点**：
1. `scrcpy-server` 是一个 Java 二进制，由 scrcpy 客户端通过 adb 推送到设备并启动
2. 通过 ADB socket 建立 **视频流通道** 和 **控制通道**
3. 视频流为原始 **H.264 NALU** 数据（非容器格式）
4. 控制通道为自定义二进制协议（触摸坐标、按键事件等）
5. scrcpy 原生客户端使用 SDL2 + FFmpeg 进行解码渲染（**无法直接在浏览器中运行**）

### 2.2 Web 投屏的核心挑战

| 挑战 | 说明 |
|------|------|
| **H.264 解码** | 浏览器无法直接解析裸 H.264 NALUs，需要封装或使用 WebCodecs |
| **低延迟传输** | HTTP 不适合实时视频，需要 WebSocket 或 WebRTC |
| **触控映射** | 需将浏览器 Canvas 上的鼠标/触摸事件转换为 scrcpy 控制协议 |
| **进程管理** | 每个设备需独立的 scrcpy-server 实例，需管理生命周期 |
| **跨平台解码** | 不同浏览器对 H.264 的硬件加速支持程度不一 |

### 2.3 可选方案对比

#### 方案 A：直接调用 scrcpy.exe (最简但不嵌入 Web)

```
用户点击 [启动投屏] → 后端 subprocess 启动 scrcpy.exe -s {serial} → 弹出独立窗口
```

| 优点 | 缺点 |
|------|------|
| 实现最简单 (10行代码) | 不是 Web 内嵌，体验割裂 |
| 完全利用 scrcpy 原生能力 | 不支持远程/内网访问 |
| 零额外依赖 | 每个设备一个独立窗口 |

**开发工作量**: ⭐ (极小，约 0.5 天)  
**用户体验**: ⭐⭐ (独立窗口，非 Web 一体化)

---

#### 方案 B：Python 后端 + WebSocket 代理 + 前端 WebCodecs 解码 (推荐)

```
┌──────────────────────────────────────────────────────┐
│  浏览器 (AdbMaster.jsx)                               │
│  ┌────────────────────────────┐                       │
│  │  [投屏控制] 面板              │                       │
│  │  ┌──────────────────────┐  │                       │
│  │  │  <canvas> 画面渲染    │  │  ← WebSocket (视频帧)  │
│  │  │  鼠标/触摸事件捕获    │  │  → WebSocket (控制指令) │
│  │  └──────────────────────┘  │                       │
│  │  [参数设置] [Home] [Back]   │                       │
│  └────────────────────────────┘                       │
└───────────────────┬──────────────────────────────────┘
                    │ WebSocket
                    ▼
┌──────────────────────────────────────────────────────┐
│  ADB Master 后端 (FastAPI)                            │
│  ┌────────────────────────────┐                       │
│  │  ScrcpyManager             │                       │
│  │  • 启动/停止 scrcpy-server │                       │
│  │  • ADB socket 视频流读取   │                       │
│  │  • ADB socket 控制指令写入 │                       │
│  │  • WebSocket 双向转发      │                       │
│  └────────────────────────────┘                       │
└───────────────────┬──────────────────────────────────┘
                    │ ADB Forward
                    ▼
┌──────────────────────────────────────────────────────┐
│  Android Device                                       │
│  ┌────────────────┐                                   │
│  │ scrcpy-server  │  H.264 编码 + 控制事件注入         │
│  └────────────────┘                                   │
└──────────────────────────────────────────────────────┘
```

| 优点 | 缺点 |
|------|------|
| 完全 Web 内嵌，一体化体验 | 开发工作量较大 |
| 支持远程/内网访问 | H.264→浏览器解码需要精确处理 |
| 复用 scrcpy-server (成熟稳定) | 需要处理 scrcpy 私有协议 |
| 与现有 WebSocket 模式(Logcat)架构一致 | 延迟比原生略高 (多一层代理) |

**开发工作量**: ⭐⭐⭐⭐ (约 5-8 天)  
**用户体验**: ⭐⭐⭐⭐⭐ (完全集成)

**核心技术路径**：
1. 后端使用 Python `adb` 命令部署 `scrcpy-server` 到设备
2. 通过 `adb forward` 建立本地端口到设备 socket 的隧道
3. Python asyncio 读取视频 socket 的 H.264 NALU 数据
4. 通过 WebSocket 将视频帧二进制数据推送到前端
5. 前端使用 **WebCodecs API** (VideoDecoder) 解码 H.264 并渲染到 Canvas
6. 前端捕获 Canvas 上的鼠标/触摸事件，通过 WebSocket 发送控制指令
7. 后端将控制指令写入 scrcpy 的控制 socket

**前端解码技术选择**：

| 解码器 | 兼容性 | 性能 | 推荐度 |
|--------|--------|------|--------|
| **WebCodecs** (VideoDecoder) | Chrome 94+, Edge 94+ | ⭐⭐⭐⭐⭐ (硬件加速) | ✅ 首选 |
| **MSE** (MediaSource) | 主流浏览器 | ⭐⭐⭐⭐ (需封装为 fMP4) | 备选 |
| **Broadway.js** (WASM) | 全兼容 | ⭐⭐⭐ (纯软解) | 兼容兜底 |

---

#### 方案 C：集成 ws-scrcpy (Node.js 方案)

```
浏览器 → ws-scrcpy (Node.js Server) → scrcpy-server (Android)
```

| 优点 | 缺点 |
|------|------|
| 现成方案，功能完整 | 引入 Node.js 运行时依赖 |
| 多种解码器内置 | 架构异构 (Python Hub + Node.js ws-scrcpy) |
| 活跃社区维护 | 需要额外进程管理 |
| | 前端风格无法统一 |

**开发工作量**: ⭐⭐⭐ (约 3-5 天，主要是集成和适配)  
**用户体验**: ⭐⭐⭐ (独立 UI，与 EncyHub 风格不统一)

---

#### 方案 D：使用 pyscrcpy Python 库

```
pip install pyscrcpy
```

利用现有的 Python scrcpy 客户端库来处理与 scrcpy-server 的通信。

| 优点 | 缺点 |
|------|------|
| Python 生态内，与后端统一 | 库成熟度待验证 |
| 封装了协议细节 | 仍需自行处理 WebSocket 转发 |
| 降低协议理解成本 | 可能不支持 scrcpy v2.5 |
| | 文档和社区相对小 |

**开发工作量**: ⭐⭐⭐ (约 3-5 天)  
**用户体验**: ⭐⭐⭐⭐ (取决于自行实现的前端)

---

## 三、推荐方案：方案 A+B 分阶段实施

### 3.1 设计理念

**第一阶段 (MVP)**: 先实现方案 A (**快速可用**)，在 Web 上增加 [投屏控制] 面板，点击按钮后在服务器端启动 scrcpy 独立窗口。这让用户立刻获得投屏能力，无需等待复杂开发。

**第二阶段 (完整版)**: 实现方案 B (**Web 内嵌投屏**)，真正将画面渲染在 Web Canvas 中，实现一体化操控。

### 3.2 第一阶段：scrcpy.exe 独立窗口启动 (MVP)

#### 后端新增 API

```python
# tools/adb_master/main.py 新增

class ScrcpyConfig(BaseModel):
    max_size: int = 800        # 最大分辨率
    max_fps: int = 30          # 最大帧率
    video_bit_rate: str = "4M" # 视频码率
    stay_awake: bool = True    # 保持亮屏
    show_touches: bool = True  # 显示触摸点
    turn_screen_off: bool = False  # 关闭设备屏幕

@app.post("/devices/{hw_id}/scrcpy/start")
async def start_scrcpy(hw_id: str, config: ScrcpyConfig = ScrcpyConfig()):
    """启动 scrcpy 投屏窗口"""
    ...

@app.post("/devices/{hw_id}/scrcpy/stop")  
async def stop_scrcpy(hw_id: str):
    """停止 scrcpy 投屏"""
    ...

@app.get("/devices/{hw_id}/scrcpy/status")
async def scrcpy_status(hw_id: str):
    """获取投屏状态"""
    ...
```

#### 前端 UI 面板

在 `AdbMaster.jsx` 的控制中心区域，添加第三个可展开面板（与 Logcat、文件传输同级）：

```
[投屏控制] ▶ 展开
  ┌─────────────────────────────────────┐
  │  分辨率: [800 ▼]  码率: [4M ▼]       │
  │  帧率:   [30 ▼]   显示触点: [✓]      │
  │                                      │
  │  [✦ 启动投屏]     [■ 停止投屏]         │
  │                                      │
  │  状态: 🟢 投屏中 (PID: 12345)         │
  └─────────────────────────────────────┘
```

#### 工作量估算

| 任务 | 时间 |
|------|------|
| 后端 API + scrcpy 进程管理 | 0.5 天 |
| 前端面板 UI + 交互 | 0.5 天 |
| 测试 + 调试 | 0.5 天 |
| **合计** | **~1.5 天** |

### 3.3 第二阶段：Web Canvas 内嵌投屏 (完整版)

#### 后端核心模块

新增 `tools/adb_master/scrcpy_manager.py`：

```python
class ScrcpyManager:
    """管理 scrcpy-server 的部署、启动和流转发"""
    
    SCRCPY_SERVER_PATH = r"D:\Program Files\scrcpy-win64-v2.5\scrcpy-win64-v2.5\scrcpy-server"
    
    async def start_stream(self, serial: str, config: ScrcpyConfig) -> int:
        """
        1. adb push scrcpy-server /data/local/tmp/
        2. adb forward tcp:{port} localabstract:scrcpy
        3. adb shell 启动 scrcpy-server
        4. 建立视频+控制 socket 连接
        5. 返回 WebSocket 端口
        """
    
    async def relay_video(self, websocket: WebSocket):
        """视频流 → WebSocket 转发 (二进制帧)"""
    
    async def relay_control(self, websocket: WebSocket):
        """WebSocket 控制指令 → scrcpy 控制 socket"""
    
    async def stop_stream(self, serial: str):
        """清理：关闭 socket、移除 forward、杀死 server"""
```

#### 前端核心实现

```javascript
// 投屏 Canvas 组件核心逻辑 (伪代码)

// 1. WebCodecs 解码器初始化
const decoder = new VideoDecoder({
  output: (frame) => {
    ctx.drawImage(frame, 0, 0, canvas.width, canvas.height);
    frame.close();
  },
  error: (e) => console.error('解码错误:', e),
});
decoder.configure({ codec: 'avc1.640028', optimizeForLatency: true });

// 2. WebSocket 接收视频帧
ws.onmessage = (event) => {
  const chunk = new EncodedVideoChunk({
    type: isKeyFrame ? 'key' : 'delta',
    timestamp: performance.now() * 1000,
    data: event.data,
  });
  decoder.decode(chunk);
};

// 3. 触摸事件转发
canvas.addEventListener('mousedown', (e) => {
  const x = e.offsetX / canvas.clientWidth;
  const y = e.offsetY / canvas.clientHeight;
  ws.send(encodeScrcpyTouchEvent(ACTION_DOWN, x, y));
});
```

#### 工作量估算

| 任务 | 时间 |
|------|------|
| scrcpy 协议研究 + 逆向 | 1 天 |
| 后端 ScrcpyManager 实现 | 2 天 |
| WebSocket 视频流转发 | 1 天 |
| 前端 WebCodecs 解码 + Canvas 渲染 | 1.5 天 |
| 前端触控/按键事件映射 | 1 天 |
| UI 设计 + 控制按钮 | 0.5 天 |
| 集成测试 + 性能调优 | 1 天 |
| **合计** | **~8 天** |

---

## 四、风险评估

### 4.1 技术风险

| 风险 | 等级 | 应对措施 |
|------|------|----------|
| scrcpy 协议版本兼容性 | 🟡 中 | 锁定 scrcpy-server v2.5，协议变动时更新 |
| WebCodecs 浏览器兼容性 | 🟡 中 | 仅内部使用，Chrome/Edge 已全面支持；可加 Broadway.js 兜底 |
| H.264 NALU 解析复杂度 | 🟠 中高 | 可参考 ws-scrcpy/pyscrcpy 的成熟实现 |
| 视频延迟过高 | 🟡 中 | 减小缓冲、使用 `optimizeForLatency`、降低分辨率 |
| 多设备同时投屏资源占用 | 🟡 中 | 限制同时投屏设备数 (建议 1-2 台) |
| 控制事件坐标映射误差 | 🟢 低 | 使用标准化坐标 (0~1 范围)，前端按比例转换 |

### 4.2 工程风险

| 风险 | 等级 | 应对措施 |
|------|------|----------|
| scrcpy.exe 路径硬编码 | 🟢 低 | 使用配置文件管理路径 |
| 进程僵尸 (scrcpy 未正常退出) | 🟡 中 | 定时清理 + 信号处理 + 超时机制 |
| 内存泄漏 (视频帧未释放) | 🟡 中 | Canvas 渲染后立即 `frame.close()` |
| 与现有 ADB 命令冲突 | 🟢 低 | scrcpy-server 使用独立 socket，不影响 shell 命令 |

---

## 五、与现有架构的集成点

### 5.1 后端集成

```
tools/adb_master/
├── __init__.py
├── adb_manager.py          # 现有：ADB 命令执行
├── config_manager.py       # 现有：设备配置管理
├── main.py                 # 现有：FastAPI 路由 (新增 scrcpy 路由)
├── path_utils.py           # 现有：路径工具
└── scrcpy_manager.py       # 🆕 新增：scrcpy 进程/流管理
```

需要修改的现有文件：
- `main.py`: 新增 3-4 个 API 端点 + 1 个 WebSocket 端点
- `config_manager.py`: 新增 scrcpy 路径配置

### 5.2 前端集成

```
frontend/src/pages/AdbMaster.jsx 现有 UI 结构:
├── Header (顶部栏)
├── 设备发现 (左侧面板)
└── 控制中心 (右侧面板)
    ├── 设备信息头
    ├── [Logcat 日志] 可展开面板     ← 现有
    ├── [文件传输] 可展开面板         ← 现有
    ├── [投屏控制] 可展开面板         ← 🆕 新增
    └── 安装 APK 弹窗               ← 现有
```

### 5.3 数据流

```
设备列表切换:
  用户选择设备 → setSelectedDevice() → 如果投屏面板展开 → 自动停止旧设备投屏

投屏启动:
  用户点击 [启动投屏] → POST /scrcpy/start → 后端启动 scrcpy → WebSocket 连接 → Canvas 渲染

控制指令:
  Canvas 鼠标事件 → WebSocket → 后端 → scrcpy 控制 socket → 设备 InputManager

投屏停止:
  用户点击 [停止投屏] / 切换设备 / 面板折叠 → WebSocket 关闭 → 后端清理 scrcpy 进程
```

---

## 六、最终结论

### 6.1 可行性判断：✅ 完全可行

| 维度 | 评估 |
|------|------|
| **技术可行性** | ✅ 高。scrcpy 协议已有多个开源实现可参考 (ws-scrcpy, pyscrcpy)，WebCodecs API 在目标浏览器中成熟可用 |
| **架构兼容性** | ✅ 高。与现有 WebSocket (Logcat) + REST API 模式完全一致，前端面板结构支持扩展 |
| **工作量合理性** | ✅ MVP 阶段仅 1.5 天，完整版 ~8 天，分阶段实施风险可控 |
| **用户价值** | ✅ 高。投屏+操控是 ADB 管理中高频需求，Web 化后支持远程操作更具优势 |

### 6.2 推荐实施路线

```
Phase 1 (1.5天) ──────► Phase 2 (8天, 可选)
   │                        │
   ▼                        ▼
[MVP] scrcpy 独立窗口    [完整版] Web Canvas 内嵌投屏
   • 3个REST API             • WebSocket 视频流
   • 参数配置面板             • WebCodecs H.264 解码  
   • 进程启动/停止            • Canvas 触控映射
   • 状态监控                 • 虚拟按键面板
```

### 6.3 前置条件

1. ✅ scrcpy v2.5 已安装并包含 `scrcpy-server` 文件
2. ✅ ADB 已就绪 (ADB Master 已在使用)
3. ✅ 设备已启用 USB 调试
4. ⚠️ Phase 2 需要 Chrome/Edge 94+ 浏览器 (WebCodecs 支持)

---

## 附录 A：scrcpy v2.5 关键参数

| 参数 | 用途 | 推荐默认值 |
|------|------|-----------|
| `-s <serial>` | 指定设备 | 由 AdbManager 提供 |
| `-m <size>` | 最大分辨率 | 800 |
| `-b <bitrate>` | 视频码率 | 4M |
| `--max-fps` | 最大帧率 | 30 |
| `--show-touches` | 显示触摸点 | 开启 |
| `-w` | 保持亮屏 | 开启 |
| `--window-title` | 窗口标题 | 设备昵称/型号 |
| `--turn-screen-off` | 关闭设备显示 | 可选 |
| `--no-audio` | 禁用音频 | Phase 1 建议开启 |
| `--video-codec` | 视频编码 | h264 (默认) |

## 附录 B：相关开源参考项目

| 项目 | 地址 | 价值 |
|------|------|------|
| **ws-scrcpy** | github.com/NetrisTV/ws-scrcpy | H.264→WebSocket 完整实现参考 |
| **pyscrcpy** | pypi.org/project/pyscrcpy | Python scrcpy 客户端协议封装 |
| **scrcpy-client** | pypi.org/project/scrcpy-client | 另一个 Python 协议实现 |
| **scrcpy 官方** | github.com/Genymobile/scrcpy | 协议文档 + server 源码 |
