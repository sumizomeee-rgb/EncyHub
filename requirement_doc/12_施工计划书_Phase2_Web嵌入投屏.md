# Phase 2 施工计划书 —— Scrcpy Web 嵌入投屏

> **版本**: v1.0  
> **日期**: 2026-03-05  
> **前置**: Phase 1 (独立窗口投屏) 已验收通过  
> **目标**: 将投屏画面直接嵌入 ADB Master Web 页面，替代 Phase 1 的独立窗口方案

---

## 一、架构变更总览

### 1.1 Phase 1 → Phase 2 的核心变化

```
Phase 1 (被替代):
  Web 按钮 → REST API → subprocess(scrcpy.exe) → SDL独立窗口
                         ↑ 需要 scrcpy.exe + 7个DLL (共7.6MB)

Phase 2 (目标):
  Web Canvas ← WebSocket → Python asyncio → TCP socket → scrcpy-server(设备端)
                            ↑ 只需 scrcpy-server (68KB)
```

**关键差异**：Phase 2 完全绕过 scrcpy.exe，由 Python 后端直接与设备端 scrcpy-server 通信，
视频流通过 WebSocket 送到浏览器，由 WebCodecs 硬件加速解码后渲染到 Canvas。

### 1.2 数据通路

```
┌──────────────────────────────────────────────────────────────┐
│                    浏览器 (Canvas + WebCodecs)                 │
│                                                              │
│  (1) WebSocket 接收二进制帧                                   │
│  (2) 解析 9字节消息头 → 提取 flags + PTS + NALU 数据          │
│  (3) WebCodecs VideoDecoder 硬件加速解码                      │
│  (4) Canvas.drawImage() 渲染                                  │
│  (5) Canvas 鼠标/触摸事件 → 坐标归一化 → WebSocket JSON 上行   │
└──────────────────────┬─────────────────┬─────────────────────┘
                       │ ws://           │ ws:// (同一连接)
                       ▼ 下行(二进制帧)   ▲ 上行(JSON控制)
┌──────────────────────┴─────────────────┴─────────────────────┐
│              Python 后端 (ScrcpyWebManager)                    │
│                                                              │
│  ┌─────────────────┐      ┌─────────────────┐               │
│  │ Video Relay     │      │ Control Relay   │               │
│  │ TCP read 12B头  │      │ JSON → 21B 编码 │               │
│  │ + NALU 数据     │      │ → TCP write     │               │
│  │ → WS send_bytes │      │ ← WS receive    │               │
│  └────────┬────────┘      └────────┬────────┘               │
│           │ ADB forward            │ ADB forward             │
│           ▼ (video socket)         ▼ (control socket)        │
│  ┌──────────────────────────────────────────────┐            │
│  │         scrcpy-server 2.5 (Android 设备端)    │            │
│  └──────────────────────────────────────────────┘            │
└──────────────────────────────────────────────────────────────┘
```

---

## 二、依赖清理

### 2.1 删除文件 (Phase 1 遗留, 不再需要)

Phase 2 直接与 scrcpy-server 通信，**不再启动 scrcpy.exe**，
因此 scrcpy.exe 及其全部运行时 DLL 都不再需要。

| 文件 | 大小 | 删除原因 |
|------|------|---------|
| `assets/scrcpy/scrcpy.exe` | 676 KB | Phase 2 不启动 scrcpy.exe |
| `assets/scrcpy/SDL2.dll` | 1.7 MB | SDL 图形渲染库, 仅 scrcpy.exe 使用 |
| `assets/scrcpy/avcodec-61.dll` | 3.2 MB | FFmpeg 视频解码, 仅 scrcpy.exe 使用 |
| `assets/scrcpy/avformat-61.dll` | 611 KB | FFmpeg 封装格式, 仅 scrcpy.exe 使用 |
| `assets/scrcpy/avutil-59.dll` | 1.0 MB | FFmpeg 基础工具, 仅 scrcpy.exe 使用 |
| `assets/scrcpy/swresample-5.dll` | 120 KB | FFmpeg 音频重采样, 仅 scrcpy.exe 使用 |
| `assets/scrcpy/libusb-1.0.dll` | 214 KB | USB 通信库, 仅 scrcpy.exe 使用 |
| **合计** | **~7.5 MB** | |

### 2.2 保留文件

| 文件 | 大小 | 保留原因 |
|------|------|---------|
| `assets/scrcpy/scrcpy-server` | 68 KB | 部署到 Android 设备端运行，是核心组件 |

### 2.3 删除代码文件

| 文件 | 删除原因 |
|------|---------|
| `tools/adb_master/scrcpy_manager.py` | Phase 1 的进程管理器，被 `scrcpy_web_manager.py` 完全替代 |

### 2.4 清理 path_utils.py

| 函数 | 操作 |
|------|------|
| `get_scrcpy_dir()` | ✅ 保留 |
| `get_scrcpy_exe_path()` | ❌ **删除** — scrcpy.exe 已不存在 |
| `get_scrcpy_server_path()` | ✅ 保留 |

---

## 三、后端施工

### 3.1 新增文件: `scrcpy_web_manager.py`

**职责**: 管理 scrcpy-server 的部署、启动、TCP 连接、视频流转发和控制消息编解码。

#### 3.1.1 类结构

```python
class ScrcpyWebSession:
    """单设备的 Web 投屏会话"""
    hw_id: str
    serial: str
    scid: int                    # 31位随机标识
    video_port: int              # ADB forward 的本地端口 (视频)
    control_port: int            # ADB forward 的本地端口 (控制)
    server_process: Process      # adb shell 进程
    video_reader: StreamReader   # 视频 TCP 读取器
    control_writer: StreamWriter # 控制 TCP 写入器
    screen_width: int            # 设备屏幕宽度
    screen_height: int           # 设备屏幕高度
    start_time: float
    _running: bool

class ScrcpyWebManager:
    """Scrcpy Web 投屏管理器"""
    
    async def start(hw_id, serial, config) -> dict
        # 1. deploy_server: push scrcpy-server 到设备
        # 2. setup_tunnel: adb forward 建立端口映射
        # 3. launch_server: adb shell 启动 scrcpy-server
        # 4. connect_video: TCP 连接视频 socket, 解析 codec 元数据
        # 5. connect_control: TCP 连接控制 socket
        # 6. 返回 screen_width/height 供前端使用
    
    async def stream(hw_id, websocket) -> None
        # WebSocket 双向流:
        # - 下行: 视频帧 (TCP read → 解析帧头 → WS send_bytes)
        # - 上行: 控制指令 (WS receive_json → 编码 → TCP write)
    
    async def stop(hw_id) -> dict
        # 清理: 关闭 TCP, 终止 server, 移除 forward
    
    async def stop_all() -> None
        # 应用关闭时清理所有会话
```

#### 3.1.2 scrcpy-server 部署与启动

```python
SCRCPY_VERSION = "2.5"  # 必须与 scrcpy-server 版本完全匹配

async def _deploy_server(self, serial: str) -> bool:
    """Push scrcpy-server 到设备"""
    server_path = get_scrcpy_server_path()
    adb = get_adb_path()
    
    proc = await asyncio.create_subprocess_exec(
        adb, "-s", serial,
        "push", server_path, "/data/local/tmp/scrcpy-server.jar",
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    _, stderr = await proc.communicate()
    return proc.returncode == 0

async def _setup_tunnel(self, serial: str, scid: int) -> tuple[int, int]:
    """设置 ADB forward 端口映射, 返回 (video_port, control_port)"""
    adb = get_adb_path()
    
    # 动态分配空闲端口
    video_port = _find_free_port()
    control_port = _find_free_port()
    
    # scrcpy 的 localabstract socket 命名规则
    socket_name = f"scrcpy_{scid:08x}"
    
    await asyncio.create_subprocess_exec(
        adb, "-s", serial,
        "forward", f"tcp:{video_port}", f"localabstract:{socket_name}",
    )
    
    return video_port, control_port

async def _launch_server(self, serial: str, scid: int, config: dict):
    """通过 adb shell 启动 scrcpy-server"""
    adb = get_adb_path()
    
    # 构建 server 启动参数
    args = [
        adb, "-s", serial, "shell",
        f"CLASSPATH=/data/local/tmp/scrcpy-server.jar",
        "app_process", "/", "com.genymobile.scrcpy.Server",
        SCRCPY_VERSION,
        f"scid={scid}",
        "tunnel_forward=true",
        "audio=false",
        "control=true",
        f"max_size={config.get('max_size', 800)}",
        f"max_fps={config.get('max_fps', 30)}",
        f"video_bit_rate={config.get('video_bit_rate', 4000000)}",
        "send_device_meta=true",
        "send_frame_meta=true",
        "send_codec_meta=true",
        "send_dummy_byte=true",
        f"show_touches={'true' if config.get('show_touches') else 'false'}",
        "stay_awake=true",
        "cleanup=true",
        "power_off_on_close=false",
        "clipboard_autosync=false",
    ]
    
    return await asyncio.create_subprocess_exec(
        *args,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
```

#### 3.1.3 视频 Socket 连接与解析

```python
async def _connect_video(self, port: int) -> tuple[StreamReader, dict]:
    """
    连接视频 socket, 解析初始元数据
    
    Returns:
        (reader, metadata)
        metadata = {"device_name": str, "codec": str, "width": int, "height": int}
    """
    # 重试连接 (server 启动需要时间)
    reader, writer = None, None
    for attempt in range(10):
        try:
            reader, writer = await asyncio.open_connection("127.0.0.1", port)
            break
        except ConnectionRefusedError:
            await asyncio.sleep(0.3)
    
    if not reader:
        raise ConnectionError("无法连接视频 socket")
    
    # 1. 读取 dummy byte (forward 模式)
    await reader.readexactly(1)
    
    # 2. 读取 device meta (64 字节设备名, 仅第一个 socket)
    device_name_raw = await reader.readexactly(64)
    device_name = device_name_raw.rstrip(b'\x00').decode('utf-8', errors='replace')
    
    # 3. 读取 codec meta (12 字节: codec_id + width + height)
    codec_meta = await reader.readexactly(12)
    codec_id = struct.unpack('>I', codec_meta[0:4])[0]
    width = struct.unpack('>I', codec_meta[4:8])[0]
    height = struct.unpack('>I', codec_meta[8:12])[0]
    
    codec_map = {0x68323634: "h264", 0x68323635: "h265", 0x00617631: "av1"}
    codec_name = codec_map.get(codec_id, "h264")
    
    return reader, {
        "device_name": device_name,
        "codec": codec_name,
        "width": width,
        "height": height,
    }
```

#### 3.1.4 WebSocket 双向流

```python
async def _video_relay(self, reader, websocket):
    """视频帧: TCP → WebSocket (二进制)"""
    while True:
        # 读取 12 字节帧头
        header = await reader.readexactly(12)
        pts_flags = struct.unpack('>Q', header[0:8])[0]
        pkt_size = struct.unpack('>I', header[8:12])[0]
        
        is_config = bool(pts_flags & (1 << 63))
        is_keyframe = bool(pts_flags & (1 << 62))
        pts = pts_flags & 0x3FFFFFFFFFFFFFFF
        
        # 读取帧数据 (H.264 NALU)
        data = await reader.readexactly(pkt_size)
        
        # 组装消息: [1字节flags][8字节PTS][NALU数据]
        flags_byte = (0x01 if is_config else 0) | (0x02 if is_keyframe else 0)
        msg = struct.pack('>BQ', flags_byte, pts) + data
        
        await websocket.send_bytes(msg)

async def _control_relay(self, writer, websocket, screen_w, screen_h):
    """控制指令: WebSocket → TCP (二进制)"""
    POINTER_ID = 0xFFFFFFFFFFFFFFFE  # SC_POINTER_ID_GENERIC_FINGER
    
    while True:
        msg = await websocket.receive()
        if msg.get("type") == "websocket.disconnect":
            break
        
        text = msg.get("text")
        if not text:
            continue
        
        event = json.loads(text)
        
        if event["type"] == "touch":
            action = event["action"]  # 0=DOWN, 1=UP, 2=MOVE
            x = int(event["x"] / screen_w * 65535)
            y = int(event["y"] / screen_h * 65535)
            pressure = 0xFFFF if action != 1 else 0  # UP时pressure=0
            
            payload = struct.pack('>BBQ HHHH HB',
                0x02,            # type: INJECT_TOUCH_EVENT
                action,          # action
                POINTER_ID,      # pointer_id
                x, y,            # normalized x, y
                screen_w,        # screen width
                screen_h,        # screen height
                pressure,        # pressure
                0x00,            # buttons
            )
            writer.write(payload)
            await writer.drain()
        
        elif event["type"] == "keycode":
            # 按键事件: INJECT_KEYCODE
            payload = struct.pack('>BBiIi',
                0x00,            # type: INJECT_KEYCODE
                event["action"], # action: 0=DOWN, 1=UP
                event["keycode"],# Android keycode
                0,               # repeat
                0,               # metastate
            )
            writer.write(payload)
            await writer.drain()
```

#### 3.1.5 清理逻辑

```python
async def stop(self, hw_id: str) -> dict:
    """停止投屏并清理所有资源"""
    session = self._sessions.get(hw_id)
    if not session:
        return {"success": True, "message": "未在投屏"}
    
    session._running = False
    
    # 1. 关闭 TCP 连接
    if session.control_writer:
        session.control_writer.close()
    
    # 2. 终止 adb shell 进程 (server 随之退出)
    if session.server_process:
        session.server_process.terminate()
        try:
            await asyncio.wait_for(session.server_process.wait(), 3.0)
        except asyncio.TimeoutError:
            session.server_process.kill()
    
    # 3. 移除 ADB forward
    adb = get_adb_path()
    if session.video_port:
        await asyncio.create_subprocess_exec(
            adb, "-s", session.serial,
            "forward", "--remove", f"tcp:{session.video_port}",
        )
    
    self._sessions.pop(hw_id, None)
    return {"success": True, "message": "投屏已停止"}
```

---

### 3.2 修改文件: `main.py`

#### 变更内容

```
- from .scrcpy_manager import ScrcpyManager      # 删除
+ from .scrcpy_web_manager import ScrcpyWebManager  # 替换

- scrcpy_mgr: Optional[ScrcpyManager] = None      # 删除
+ scrcpy_mgr: Optional[ScrcpyWebManager] = None    # 替换

  lifespan 中:
-   scrcpy_mgr = ScrcpyManager()        # 删除
+   scrcpy_mgr = ScrcpyWebManager()     # 替换

  删除旧 API:
-   POST /devices/{hw_id}/scrcpy/start   (REST 启动)
-   POST /devices/{hw_id}/scrcpy/stop    (REST 停止)
-   GET  /devices/{hw_id}/scrcpy/status  (REST 查询)
-   GET  /scrcpy/sessions                (REST 列表)
-   class ScrcpyStartRequest             (数据模型)

  新增 API:
+   POST /devices/{hw_id}/scrcpy/start   (REST, 部署+启动 server, 返回 width/height)
+   POST /devices/{hw_id}/scrcpy/stop    (REST, 停止)
+   GET  /devices/{hw_id}/scrcpy/status  (REST, 查询)
+   WS   /devices/{hw_id}/scrcpy/stream  (WebSocket, 双向视频流+控制)
```

#### 新增 WebSocket 端点

```python
@app.websocket("/devices/{hw_id}/scrcpy/stream")
async def scrcpy_stream(websocket: WebSocket, hw_id: str):
    """
    Scrcpy 投屏 WebSocket 流。
    
    下行 (server → 浏览器): 二进制视频帧
      格式: [1字节flags][8字节PTS][NALU数据]
      flags: bit0=config, bit1=keyframe
    
    上行 (浏览器 → server): JSON 控制指令
      {"type":"touch", "action":0, "x":123, "y":456}
      {"type":"keycode", "action":0, "keycode":4}
    """
    await websocket.accept()
    
    try:
        await scrcpy_mgr.stream(hw_id, websocket)
    except Exception as e:
        print(f"[AdbMaster] Scrcpy stream 异常: {e}")
    finally:
        try:
            await websocket.close()
        except:
            pass
```

---

### 3.3 修改文件: `path_utils.py`

```python
# 删除此函数:
- def get_scrcpy_exe_path() -> str:
-     """获取 scrcpy.exe 的完整路径。"""
-     return os.path.join(get_scrcpy_dir(), 'scrcpy.exe')

# 保留:
  def get_scrcpy_dir() -> str      # 保留
  def get_scrcpy_server_path()     # 保留
```

---

## 四、前端施工

### 4.1 改造 AdbMaster.jsx 投屏面板

Phase 2 的投屏面板从"参数 + 启停按钮"改为"参数 + 启停按钮 + 嵌入式 Canvas 播放器"。

#### 4.1.1 新增 State

```javascript
// 替换原有投屏 State, 新增:
const canvasRef = useRef(null)
const scrcpyWsRef = useRef(null)
const decoderRef = useRef(null)
const [scrcpyStreaming, setScrcpyStreaming] = useState(false)
const [scrcpyMeta, setScrcpyMeta] = useState(null)  // {width, height, codec}
```

#### 4.1.2 启动流程 (替换 handleStartScrcpy)

```javascript
const handleStartScrcpy = async () => {
  if (!selectedDevice) return
  setScrcpyLoading(true)
  try {
    // Step 1: REST 启动 (部署 server, 建立连接, 获取元数据)
    const res = await fetch(
      `/api/adb_master/devices/${selectedDevice.hardware_id}/scrcpy/start`,
      { method: 'POST', headers: {'Content-Type': 'application/json'},
        body: JSON.stringify(scrcpyConfig) }
    )
    const data = await res.json()
    if (!res.ok) { toast.error(data.detail); return }
    
    setScrcpyMeta({ width: data.width, height: data.height, codec: data.codec })
    
    // Step 2: 初始化 WebCodecs 解码器
    initDecoder(data.width, data.height, data.codec)
    
    // Step 3: 打开 WebSocket 流
    const wsUrl = `ws://${window.location.host}/api/adb_master/devices/${selectedDevice.hardware_id}/scrcpy/stream`
    const ws = new WebSocket(wsUrl)
    ws.binaryType = 'arraybuffer'
    
    ws.onopen = () => {
      setScrcpyStreaming(true)
      setScrcpyStatus({ running: true })
    }
    ws.onmessage = (e) => {
      if (e.data instanceof ArrayBuffer) {
        onVideoFrame(e.data)
      }
    }
    ws.onclose = () => {
      setScrcpyStreaming(false)
      setScrcpyStatus({ running: false })
      cleanupDecoder()
    }
    scrcpyWsRef.current = ws
  } catch (err) {
    toast.error('启动失败: ' + err.message)
  } finally {
    setScrcpyLoading(false)
  }
}
```

#### 4.1.3 WebCodecs 解码器

```javascript
const initDecoder = (width, height, codec) => {
  const canvas = canvasRef.current
  if (!canvas) return
  
  // 自适应 Canvas 尺寸 (保持宽高比, 面板内最大宽度)
  const maxWidth = 400
  const scale = Math.min(1, maxWidth / width)
  canvas.width = Math.round(width * scale)
  canvas.height = Math.round(height * scale)
  
  const ctx = canvas.getContext('2d')
  
  const decoder = new VideoDecoder({
    output: (frame) => {
      ctx.drawImage(frame, 0, 0, canvas.width, canvas.height)
      frame.close()
    },
    error: (e) => console.error('[ScrcpyPlayer] decode error:', e),
  })
  
  // H.264 High Profile Level 4.0
  decoder.configure({
    codec: 'avc1.640028',
    codedWidth: width,
    codedHeight: height,
    optimizeForLatency: true,
  })
  
  decoderRef.current = decoder
}

const onVideoFrame = (data) => {
  const decoder = decoderRef.current
  if (!decoder || decoder.state === 'closed') return
  
  const view = new DataView(data)
  const flags = view.getUint8(0)
  
  // 读取 PTS (8字节 BigEndian, 但 JS 不支持精确 u64, 用低32位近似)
  const ptsHigh = view.getUint32(1)
  const ptsLow = view.getUint32(5)
  const pts = ptsHigh * 4294967296 + ptsLow  // 微秒
  
  const isConfig = flags & 0x01
  const isKeyFrame = flags & 0x02
  
  const naluData = new Uint8Array(data, 9)  // 跳过 9 字节消息头
  
  if (isConfig) {
    // SPS/PPS 配置帧 — 某些实现选择在此处重新 configure 解码器
    // 暂时跳过, scrcpy 会在关键帧前自动发送
    return
  }
  
  try {
    decoder.decode(new EncodedVideoChunk({
      type: isKeyFrame ? 'key' : 'delta',
      timestamp: pts,
      data: naluData,
    }))
  } catch (e) {
    // 解码队列满或状态异常时忽略
  }
}

const cleanupDecoder = () => {
  if (decoderRef.current && decoderRef.current.state !== 'closed') {
    decoderRef.current.close()
  }
  decoderRef.current = null
}
```

#### 4.1.4 触控事件映射

```javascript
const setupCanvasTouch = (canvas) => {
  if (!canvas || !scrcpyMeta) return
  
  const sendTouch = (action, e) => {
    const ws = scrcpyWsRef.current
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    
    const rect = canvas.getBoundingClientRect()
    const scaleX = scrcpyMeta.width / canvas.width
    const scaleY = scrcpyMeta.height / canvas.height
    
    const x = Math.round((e.clientX - rect.left) * scaleX)
    const y = Math.round((e.clientY - rect.top) * scaleY)
    
    ws.send(JSON.stringify({
      type: 'touch', action, x, y,
    }))
  }
  
  canvas.addEventListener('mousedown', e => { e.preventDefault(); sendTouch(0, e) })
  canvas.addEventListener('mousemove', e => { if (e.buttons) sendTouch(2, e) })
  canvas.addEventListener('mouseup', e => sendTouch(1, e))
  canvas.addEventListener('contextmenu', e => e.preventDefault())
}
```

#### 4.1.5 虚拟按键

```javascript
const sendKeycode = (keycode) => {
  const ws = scrcpyWsRef.current
  if (!ws || ws.readyState !== WebSocket.OPEN) return
  // DOWN + UP
  ws.send(JSON.stringify({ type: 'keycode', action: 0, keycode }))
  setTimeout(() => {
    ws.send(JSON.stringify({ type: 'keycode', action: 1, keycode }))
  }, 50)
}

// Android Keycode 常量
const KEYCODE_BACK = 4
const KEYCODE_HOME = 3
const KEYCODE_APP_SWITCH = 187
const KEYCODE_VOLUME_UP = 24
const KEYCODE_VOLUME_DOWN = 25
const KEYCODE_POWER = 26
```

#### 4.1.6 面板 JSX (替换 Phase 1 面板)

```jsx
{/* Scrcpy 投屏控制面板 */}
<div className="mt-4">
  <button className="... 折叠按钮 ..." onClick={() => setExpandScrcpy(!expandScrcpy)}>
    <Monitor /> 投屏控制
    {scrcpyStreaming && <span className="... 绿色脉冲 ...">投屏中</span>}
  </button>
  
  {expandScrcpy && (
    <div className="... 面板容器 ...">
      {/* 参数配置 (与 Phase 1 一致, 未投屏时可修改) */}
      <div className="grid grid-cols-2 gap-3"> ... </div>
      
      {/* 启停按钮 */}
      <div className="flex gap-3 pt-2 border-t ...">
        {!scrcpyStreaming ? (
          <button onClick={handleStartScrcpy}>▶ 启动投屏</button>
        ) : (
          <button onClick={handleStopScrcpy}>■ 停止投屏</button>
        )}
      </div>
      
      {/* ====== Phase 2 新增: 内嵌 Canvas 播放器 ====== */}
      {scrcpyStreaming && (
        <div className="mt-3 flex flex-col items-center">
          {/* 视频画面 */}
          <canvas
            ref={canvasRef}
            className="rounded-lg border-2 border-[var(--glass-border)] cursor-crosshair"
            style={{ maxWidth: '100%', touchAction: 'none' }}
          />
          
          {/* 虚拟按键栏 */}
          <div className="flex gap-2 mt-2">
            <button onClick={() => sendKeycode(KEYCODE_BACK)} title="返回">
              ← Back
            </button>
            <button onClick={() => sendKeycode(KEYCODE_HOME)} title="主页">
              ○ Home
            </button>
            <button onClick={() => sendKeycode(KEYCODE_APP_SWITCH)} title="多任务">
              □ Recent
            </button>
            <button onClick={() => sendKeycode(KEYCODE_VOLUME_DOWN)} title="音量-">
              🔉
            </button>
            <button onClick={() => sendKeycode(KEYCODE_VOLUME_UP)} title="音量+">
              🔊
            </button>
          </div>
        </div>
      )}
    </div>
  )}
</div>
```

---

## 五、实施步骤清单

### Step 0: 依赖清理

```
操作: 删除不再需要的文件
  ❌ 删除 assets/scrcpy/scrcpy.exe
  ❌ 删除 assets/scrcpy/SDL2.dll
  ❌ 删除 assets/scrcpy/avcodec-61.dll
  ❌ 删除 assets/scrcpy/avformat-61.dll
  ❌ 删除 assets/scrcpy/avutil-59.dll
  ❌ 删除 assets/scrcpy/swresample-5.dll
  ❌ 删除 assets/scrcpy/libusb-1.0.dll
  ❌ 删除 tools/adb_master/scrcpy_manager.py

  ✅ 保留 assets/scrcpy/scrcpy-server (68KB)
释放空间: ~7.5 MB
```

### Step 1: 后端 — path_utils.py 清理

```
文件: tools/adb_master/path_utils.py
操作: 删除 get_scrcpy_exe_path() 函数
复杂度: 低
```

### Step 2: 后端 — scrcpy_web_manager.py (新建核心)

```
文件: tools/adb_master/scrcpy_web_manager.py (新建)
内容:
  - ScrcpyWebSession 数据类
  - ScrcpyWebManager 类
    - start(): 部署 server → 建立 tunnel → 启动 server → 连接 socket
    - stream(): WebSocket 双向流 (视频帧下行 + 控制上行)
    - stop(): 清理所有资源
    - stop_all(): 关闭时清理
  - 辅助函数:
    - _deploy_server(): adb push
    - _setup_tunnel(): adb forward
    - _launch_server(): adb shell 启动
    - _connect_video(): TCP 连接 + 解析 dummy/meta/codec
    - _connect_control(): TCP 连接控制 socket
    - _video_relay(): 帧读取 + WS 转发
    - _control_relay(): JSON 解析 + 二进制编码 + TCP 写入
    - _find_free_port(): 动态端口分配
    - _encode_touch(): 21字节触摸消息编码
    - _encode_keycode(): 按键消息编码
复杂度: 高 (核心文件)
```

### Step 3: 后端 — main.py 改造

```
文件: tools/adb_master/main.py
操作:
  1. 替换 import: ScrcpyManager → ScrcpyWebManager
  2. 替换全局变量
  3. 修改 lifespan 初始化
  4. 删除旧的 4 个 REST scrcpy API
  5. 新增:
     - POST /devices/{hw_id}/scrcpy/start  (启动, 返回 meta)
     - POST /devices/{hw_id}/scrcpy/stop   (停止)
     - GET  /devices/{hw_id}/scrcpy/status  (状态)
     - WS   /devices/{hw_id}/scrcpy/stream  (双向流)
  6. 修改 ScrcpyStartRequest 模型 (video_bit_rate 改为 int, 单位 bps)
复杂度: 中
```

### Step 4: 前端 — AdbMaster.jsx 改造

```
文件: frontend/src/pages/AdbMaster.jsx
操作:
  1. 新增 ref: canvasRef, scrcpyWsRef, decoderRef
  2. 新增 state: scrcpyStreaming, scrcpyMeta
  3. 新增函数:
     - initDecoder(): 初始化 WebCodecs VideoDecoder
     - onVideoFrame(): 解析消息头 + 送入解码器
     - cleanupDecoder(): 清理解码器
     - setupCanvasTouch(): Canvas 鼠标事件绑定
     - sendKeycode(): 虚拟按键发送
  4. 改造 handleStartScrcpy(): REST + WS 组合流程
  5. 改造 handleStopScrcpy(): 关闭 WS + REST stop
  6. 替换面板 JSX: 新增 Canvas + 虚拟按键栏
  7. 删除旧的 2秒轮询 useEffect (不再需要, WS 自带状态感知)
复杂度: 高
```

### Step 5: 编译 + 测试

```
操作:
  1. cd frontend && npm run build
  2. 重启 EncyHub
  3. 连接 Android 设备
  4. 验证:
     [x] 投屏面板展开 → 点击启动 → Canvas 显示设备画面
     [x] 在 Canvas 上点击/滑动 → 设备响应
     [x] 虚拟按键 (Back/Home/Recent) → 设备响应
     [x] 停止投屏 → Canvas 消失, 资源清理
     [x] 设备断连 → 自动感知, 状态恢复
     [x] 投屏期间 Logcat/文件传输不受影响
     [x] 多次启停不泄漏资源 (端口/进程)
```

---

## 六、scrcpy 协议细节备忘 (供开发参考)

### 6.1 Socket 连接顺序

```
使用 tunnel_forward=true 时:
1. 后端先启动 server (adb shell)
2. 后端主动 TCP connect 到设备
3. 连接顺序: video socket → control socket (audio 已禁用)
4. 第一个 socket (video) 上收到:
   - 1 字节 dummy byte
   - 64 字节 device name
   - 12 字节 codec meta
   - 然后是连续的视频帧
5. 第二个 socket (control) 上直接收发控制消息
```

### 6.2 codec_id 映射

```python
H264  = 0x68323634  # "h264" 的 ASCII 编码
H265  = 0x68323635
AV1   = 0x00617631
```

### 6.3 控制消息类型

```python
INJECT_KEYCODE      = 0x00  # 10字节
INJECT_TEXT         = 0x01  # 可变长度
INJECT_TOUCH_EVENT  = 0x02  # 21字节
INJECT_SCROLL_EVENT = 0x03  # 可变
BACK_OR_SCREEN_ON   = 0x04  # 2字节
```

---

## 七、目录结构变更 (最终状态)

```
E:\Such_Proj\Other\EncyHub\
├── assets/
│   ├── adb.exe                          # 保留 (6.3 MB)
│   └── scrcpy/
│       └── scrcpy-server                # ✅ 保留 (68 KB) — 唯一的 scrcpy 文件
│
├── tools/adb_master/
│   ├── __init__.py                      # 不变
│   ├── adb_manager.py                   # 不变
│   ├── config_manager.py                # 不变
│   ├── main.py                          # ⚙️ 修改: WS + REST API 改造
│   ├── path_utils.py                    # ⚙️ 修改: 删除 get_scrcpy_exe_path
│   ├── scrcpy_manager.py               # ❌ 删除 (Phase 1 遗留)
│   └── scrcpy_web_manager.py            # 🆕 新建: Web 投屏核心管理器
│
├── frontend/src/pages/
│   └── AdbMaster.jsx                    # ⚙️ 修改: Canvas + WebCodecs + 触控
│
└── frontend/src/index.css               # 可能微调 Canvas 样式
```

---

## 八、风险应对

| 风险 | 应对 |
|------|------|
| scrcpy-server 启动需时间, TCP 连接可能失败 | 重试机制: 10次 × 300ms |
| SPS/PPS 配置帧处理不当导致解码失败 | config 帧标志已由帧头提供, 观察是否需要与 keyframe 合并 |
| WebSocket 代理丢失二进制数据 | 已确认 hub_core proxy_websocket 支持 bytes 转发 |
| ADB forward 端口泄漏 | stop() 中执行 `adb forward --remove`, stop_all() 在关闭时清理 |
| Canvas 鼠标坐标精度 | 使用 getBoundingClientRect + 缩放比精确计算 |
| 帧率过高导致浏览器卡顿 | server 端限制 max_fps=30, 前端 decode 队列自动调节 |
