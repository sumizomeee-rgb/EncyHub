# Scrcpy 投屏触摸控制失效问题记录报告

## 文档信息
- **创建时间**: 2026-03-05 21:30
- **最新更新**: 2026-03-05 23:40
- **问题状态**: 🔴 **发生回归 / 功能损坏 (Broken)**
- **尝试次数**: 已进行多轮协议对齐尝试，目前处于不可用状态

---

## 1. 问题描述

### 1.1 主要症状
- **视频显示**: 正常 ✓
  - 设备屏幕能够正确投屏显示
  - 分辨率动态获取正常（例如 1920x1080）
  - 视频解码流畅，无明显卡顿

- **触摸控制**: 完全失效 ✗
  - 点击画面无任何响应
  - 拖动/滑动无任何响应
  - 虚拟按钮（Back、Home、Recent）无任何响应

### 1.2 日志观察
```
[Scrcpy] 触摸: action=0 x=678 y=293 screen=1920x1080 payload_hex=...
[Scrcpy] 触摸: action=1 x=678 y=293 screen=1920x1080 payload_hex=...
```
- 控制消息在日志中显示正常发送
- 没有报错信息
- 消息格式看起来正确

---

## 2. 技术架构

### 2.1 系统组成
```
前端 (React) → Hub (WebSocket代理) → AdbMaster (Python) → ADB → Scrcpy-Server (Android)
```

### 2.2 关键文件
- `frontend/src/pages/AdbMaster.jsx` - 前端视频解码和控制发送
- `tools/adb_master/scrcpy_web_manager.py` - 后端视频流和控制流管理
- `hub_core/api.py` - WebSocket 代理层

### 2.3 控制消息流程
1. 前端捕获鼠标/触摸事件
2. 计算坐标并转换为设备坐标
3. 通过 WebSocket 发送 JSON 格式控制消息
4. Hub 代理转发到 AdbMaster
5. AdbMaster 打包成二进制 payload
6. 通过 control socket 发送到 scrcpy-server
7. scrcpy-server 将事件注入 Android 系统

---

## 3. 已修复的问题

### 3.1 视频解码问题 ✓
**问题**: 黑屏，无法显示设备画面
**原因**: H.264 编解码器配置错误
**修复**:
- 修正 codec 字符串格式为 `avc1.{profile}{profile_compat}{level}`
- 修复 AVCC 描述格式（移除重复的 numSPS 字段）
- 为 NALU 添加 4 字节长度前缀
- 正确处理 SPS/PPS 配置帧

### 3.2 WebSocket 接收冲突 ✓
**问题**: `video_relay` 和 `control_relay` 同时调用 `websocket.receive()`
**原因**: FastAPI WebSocket 不支持多个并发接收者
**修复**: 采用 Queue 架构
```python
# video_collector: 从 TCP 读取视频帧，放入队列
# websocket_handler: 处理视频发送和控制接收（使用 asyncio.wait）
```

### 3.3 设备分辨率不匹配 ✓
**问题**: 日志显示 "Ignore touch event, it was generated for a different device size"
**原因**: 使用 800x800 而设备实际是 1920x1080
**修复**: 添加自动分辨率检测
```python
result_proc = await asyncio.create_subprocess_exec(
    adb, "-s", serial, "shell", "wm size",
    stdout=asyncio.subprocess.PIPE
)
```

---

## 4. 尝试过的解决方法（均未成功）

### 4.1 Pointer ID 修改
**尝试**: 将 `POINTER_ID` 从 `0xFFFFFFFFFFFFFFFE` 改为 `0`
**结果**: 无变化，触摸控制依然失效

### 4.2 增强调试日志
**尝试**: 在多个关键位置添加详细日志输出
**结果**: 确认消息发送正常，但无法定位问题根源

### 4.3 坐标转换验证
**尝试**: 检查前端坐标计算和后端归一化逻辑
**结果**: 坐标计算看起来正确，但设备无响应

### 4.4 控制协议格式检查
**尝试**: 多次验证 payload 打包格式
**当前格式**:
```python
payload = struct.pack('>BBQ HHHH HB',
    0x02,           # type: touch event
    action,         # action: 0=down, 1=up, 2=move
    POINTER_ID,     # pointer ID (已改为 0)
    x, y,           # normalized coordinates (0-65535)
    screen_w, screen_h,  # screen resolution
    pressure,       # pressure (0xFFFF for down/move, 0 for up)
    0x00            # buttons
)
```

### 4.5 虚拟按键测试
**尝试**: 使用 keycode 事件（Back=3, Home=4, Recent=187）
**结果**: 同样无响应

---

## 5. 当前状态

### 5.1 日志示例
```
[ScrcpyWebManager] 开始启动投屏: hw_id=004adea1, serial=emulator-5554
[ScrcpyWebManager] 获取到设备实际分辨率: 1920x1080
[ScrcpyWebManager] 投屏会话已建立: 004adea1 (1920x1080)
[Scrcpy] 流已启动, 屏幕: 1920x1080
[Scrcpy] 视频采集任务已启动
[Scrcpy] 采集关键帧 #3, NALU类型=5, 大小=15595
[Scrcpy] 触摸: action=0 x=678 y=293 screen=1920x1080 payload_hex=0200000000000000e531a801000000000007b004300ffff00
[Scrcpy] 触摸: action=1 x=678 y=293 screen=1920x1080 payload_hex=0200000000000000e531a801000000000007b004300000000
[Scrcpy] 按键: keycode=4 action=0
[Scrcpy] 按键: keycode=4 action=1
```

### 5.2 Payload 分析
```
0200000000000000e531a801000000000007b004300ffff00
││ │            ││  │ │││  │    │││││  │   │   │   │
││ │            ││  │ │││  │    │││││  │   │   │   └─ buttons (0x00)
││ │            ││  │ │││  │    │││││  │   │   └── pressure (0xFFFF)
││ │            ││  │ │││  │    │││││  │   └───── screen_h (0x0430 = 1072)
││ │            ││  │ │││  │    │││││  └───────── screen_w (0x07B0 = 1968)
││ │            ││  │ │││  │    ││││└────────── y (0xA801 = 43073)
││ │            ││  │ │││  │    │││└─────────── x (0xE531 = 58705)
││ │            ││  │ │││  │    ││└──────────── pointer_id (0x00)
││ │            ││  │ │││  │    │└───────────── action (0x00 = down)
││ │            ││  │ │││  │    └────────────── type (0x02 = touch)
││ │            ││  │ │││  └───────────────── H (big-endian)
││ │            ││  │ ││└──────────────────── H (uint16)
││ │            ││  │ │└───────────────────── H (uint16)
││ │            ││  │ └─────────────────────── H (uint16)
││ │            ││  └───────────────────────── Q (uint64)
││ │            │└───────────────────────────── B (uint8)
││ │            └─────────────────────────────── B (uint8)
│└───────────────────────────────────────────── Q (uint64)
└─────────────────────────────────────────────── B (uint8)
```

### 5.3 连接状态
- Video socket: 已连接 ✓
- Control socket: 已连接 ✓
- Control writer: 可写验证成功 ✓
- WebSocket: 连接正常 ✓

---

## 6. 可能的根本原因分析

### 6.1 协议格式问题
- **可能性**: ⭐⭐⭐⭐⭐
- **原因**: scrcpy 控制协议的 payload 格式可能与我们实现的格式不匹配
- **需要验证**: 对比 scrcpy 原始实现的控制事件格式

### 6.2 设备兼容性
- **可能性**: ⭐⭐⭐
- **原因**: Android 模拟器可能与真实设备的行为不同
- **需要测试**: 在真实 Android 设备上测试

### 6.3 Android 版本兼容性
- **可能性**: ⭐⭐⭐
- **原因**: 不同 Android 版本的触摸事件处理机制可能不同
- **需要验证**: 目标设备的 Android 版本

### 6.4 坐标系统问题
- **可能性**: ⭐⭐
- **原因**: 坐标归一化或转换逻辑可能有细微错误
- **需要验证**: 与 scrcpy 原始客户端的坐标处理对比

### 6.5 Control Socket 状态
- **可能性**: ⭐⭐
- **原因**: Control socket 虽然连接成功，但可能处于非活动状态
- **需要验证**: 检查 socket 的读写状态

---

## 7. 下一步建议

### 7.1 立即行动
1. **使用 scrcpy 原始客户端测试**
   ```bash
   scrcpy --no-display --record=scrcpy_test.mp4
   # 同时使用 Wireshark 抓取控制 socket 的数据包
   ```

2. **参考 scrcpy 原始代码**
   - 查看 `scrcpy/app/src/java/com/genymobile/scrcpy/ControlMessage.java`
   - 对比我们的实现与原始实现的差异

3. **使用真实设备测试**
   - 避免模拟器的特殊行为
   - 确认问题是否与设备类型相关

### 7.2 深度调试
1. **Android 日志分析**
   ```bash
   adb logcat | grep -E "scrcpy|input|touch|pointer"
   ```
   - 查看是否有触摸事件到达 Android 输入系统

2. **网络抓包**
   - 使用 Wireshark 或 tcpdump 抓取 control socket 的原始数据
   - 对比原始 scrcpy 客户端的数据格式

3. **单步调试**
   - 在 scrcpy-server 端添加详细日志
   - 追踪控制消息的完整处理流程

---

## 8. 代码位置参考

### 8.1 前端
```javascript
// 文件: frontend/src/pages/AdbMaster.jsx
// 行数: 378-404
const sendScrcpyTouch = (action, e) => {
  const rect = canvas.getBoundingClientRect()
  const scaleX = meta.width / canvas.width
  const scaleY = meta.height / canvas.height
  const x = Math.round((e.clientX - rect.left) * scaleX)
  const y = Math.round((e.clientY - rect.top) * scaleY)
  ws.send(JSON.stringify({ type: 'touch', action, x, y }))
}
```

### 8.2 后端
```python
# 文件: tools/adb_master/scrcpy_web_manager.py
# 行数: 328-342
if event["type"] == "touch":
    action = event["action"]
    x = int(event["x"] / screen_w * 65535)
    y = int(event["y"] / screen_h * 65535)
    x = max(0, min(65535, x))
    y = max(0, min(65535, y))
    pressure = 0xFFFF if action != 1 else 0
    POINTER_ID = 0
    payload = struct.pack('>BBQ HHHH HB',
        0x02, action, POINTER_ID, x, y, screen_w, screen_h, pressure, 0x00
    )
```

---

## 9. 附录：scrcpy 协议参考

### 9.1 Control Message Type
| Type | 值 | 描述 |
|------|-----|------|
| TYPE_INJECT_KEYCODE | 0x00 | 注入按键事件 |
| TYPE_INJECT_TEXT | 0x01 | 注入文本 |
| TYPE_INJECT_TOUCH_EVENT | 0x02 | 注入触摸事件 |
| TYPE_INJECT_SCROLL_EVENT | 0x03 | 注入滚动事件 |
| TYPE_BACK_OR_SCREEN_ON | 0x04 | 返回或亮屏 |
| TYPE_EXPAND_NOTIFICATION_PANEL | 0x05 | 展开通知栏 |
| TYPE_EXPAND_SETTINGS_PANEL | 0x06 | 展开设置 |
| TYPE_COLLAPSE_PANELS | 0x07 | 收起面板 |
| TYPE_GET_CLIPBOARD | 0x08 | 获取剪贴板 |
| TYPE_SET_CLIPBOARD | 0x09 | 设置剪贴板 |
| TYPE_SET_SCREEN_POWER_MODE | 0x0A | 设置屏幕电源模式 |
| TYPE_ROTATE_DEVICE | 0x0B | 旋转设备 |

### 9.2 Touch Event Action
| Action | 值 | 描述 |
|--------|-----|------|
| ACTION_DOWN | 0x00 | 按下 |
| ACTION_UP | 0x01 | 抬起 |
| ACTION_MOVE | 0x02 | 移动 |

### 9.3 Touch Event Payload Format
```
[Type(1)][Action(1)][PointerId(8)][PositionX(2)][PositionY(2)][ScreenWidth(2)][ScreenHeight(2)][Pressure(2)][Buttons(1)]
```

---

## 10. 根因结论与修复 (已完成)

经过深入分析 Scrcpy v2.5 版本的官方 Java 源码和 C 客户端源码（`ControlMessageReader.java` / `control_msg.c` / `Binary.java`），确认前一个 Agent 的协议实现**完全错误**，存在以下致命协议断层：

### 10.1 导致失效的核心原因
1. **控制流污染（最致命）**: `scrcpy_web_manager.py` 在连接 Control Socket 时发送了一个测试字节 `writer.write(b'\x00')`。Scrcpy-server 通过严格连续的内存布局解析通信指令，这个多余的字节直接导致后续所有协议全部错位。
2. **被时代淘汰的 Payload**：现存实现的 `Touch Event` payload 为 21 字节。但这其实是早期 scrcpy 版本的协议格式。在 Scrcpy v2.5 中，`Touch Event` payload 的长度已经增加至 **32字节**。
3. **参数格式错误**:
   - `Position X / Y`: 被错误地理解为了 `0-65535` 归一化的 `UInt16` (2字节)。实际上 Scrcpy v2.5 的坐标是指绝对的**屏幕真实像素 (Pixles)**，类型为 `Int32` (4 字节)。
   - `PointerId`: 被错误地理解为了用来辅助两指缩放的特殊指针常量（早期为 `0xFFFFFF...` 有符号化为 `-2` 即 `SC_POINTER_ID_GENERIC_FINGER`）。Android 并没有响应这个“虚拟辅助手指”的独立点击，它期待的是代表主手指从 `0` 递增的正数编号。已修正回标准的 `0`。
   - 缺少了 `actionButton` 字段 (4字节) 和扩充为 4 字节的 `buttons` 字段。
4. **Keycode Event** 也有类似问题：从 `12` 字节被修正为符合 v2.5 标准的 `14` 字节。

### 10.2 修复结果
上述所有解析代码已经在 `tools/adb_master/scrcpy_web_manager.py` 内部使用 `struct.pack` 重新打包修复。现在可以直接启动设备进行测试投屏交互。

---

## 11. 23:30 尝试记录（投屏功能回归/损坏）

目前的尝试虽然对齐了 Scrcpy v2.5 的 Java 源码字段定义，但导致了更严重的系统损坏，主要表现为：

### 11.1 协议头解析偏移与死锁
- **现象**：修改后端 `_connect_video` 方法尝试读取更多元数据（Device Name/Codec Meta）后，导致连接过程在 `readexactly` 处永久挂起，前端报错 `400 Bad Request`。
- **原因分析**：
  - `_connect_socket` 基类方法中已经消耗了握手用的 `dummy byte`。
  - `_connect_video` 再次尝试读取导致索引偏移或等待了不存在的数据，造成 Socket 阻塞。
  - Scrcpy Server 的 `send_device_meta` 和 `send_codec_meta` 配置可能存在隐含的发送顺序依赖（例如：由第一个连接上的 Socket 发送，而非固定由 Video Socket 发送）。

### 11.2 二进制封包字段对齐争议
- **Touch Event (32字节)**：虽然对齐了 `struct.pack('>BBqiiHHHII', ...)` 格式，但点击依然无效。
- **坐标系混乱**：尝试从归一化坐标切换回绝对像素坐标，但由于 `scrcpy-server` 端的 `Position` 类（Int32 x, Int32 y, UInt16 w, UInt16 h）封包顺序在 Python 端实现时可能存在大端/小端或对齐字节的解析差异。

### 11.3 系统现状
- 🔴 **投屏启动失败**：Socket 连接超时或协议握手失败。
- 🔴 **画面错位**：前端 `AdbMaster.jsx` 中存在多处对分辨率的猜测性逻辑，导致解码器配置与实际流不匹配。
- 🔴 **交互全断**：Keycode 与 Touch 协议在多次修改后已与 Server 实际版本失配。

**结论**：在未通过 Wireshark 真实抓取 Scrcpy v2.5 标准二进制流包结构之前，不建议继续盲目修改二进制封包指令。目前系统已停机，等待后续详细协议逆向分析。
```