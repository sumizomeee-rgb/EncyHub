# Scrcpy 投屏协议调试成功报告

## 文档信息
- **创建时间**: 2026-03-06
- **问题状态**: ✅ **已解决**
- **调试耗时**: 约 2 小时
- **关键突破**: 发现 scrcpy 协议的 socket 连接顺序依赖

---

## 1. 问题背景

### 1.1 初始状态
上一个 Agent 在实施 Phase 2 Web 嵌入投屏时遇到了两个严重问题：
1. **触摸控制完全失效**：点击画面无任何响应
2. **投屏功能损坏**：激进的修复导致投屏完全无法启动，前端报错 `400 Bad Request`

### 1.2 之前的错误尝试
上一个 Agent 已经发现了协议格式问题（Touch Event 从 21 字节修正为 32 字节），但未能解决根本问题，反而导致连接完全失败。

---

## 2. 根因分析过程

### 2.1 第一轮分析：Control Socket Dummy Byte 问题

**初步假设**：Control socket 未读取 dummy byte 导致协议错位

**测试方法**：创建独立测试脚本 `test_scrcpy_connection.py`

**测试结果**：
```
[Test] TCP 连接成功!
[Test] dummy byte: 00
[Test] 尝试读取更多数据...
[Test] 收到初始数据: 0 bytes  ← 问题：没有收到 device meta
```

**结论**：假设部分正确，但不是全部原因

### 2.2 第二轮分析：完整的 Socket 连接顺序

**关键发现**：通过阅读 scrcpy 源码和实际测试，发现服务器行为：

> **服务器只有在 video 和 control socket 都连接后，才会发送 device meta！**

**验证测试**：
```python
# 先连接 video socket
video_reader, video_writer = await open_connection(port)
dummy = await video_reader.readexactly(1)  # 读取 dummy byte

# 然后连接 control socket（关键！）
control_reader, control_writer = await open_connection(port)
# 不读取 dummy byte

# 现在服务器才会发送 device meta
device_meta = await video_reader.readexactly(64)  # 成功！
codec_meta = await video_reader.readexactly(12)   # 成功！
```

**测试输出**：
```
[Test] Video TCP 连接成功!
[Test] dummy byte: 00
[Test] Control TCP 连接成功!
[Test] 收到初始数据: 64 bytes
[Test] device name: SM-N9760
[Test] 收到数据: 12 bytes  ← codec meta
[Test] 发现 NALU 起始码!   ← 视频数据正常
```

---

## 3. 最终修复方案

### 3.1 修复前的错误流程

```python
# 错误流程
async def start(self, ...):
    # 步骤4: 连接 video socket
    video_reader, video_writer, meta = await self._connect_video(port)
    # ↑ 这里尝试读取 dummy_byte + device_meta + codec_meta
    # 但 control socket 还没连接，服务器不发送 meta，导致挂起！

    # 步骤5: 连接 control socket（永远无法到达）
    _, control_writer = await self._connect_socket(port)
```

### 3.2 修复后的正确流程

```python
# 正确流程
async def start(self, ...):
    # 步骤4: 连接 video socket，只读取 dummy byte
    video_reader, video_writer = await self._connect_socket(port, read_dummy_byte=True)

    # 步骤5: 连接 control socket（不读取 dummy byte）
    _, control_writer = await self._connect_socket(port, read_dummy_byte=False)

    # 步骤6: 现在两个 socket 都连接了，读取 device meta
    device_name, codec_name, width, height = await self._read_device_meta(video_reader)
```

### 3.3 代码变更详情

#### 文件：`tools/adb_master/scrcpy_web_manager.py`

**变更 1：修改 `_connect_socket` 方法签名**
```python
# 之前
async def _connect_socket(self, port: int, is_video: bool = False)

# 之后
async def _connect_socket(self, port: int, read_dummy_byte: bool = False)
```

**变更 2：添加 `_read_device_meta` 方法**
```python
async def _read_device_meta(self, reader: asyncio.StreamReader) -> Tuple[str, str, int, int]:
    """
    读取设备元数据和编解码器元数据。
    注意：只有在 video 和 control socket 都连接后，服务器才会发送这些数据！
    """
    device_name_raw = await reader.readexactly(64)
    device_name = device_name_raw.rstrip(b'\x00').decode('utf-8', errors='replace')

    codec_meta = await reader.readexactly(12)
    codec_id = struct.unpack('>I', codec_meta[0:4])[0]
    width = struct.unpack('>I', codec_meta[4:8])[0]
    height = struct.unpack('>I', codec_meta[8:12])[0]

    codec_map = {0x68323634: "h264", 0x68323635: "h265", 0x00617631: "av1"}
    return device_name, codec_map.get(codec_id, "h264"), width, height
```

**变更 3：修正 `start` 方法的连接顺序**
```python
# 步骤4: 连接 video socket（只读取 dummy byte）
video_reader, video_writer = await self._connect_socket(video_port, read_dummy_byte=True)

# 步骤5: 连接 control socket（关键：必须先连接才能读取 meta）
_, control_writer = await self._connect_socket(video_port, read_dummy_byte=False)

# 步骤6: 读取 device meta（现在才能成功）
device_name, codec_name, meta_width, meta_height = await self._read_device_meta(video_reader)
```

---

## 4. scrcpy v2.5 协议完整流程图

```
┌─────────────────────────────────────────────────────────────────┐
│                    scrcpy-server (Android)                       │
│                                                                  │
│  1. 等待 video socket 连接                                       │
│  2. 发送 dummy byte (如果 send_dummy_byte=true)                  │
│  3. 等待 control socket 连接  ← 关键：必须等待！                  │
│  4. 发送 device meta (64 bytes)                                  │
│  5. 发送 codec meta (12 bytes)                                   │
│  6. 开始发送视频帧流                                             │
└─────────────────────────────────────────────────────────────────┘
                              │
                              │ TCP (ADB forward)
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                    Python Backend                                │
│                                                                  │
│  步骤4: connect video socket                                     │
│          └── read dummy byte (1 byte)                           │
│                                                                  │
│  步骤5: connect control socket  ← 必须在读取 meta 之前！          │
│          └── (不读取 dummy byte)                                 │
│                                                                  │
│  步骤6: read device meta (64 bytes)                              │
│          └── device_name                                         │
│                                                                  │
│         read codec meta (12 bytes)                               │
│          └── codec_id, width, height                             │
│                                                                  │
│  步骤7: 开始接收视频帧                                           │
└─────────────────────────────────────────────────────────────────┘
```

---

## 5. 关键知识点总结

### 5.1 scrcpy 协议要点

| 要点 | 说明 |
|------|------|
| Dummy Byte | 只发送给第一个连接的 socket (video) |
| Device Meta | 只有在 video + control 都连接后才发送 |
| Control Socket | 不需要读取 dummy byte |
| Touch Event | 32 字节格式（v2.5），坐标为像素值 (int32) |

### 5.2 触摸事件格式 (scrcpy v2.5)

```
Offset | Size | Type   | Field
-------|------|--------|--------
0      | 1    | uint8  | Type (0x02)
1      | 1    | uint8  | Action (0=DOWN, 1=UP, 2=MOVE)
2      | 8    | int64  | Pointer ID
10     | 4    | int32  | X (像素坐标)
14     | 4    | int32  | Y (像素坐标)
18     | 2    | uint16 | Screen Width
20     | 2    | uint16 | Screen Height
22     | 2    | uint16 | Pressure
24     | 4    | uint32 | Action Button
28     | 4    | uint32 | Buttons
-------|------|--------|--------
Total: 32 bytes
```

### 5.3 按键事件格式 (scrcpy v2.5)

```
Offset | Size | Type   | Field
-------|------|--------|--------
0      | 1    | uint8  | Type (0x00)
1      | 1    | uint8  | Action
2      | 4    | uint32 | Keycode
6      | 4    | uint32 | Repeat
10     | 4    | uint32 | MetaState
-------|------|--------|--------
Total: 14 bytes
```

---

## 6. 调试方法论总结

### 6.1 成功的关键步骤

1. **隔离测试**：创建独立的测试脚本，排除框架干扰
2. **分步验证**：逐步测试每个协议阶段
3. **源码对照**：查阅 scrcpy 官方源码确认协议细节
4. **动态调试**：添加详细的日志输出追踪数据流

### 6.2 避免的陷阱

| 陷阱 | 教训 |
|------|------|
| 盲目修改 | 在不确定协议细节时不要盲目修改二进制格式 |
| 跳过验证 | 每次修改后必须验证，不要累积多个修改再测试 |
| 忽视文档 | scrcpy 源码是最好的文档，要仔细阅读 |
| 过度假设 | 不要假设协议行为，要通过测试验证 |

---

## 7. 验证结果

### 7.1 功能测试结果

| 功能 | 状态 | 备注 |
|------|------|------|
| 投屏启动 | ✅ 正常 | 能正常连接并显示画面 |
| 触摸点击 | ✅ 正常 | 点击位置准确 |
| 触摸滑动 | ✅ 正常 | 滑动流畅 |
| 虚拟按键 | ✅ 正常 | Back/Home/Recent 都响应 |
| 停止投屏 | ✅ 正常 | 资源正确释放 |

### 7.2 测试环境

- **设备**: Android 模拟器 (emulator-5554)
- **设备型号**: Samsung SM-N9760 (Android 9)
- **分辨率**: 1920x1080
- **编码器**: OMX.google.h264.encoder

---

## 8. 参考资源

- [scrcpy v2.5 源码](https://github.com/Genymobile/scrcpy/tree/v2.5)
- [scrcpy 控制协议](https://github.com/Genymobile/scrcpy/blob/master/doc/develop.md)
- [ControlMessage.java](https://github.com/Genymobile/scrcpy/blob/v2.5/server/src/main/java/com/genymobile/scrcpy/ControlMessage.java)
- [control_msg.c](https://github.com/Genymobile/scrcpy/blob/v2.5/app/src/control_msg.c)

---

## 9. 后续建议

1. **添加协议版本检测**：未来 scrcpy 版本可能更改协议，建议添加版本兼容性检测
2. **错误恢复机制**：当协议解析失败时，提供更友好的错误提示和恢复建议
3. **性能监控**：添加帧率和延迟监控，便于性能调优
4. **真机测试**：建议在不同品牌/型号的真机上测试兼容性

---

**调试者**: Claude (Claude-opus-4-6)
**日期**: 2026-03-06