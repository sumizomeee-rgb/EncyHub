# Scrcpy Web 嵌入投屏 —— 技术调研与分析报告

> **日期**: 2026-03-05  
> **前置**: Phase 1 (scrcpy 独立窗口启动) 已验收通过  
> **目标**: 评估将 scrcpy 投屏画面直接嵌入 ADB Master Web 页面的可行性

---

## 一、核心问题

**能否在浏览器中直接显示 Android 设备的实时画面，并支持触摸/键盘操控？**

答案：**能。** 以下是完整的技术调研证据。

---

## 二、现有开源方案调研

### 2.1 横向对比

| 项目 | 语言 | scrcpy 版本兼容 | Web 投屏 | 维护状态 | 适用性评估 |
|------|------|----------------|----------|---------|-----------|
| **Tango ADB** (tangoadb.dev) | TypeScript | v2.x ~ v3.x | ✅ WebCodecs | 🟢 活跃 (yume-chan) | ⭐ 最佳参考 |
| **ws-scrcpy** (NetrisTV) | Node.js + TS | v1.x ~ v2.x | ✅ MSE/WebCodecs | 🟡 低频 | 架构参考 |
| **MYScrcpy** (me2sy) | Python | 支持 v3.2 | ❌ 桌面 GUI | 🟢 活跃 | ⭐ Python 协议参考 |
| **py-scrcpy-client** (leng-yue) | Python | v1.20 (⚠️ 已归档) | ❌ | 🔴 已归档 | ❌ 不推荐 |
| **pyscrcpy** (yixinNB) | Python | v2.x (声称) | ❌ | 🟡 低频 | 需验证 |

### 2.2 关键发现

#### ❌ py-scrcpy-client 已确认不兼容 v2.x

调研证据：
- GitHub 项目已 **归档 (Archived)**
- 明确标注 "Implemented all functions in scrcpy server 1.20"
- GitHub Issue #79 报告：**与 scrcpy v2.4 不兼容**，原因是协议变更
- scrcpy v2.0 对协议做了重大改变（新增音频 socket、codec 元数据头、帧头格式变化）

**结论：py-scrcpy-client 完全不可用。**

#### ✅ MYScrcpy 是 Python 端最佳参考

- 支持 scrcpy 至 **v3.2**，远超我们的 v2.5
- 纯 Python 实现了完整的 video/audio/control 协议解析
- 提供了 Python 端与 scrcpy-server 通信的完整范例
- **可以直接参考其协议实现来编写我们自己的 Python 后端**

#### ✅ Tango ADB 提供了完整的前端解码方案

- `@yume-chan/scrcpy-decoder-webcodecs` npm 包
- 实现了 H.264/H.265/AV1 → WebCodecs → Canvas 的完整链路
- 处理了 NALU 解析、关键帧检测、SPS/PPS 提取等所有细节
- **可以直接参考其前端 WebCodecs 使用模式**

---

## 三、scrcpy v2.x 协议深入分析

### 3.1 协议版本声明

> **scrcpy 官方声明**（develop.md）:
> "The protocol between the client and the server must be considered _internal_: 
> it may (and will) change at any time for any reason."
> "A client must always be run with a matching server version."

我们的 scrcpy-server 版本是 **2.5**，启动时必须传参 `2.5`。

### 3.2 连接建立流程

```
┌──────────┐                 ┌──────────────┐                ┌──────────┐
│  Python  │                 │   ADB        │                │ Android  │
│  Backend │                 │   Daemon     │                │ Device   │
└────┬─────┘                 └──────┬───────┘                └────┬─────┘
     │                              │                             │
     │  1. adb push scrcpy-server   │                             │
     │ ─────────────────────────────>│ ────────────────────────── >│
     │                              │                             │
     │  2. adb forward tcp:PORT     │                             │
     │     localabstract:scrcpy_XXX │                             │
     │ ─────────────────────────────>│                             │
     │                              │                             │
     │  3. adb shell CLASSPATH=...  │                             │
     │     app_process / ...Server  │                             │
     │     2.5 tunnel_forward=true  │                             │
     │     audio=false ...          │ ────────────────────────── >│
     │ ─────────────────────────────>│    启动 scrcpy-server      │
     │                              │                             │
     │  4. TCP connect localhost:PORT                              │
     │ ──────────────────────────────────────────────────────────>│
     │                              │                             │
     │  5. [dummy byte] (forward模式)                             │
     │ <──────────────────────────────────────────────────────────│
     │                              │                             │
     │  6. [device meta: 64字节设备名]  (仅第一个socket)           │
     │ <──────────────────────────────────────────────────────────│
     │                              │                             │
```

### 3.3 视频流格式 (Video Socket)

连接建立后，视频 socket 的数据格式：

```
========== 阶段1: Codec 元数据 (12字节, 仅发送一次) ==========
┌──────────┬──────────┬──────────┐
│ codec_id │  width   │  height  │
│  u32     │  u32     │  u32     │
│ (H264=   │ (设备宽) │ (设备高) │
│  0x..?)  │          │          │
└──────────┴──────────┴──────────┘

========== 阶段2: 帧数据 (循环) ==========
┌─────────────────────────────────────────┬──────────┬──────────────────┐
│           PTS + Flags (8字节)           │pkt_size  │   H.264 数据     │
│ [C][K][...........62位 PTS...........]  │  u32     │  (pkt_size 字节) │
│  │  └─ 关键帧标志                       │          │  (Annex-B NALU)  │
│  └──── 配置包标志 (SPS/PPS)             │          │                  │
└─────────────────────────────────────────┴──────────┴──────────────────┘

注释:
- C (bit 63): Config 包标志 → 包含 SPS/PPS 配置数据
- K (bit 62): Key frame 标志 → I 帧 (IDR)
- PTS (bit 0~61): 时间戳 (微秒)
- 帧头总计 12 字节，紧跟 pkt_size 字节的 H.264 NALU 数据
```

### 3.4 控制消息格式 (Control Socket)

触摸事件消息 `SC_CONTROL_MSG_TYPE_INJECT_TOUCH_EVENT` (21字节):

```
┌──────┬────────┬────────────┬─────┬─────┬───────┬────────┬──────────┬─────────┐
│ type │ action │ pointer_id │  x  │  y  │ width │ height │ pressure │ buttons │
│ u8   │ u8     │ u64        │ u16 │ u16 │ u16   │ u16    │ u16      │ u8      │
│ 0x02 │ 0/1/2  │ (finger)   │     │     │       │        │ 0~65535  │         │
└──────┴────────┴────────────┴─────┴─────┴───────┴────────┴──────────┴─────────┘

type = 0x02 (INJECT_TOUCH_EVENT)
action: 0=ACTION_DOWN, 1=ACTION_UP, 2=ACTION_MOVE
x/y: 归一化坐标 (actual_x / screen_width * 65535)
pressure: 浮点压力 * 65535
所有多字节值使用 大端序 (Big-Endian)
```

---

## 四、技术实现方案

### 4.1 架构总览

```
┌─────────────────────────────────────────────────────────────────────┐
│                         浏览器 (Chrome/Edge)                        │
│                                                                     │
│  ┌──────────────┐     ┌──────────────┐     ┌──────────────────┐    │
│  │ WebSocket    │     │ WebCodecs    │     │ Canvas 渲染 +    │    │
│  │ 接收帧数据   │ ──> │ VideoDecoder │ ──> │ 鼠标事件捕获     │    │
│  │              │     │ (H.264 硬解) │     │                  │    │
│  └──────────────┘     └──────────────┘     └────────┬─────────┘    │
│                                                      │              │
│  ┌──────────────┐                                    │              │
│  │ WebSocket    │ <── 触控坐标/按键 JSON ────────────┘              │
│  │ 发送控制指令 │                                                   │
│  └──────────────┘                                                   │
└─────────────────────────────────────────────────────────────────────┘
        │ WebSocket ws://                      │ WebSocket ws://
        │ (二进制帧)                           │ (控制指令)
        ▼                                      ▼
┌─────────────────────────────────────────────────────────────────────┐
│                    Python 后端 (ADB Master)                          │
│                                                                     │
│  ┌──────────────────┐    ┌──────────────────┐                      │
│  │ Video Socket     │    │ Control Socket   │                      │
│  │ (TCP ─ ADB fwd)  │    │ (TCP ─ ADB fwd)  │                      │
│  │                  │    │                  │                      │
│  │ 读取 12字节帧头  │    │ 编码 21字节      │                      │
│  │ 读取 NALU 数据   │    │ 触摸事件消息     │                      │
│  │ → WebSocket 转发 │    │ ← WebSocket 接收 │                      │
│  └────────┬─────────┘    └────────┬─────────┘                      │
│           │ ADB Forward           │ ADB Forward                     │
│           ▼                       ▼                                 │
│        scrcpy-server (运行在 Android 设备上)                         │
└─────────────────────────────────────────────────────────────────────┘
```

### 4.2 后端核心逻辑 (Python)

#### 4.2.1 Server 部署与启动

```python
async def deploy_and_start_server(serial: str, scid: int) -> bool:
    """部署并启动 scrcpy-server"""
    server_path = get_scrcpy_server_path()
    adb = get_adb_path()
    
    # 1. Push server 到设备
    await run(f'{adb} -s {serial} push {server_path} /data/local/tmp/scrcpy-server.jar')
    
    # 2. 设置 ADB forward (设备监听, 电脑连接)
    video_port = find_free_port()  # 动态分配
    control_port = find_free_port()
    await run(f'{adb} -s {serial} forward tcp:{video_port} localabstract:scrcpy_{scid}')
    
    # 3. 启动 server
    await run(f'{adb} -s {serial} shell CLASSPATH=/data/local/tmp/scrcpy-server.jar '
              f'app_process / com.genymobile.scrcpy.Server 2.5 '
              f'scid={scid} tunnel_forward=true '
              f'audio=false control=true '
              f'max_size=800 max_fps=30 video_bit_rate=4000000 '
              f'send_frame_meta=true send_device_meta=true send_codec_meta=true')
    
    return True
```

#### 4.2.2 视频流读取与 WebSocket 转发

```python
async def video_stream_relay(tcp_reader, websocket):
    """从 video socket 读取帧, 通过 WebSocket 转发到浏览器"""
    
    # 1. 读取 codec 元数据 (12字节)
    codec_meta = await tcp_reader.readexactly(12)
    codec_id = struct.unpack('>I', codec_meta[0:4])[0]
    width = struct.unpack('>I', codec_meta[4:8])[0]
    height = struct.unpack('>I', codec_meta[8:12])[0]
    
    # 发送元数据给前端
    await websocket.send_json({
        "type": "codec_meta",
        "codec": "h264",  # codec_id 映射
        "width": width,
        "height": height,
    })
    
    # 2. 循环读取帧
    while True:
        # 读取 12 字节帧头
        header = await tcp_reader.readexactly(12)
        pts_and_flags = struct.unpack('>Q', header[0:8])[0]
        pkt_size = struct.unpack('>I', header[8:12])[0]
        
        is_config = bool(pts_and_flags & (1 << 63))
        is_keyframe = bool(pts_and_flags & (1 << 62))
        pts = pts_and_flags & 0x3FFFFFFFFFFFFFFF  # 低62位
        
        # 读取帧数据
        data = await tcp_reader.readexactly(pkt_size)
        
        # 构造消息: 1字节标志 + 8字节PTS + 帧数据
        flags_byte = (0x01 if is_config else 0) | (0x02 if is_keyframe else 0)
        frame_msg = struct.pack('>BQ', flags_byte, pts) + data
        
        # 二进制 WebSocket 发送
        await websocket.send_bytes(frame_msg)
```

#### 4.2.3 控制消息编码

```python
def encode_touch_event(action, x, y, screen_w, screen_h, pressure=1.0):
    """编码触摸事件为 scrcpy 控制协议的二进制格式"""
    MSG_TYPE_INJECT_TOUCH = 0x02
    POINTER_ID_GENERIC = 0xFFFFFFFFFFFFFFFF - 1  # -2 as uint64
    
    norm_x = int(x / screen_w * 65535)
    norm_y = int(y / screen_h * 65535)
    norm_pressure = int(pressure * 65535)
    
    return struct.pack('>BBQHHHHHBs',
        MSG_TYPE_INJECT_TOUCH,  # type (1 byte)
        action,                  # action (1 byte): 0=DOWN, 1=UP, 2=MOVE
        POINTER_ID_GENERIC,      # pointer_id (8 bytes)
        norm_x,                  # x (2 bytes)
        norm_y,                  # y (2 bytes)
        screen_w,                # width (2 bytes)
        screen_h,                # height (2 bytes)
        norm_pressure,           # pressure (2 bytes)
        0x00,                    # buttons (1 byte)
    )
```

### 4.3 前端核心逻辑 (JavaScript)

#### 4.3.1 WebCodecs 解码 + Canvas 渲染

```javascript
class ScrcpyWebPlayer {
  constructor(canvasElement) {
    this.canvas = canvasElement;
    this.ctx = canvasElement.getContext('2d');
    this.decoder = null;
    this.screenWidth = 0;
    this.screenHeight = 0;
  }

  initDecoder(width, height) {
    this.screenWidth = width;
    this.screenHeight = height;
    
    // 自适应 Canvas 大小
    const aspectRatio = width / height;
    this.canvas.width = Math.min(width, 480);  // 限制最大宽度
    this.canvas.height = this.canvas.width / aspectRatio;
    
    this.decoder = new VideoDecoder({
      output: (frame) => {
        this.ctx.drawImage(frame, 0, 0, this.canvas.width, this.canvas.height);
        frame.close();
      },
      error: (e) => console.error('解码错误:', e),
    });
    
    this.decoder.configure({
      codec: 'avc1.640028',  // H.264 High Profile
      codedWidth: width,
      codedHeight: height,
      optimizeForLatency: true,
    });
  }

  onVideoFrame(data) {
    // data: ArrayBuffer, 格式: [1字节flags][8字节PTS][NALU数据]
    const view = new DataView(data);
    const flags = view.getUint8(0);
    const pts = Number(view.getBigUint64(1));  // 微秒
    const isConfig = flags & 0x01;
    const isKeyFrame = flags & 0x02;
    
    const naluData = new Uint8Array(data, 9);  // 跳过9字节头
    
    if (isConfig) {
      // 配置帧 (SPS/PPS) — 可用于重新配置解码器
      // 某些实现将其与下一个关键帧合并送入解码器
      return;
    }
    
    this.decoder.decode(new EncodedVideoChunk({
      type: isKeyFrame ? 'key' : 'delta',
      timestamp: pts,
      data: naluData,
    }));
  }
}
```

#### 4.3.2 触控事件映射

```javascript
setupTouchControls(canvas, ws) {
  const sendTouch = (action, event) => {
    const rect = canvas.getBoundingClientRect();
    const scaleX = this.screenWidth / canvas.width;
    const scaleY = this.screenHeight / canvas.height;
    
    const x = (event.clientX - rect.left) * scaleX;
    const y = (event.clientY - rect.top) * scaleY;
    
    ws.send(JSON.stringify({
      type: 'touch',
      action,  // 0=DOWN, 1=UP, 2=MOVE
      x: Math.round(x),
      y: Math.round(y),
    }));
  };
  
  canvas.addEventListener('mousedown', e => sendTouch(0, e));
  canvas.addEventListener('mousemove', e => {
    if (e.buttons) sendTouch(2, e);  // 仅在按住时发送 MOVE
  });
  canvas.addEventListener('mouseup', e => sendTouch(1, e));
}
```

---

## 五、可行性结论

### 5.1 各环节可行性评级

| # | 技术环节 | 可行性 | 难度 | 证据/依据 |
|---|---------|--------|------|----------|
| 1 | Python 部署 scrcpy-server | ✅ 确定可行 | 🟢 低 | adb push + adb shell，文档完整 |
| 2 | ADB forward TCP 通信 | ✅ 确定可行 | 🟢 低 | 标准 ADB 功能，现有代码已有封装 |
| 3 | 视频流帧头解析 (12字节) | ✅ 确定可行 | 🟢 低 | 协议文档完整，格式明确 |
| 4 | WebSocket 二进制转发 | ✅ 确定可行 | 🟢 低 | Logcat WebSocket 已验证链路 |
| 5 | WebCodecs H.264 解码 | ✅ 确定可行 | 🟡 中 | Chrome/Edge 94+ 全支持，Tango 已验证 |
| 6 | Canvas 渲染 | ✅ 确定可行 | 🟢 低 | drawImage 标准 API |
| 7 | 触控事件映射 | ✅ 确定可行 | 🟡 中 | 坐标归一化公式已知，21字节协议明确 |
| 8 | scrcpy v2.5 协议兼容 | ✅ 高度可行 | 🟡 中 | MYScrcpy 支持到 v3.2，协议 v2.1→v2.5 变化小 |

### 5.2 浏览器兼容性

| 浏览器 | WebCodecs 支持 | 最低版本 | 备注 |
|--------|---------------|---------|------|
| Chrome | ✅ 完整支持 | 94+ | 2021年9月起 |
| Edge | ✅ 完整支持 | 94+ | 与 Chrome 同步 |
| Firefox | ✅ 支持 | 130+ | 2024年起 |
| Safari | ⚠️ 部分支持 | 16.4+ (仅视频) | 完整支持需 v26+ |

**内部工具使用场景**：团队统一使用 Chrome/Edge，兼容性 **完全无障碍**。

---

## 六、风险分析

### 6.1 已化解的风险

| 风险 | 原始担忧 | 调研结论 |
|------|---------|---------|
| Python 无可用库 | pyscrcpy 可能不兼容 | ✅ MYScrcpy 支持 v3.2，协议实现可参考 |
| 浏览器解码能力 | WebCodecs 是否成熟 | ✅ 全主流浏览器支持，硬件加速 |
| 协议文档缺失 | "internal protocol" | ✅ develop.md 详细记录了 v2.1 协议 |
| NALU 解析复杂 | H.264 格式难处理 | ✅ scrcpy 帧头已标记 config/keyframe |

### 6.2 仍存在的风险

| # | 风险 | 等级 | 影响 | 应对 |
|---|------|------|------|------|
| 1 | **scrcpy v2.5 vs v2.1 协议差异** | 🟡 中 | 可能有细微格式变化 | 参考 MYScrcpy v3.2 实现，覆盖 v2.5 |
| 2 | **首帧延迟** | 🟡 中 | 需等待关键帧才能开始解码 | scrcpy-server 会主动发送 config→IDR |
| 3 | **多设备端口冲突** | 🟢 低 | ADB forward 端口管理 | 动态分配端口 + SCID 随机数 |
| 4 | **触控精度** | 🟢 低 | 坐标缩放可能有偏差 | Canvas 缩放比精确计算，可微调 |
| 5 | **WebSocket 带宽压力** | 🟡 中 | 4Mbps 视频流 + 控制数据 | 局域网无问题，远程需降码率 |
| 6 | **设备屏幕旋转** | 🟡 中 | 宽高变化需动态调整 | 监听 codec_meta 中的 width/height 变化 |

---

## 七、工作量评估 (修正版)

基于实际调研结果，相比初始估计做了修正：

| 任务 | 初始估计 | 修正后 | 修正原因 |
|------|---------|--------|---------|
| 协议研究 | 1-2 天 | **1 天** | develop.md 文档比预期详细 |
| Server 部署管理 | 1 天 | **1 天** | 与 Phase 1 逻辑类似 |
| 视频流读取 + 帧解析 | 2 天 | **1.5 天** | 帧头只有 12 字节，格式明确 |
| WebSocket 转发 | (含上方) | **0.5 天** | 已有 Logcat WS 经验 |
| 前端 WebCodecs 解码 | 2 天 | **1.5 天** | Tango 已有成熟参考实现 |
| 触控/按键事件 | 1.5 天 | **1 天** | 21字节格式完全确定 |
| 虚拟按键 UI | 0.5 天 | **0.5 天** | - |
| 联调 + 优化 | 1-2 天 | **1.5 天** | - |
| **总计** | **8-12 天** | **~8 天** | 风险降低，参考资料充足 |

---

## 八、scrcpy-server 启动参数推荐

```bash
# Web 嵌入投屏推荐的 server 启动参数
adb -s {serial} shell \
    CLASSPATH=/data/local/tmp/scrcpy-server.jar \
    app_process / com.genymobile.scrcpy.Server 2.5 \
    scid={random_31bit}         \  # 随机标识 (防多实例冲突)
    tunnel_forward=true         \  # 使用 forward 模式 (电脑主动连)
    audio=false                 \  # Phase 2 不需要音频
    control=true                \  # 启用控制 (触控/按键)
    max_size=800                \  # 分辨率限制
    max_fps=30                  \  # 帧率限制
    video_bit_rate=4000000      \  # 4Mbps
    send_device_meta=true       \  # 发送设备名
    send_frame_meta=true        \  # 发送帧头 (PTS/flags)
    send_codec_meta=true        \  # 发送 codec 信息 (宽高)
    send_dummy_byte=true        \  # forward 模式需要
    show_touches=true           \  # 显示触摸点
    stay_awake=true             \  # 保持亮屏
    cleanup=true                \  # 退出时清理
    power_off_on_close=false    \  # 退出不关屏
    clipboard_autosync=false       # 禁用剪贴板 (降低复杂度)
```

---

## 九、推荐的参考实现

### 9.1 Python 后端参考

| 参考项目 | 用途 | 链接 |
|---------|------|------|
| MYScrcpy | scrcpy v3.2 完整 Python 协议实现 | github.com/me2sy/MYScrcpy |
| scrcpy develop.md | 官方协议文档 | github.com/Genymobile/scrcpy/blob/master/doc/develop.md |
| scrcpy control_msg_serialize.c | 控制消息格式的单元测试 (最权威) | Genymobile/scrcpy/app/tests/ |

### 9.2 前端参考

| 参考项目 | 用途 | 链接 |
|---------|------|------|
| @yume-chan/scrcpy-decoder-webcodecs | WebCodecs H.264 解码 | npm / tangoadb.dev |
| Chrome WebCodecs Samples | API 使用范例 | chrome.com/articles/webcodecs |

---

## 十、总结

### ✅ 技术完全可行，参考资料充足

| 维度 | 评估 |
|------|------|
| 协议文档 | ✅ 官方 develop.md + MYScrcpy 源码，格式完全确定 |
| Python 实现 | ✅ MYScrcpy 证明 Python 可完整实现 video/control 协议 |
| 浏览器解码 | ✅ WebCodecs 硬件加速，所有主流浏览器支持 |
| 控制协议 | ✅ 21 字节触摸事件格式完全确定，坐标归一化公式明确 |
| 工作量 | **约 8 个工作日**，风险可控 |

### 推荐行动

1. **确认启动 Phase 2 后**，首先实现一个最小原型：Python 读取视频流 → WebSocket → 前端 Canvas 显示
2. 原型验证通过后，再添加触控控制和完整 UI
3. Phase 1 的独立窗口功能保留，两种模式并存供用户选择
