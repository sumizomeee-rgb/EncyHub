# ADB Master 投屏功能 WebSocket 重连循环问题 - 修复尝试记录报告

**报告编号**: 15
**日期**: 2026-03-06
**问题**: 投屏功能启动后 WebSocket 不停重连循环（连接成功→断开→重连）
**状态**: 修复尝试失败，需重新设计解决方案

---

## 1. 问题现象

启动投屏后，浏览器控制台出现以下循环日志：

```
[ScrcpyPlayer] WebSocket 已连接
[ScrcpyPlayer] 初始化解码器: 1280 x 720 scale: 0.5 canvas: 640 x 360
[ScrcpyPlayer] profile/level: 66 192 41 description: 未提供
[ScrcpyPlayer] codec 字符串: avc1.42C029
[ScrcpyPlayer] 解码器配置完成, state: configured
[ScrcpyPlayer] WebSocket 已关闭
[Scrcpy] 检测到后端会话存在，开始恢复投屏
[Scrcpy] WebSocket 重连成功
[ScrcpyPlayer] 初始化解码器: 1920 x 1080 scale: 0.333...
...
[Scrcpy] WebSocket 重连后断开
[Scrcpy] 检测到后端会话存在，开始恢复投屏
```

表现为：
- WebSocket 连接成功
- 解码器初始化成功
- 几乎立即断开
- 前端检测到后端会话存在，触发重连
- 循环往复

---

## 2. 问题分析

### 2.1 前端逻辑

前端使用以下状态管理投屏：
- `scrcpyStreaming`: 是否正在投屏
- `scrcpyReconnecting`: 是否正在重连恢复
- `scrcpyWsRef`: WebSocket 引用

**自动恢复机制** (`useEffect`):
```javascript
useEffect(() => {
  // 当 selectedDevice 变化时检查后端状态
  // 如果后端会话存在且前端未连接，自动重连
}, [selectedDevice, scrcpyLoading, scrcpyStreaming, scrcpyReconnecting])
```

**问题**：WebSocket 断开后会触发 `setScrcpyStreaming(false)`，这会触发上述 useEffect，导致再次重连。

### 2.2 后端逻辑

后端使用 `ScrcpyWebSession` 管理会话：
- `video_reader`: 从 scrcpy-server TCP 连接读取视频流
- `ws_disconnect_time`: 记录 WebSocket 断开时间（30秒窗口期内允许重连）
- `video_eof`: 标记视频流是否结束

**stream 处理流程**:
1. 创建 `video_collector` 任务从 TCP 读取视频帧
2. 创建 `websocket_handler` 任务处理 WebSocket 消息
3. 使用 `asyncio.wait(FIRST_COMPLETED)`，任一任务结束则整个 stream 结束

**根本问题**：
- 当 WebSocket 第一次断开时，`video_reader` 可能已到达 EOF（scrcpy-server 关闭了连接或停止发送数据）
- 重连后 `video_collector` 立即读取到 EOF 并退出
- 导致 `stream` 方法结束，WebSocket 关闭
- 前端检测到会话仍存在（30秒窗口期），再次重连
- 循环往复

---

## 3. 修复尝试记录

### 尝试 1: 添加重连次数限制

**思路**: 限制前端最多重连3次，超过则停止尝试

**实现**:
- 添加 `scrcpyReconnectCountRef` 计数器
- 每次重连前检查是否超过上限
- 连接成功后重置计数器

**失败原因**:
- 计数器在 `onopen` 时就重置，但连接成功后立即断开
- 由于连接成功后立即失败，计数器永远达不到上限

### 尝试 2: 延迟重置计数器

**思路**: 只有在收到视频帧后才重置计数器

**实现**:
- 将计数器重置逻辑移到 `onmessage` 中
- 收到有效视频帧后才认为重连真正成功

**失败原因**:
- WebSocket 连接成功后几乎立即断开，根本收不到视频帧
- 计数器仍然无法累积

### 尝试 3: 后端标记 video_eof

**思路**: 当视频流到达 EOF 时，后端标记会话为需要重启

**实现**:
- 在 `ScrcpyWebSession` 添加 `video_eof` 字段
- `video_collector` 检测到 EOF 时设置 `video_eof = True`
- `get_status` 返回 `need_restart` 标志

**失败原因**:
- 即使前端检测到 `need_restart`，用户仍需要手动停止再启动
- 没有从根本上解决问题

### 尝试 4: 后端清理 EOF 会话

**思路**: 当 `video_eof=True` 时，后端直接清理会话

**实现**:
- `get_status` 检查 `video_eof`，如果为真则调用 `_stop_internal`
- 返回 `running: False`，让前端显示启动按钮

**待验证**:
- 该方案尚未得到用户验证

---

## 4. 根本原因总结

**核心问题**: scrcpy-server 的视频流 TCP 连接在 WebSocket 断开后到达 EOF，无法恢复。

**当前架构的问题**:
1. `video_reader` 与 WebSocket 生命周期绑定，但不是同一个连接
2. WebSocket 可以重连，但 TCP 视频流一旦 EOF 就无法恢复
3. 30秒重连窗口期设计假设视频流持续可用，但实际并非如此

**为什么重连会失败**:
1. 第一次连接：scrcpy-server 正常发送视频流 → 成功
2. WebSocket 断开（可能由于网络抖动、页面切换等）
3. scrcpy-server 检测到客户端断开，可能关闭视频流或进入等待状态
4. 前端重连 WebSocket，但 `video_reader` 已到达 EOF
5. `video_collector` 立即退出 → WebSocket 关闭
6. 循环

---

## 5. 可能的解决方案

### 方案 A: 彻底移除自动重连

**思路**: 当 WebSocket 断开时，直接停止会话，要求用户手动重新启动

**优点**:
- 简单可靠
- 避免无限循环

**缺点**:
- 用户体验差，每次切换设备或网络抖动都需要手动重启

### 方案 B: 重新建立 TCP 连接

**思路**: 重连时不仅重建 WebSocket，还重新建立与 scrcpy-server 的 TCP 连接

**实现**:
- 将 `video_reader/writer` 的创建移到 `stream` 方法中
- 或添加 `restart` 方法重新建立 TCP 连接

**难点**:
- 需要修改 scrcpy-server 启动逻辑
- 需要重新协商屏幕分辨率、编解码器等

### 方案 C: 使用 scrcpy-server 的持久化模式

**思路**: 启动 scrcpy-server 时使用持久化参数，使其在客户端断开后继续运行

**研究**:
- scrcpy v2.5 是否支持此模式？
- 需要查阅 scrcpy 文档

### 方案 D: 区分"暂停"和"停止"

**思路**:
- 设备切换时使用"暂停"（保持 TCP 连接）
- 真正的"停止"才关闭 scrcpy-server

**实现**:
- 添加 `pause` 和 `resume` 机制
- 前端切换设备时调用 `pause` 而非 `stop`
- 切换回设备时调用 `resume` 重建 WebSocket

---

## 6. 代码变更记录

### 修改的文件

1. **frontend/src/pages/AdbMaster.jsx**
   - 添加重连计数器和锁定机制
   - 修改 `syncScrcpyStatus` 添加重连次数检查
   - 修改 `reconnectScrcpyWebSocket` 返回 Promise 和超时保护
   - 添加 `need_restart` 处理（后移除）

2. **tools/adb_master/scrcpy_web_manager.py**
   - 添加 `video_eof` 字段到 `ScrcpyWebSession`
   - 修改 `video_collector` 检测 EOF 并设置标志
   - 修改 `get_status` 检查 `video_eof` 并清理会话

### 最终状态

前端和后端都已添加防御性代码，但问题未根本解决。

---

## 7. 建议下一步行动

1. **调查 scrcpy-server 行为**: 确认当 TCP 客户端断开时，scrcpy-server 是否关闭视频流
2. **评估方案 B**: 重新建立 TCP 连接的可行性
3. **评估方案 D**: 暂停/恢复机制对用户体验的改善
4. **考虑产品决策**: 是否接受每次切换设备都需要重新启动投屏的限制

---

## 8. 附件

### 相关日志片段

```
[Scrcpy] stream: 收到连接请求, hw_id=xxx, 现有会话: [...]
[Scrcpy] stream: 找到会话, _running=True, ws_disconnect_time=None, proc=12345
[Scrcpy] stream: 会话有效, 开始处理流, 屏幕: 1920x1080
[Scrcpy] 流已启动, 屏幕: 1920x1080
[Scrcpy] 视频采集任务已启动
[Scrcpy] 视频流到达 EOF，session 需要重启: xxx
[Scrcpy] WebSocket 断开，会话保持 30 秒可重连: xxx
```

### 关键代码位置

- 前端重连逻辑: `frontend/src/pages/AdbMaster.jsx:176-237`
- 后端 stream 处理: `tools/adb_master/scrcpy_web_manager.py:281-514`
- 后端状态检查: `tools/adb_master/scrcpy_web_manager.py:534-560`
- 视频采集: `tools/adb_master/scrcpy_web_manager.py:326-398`

---

**报告结束**

*本报告记录了针对 ADB Master 投屏功能 WebSocket 重连循环问题的修复尝试过程，供后续开发人员参考。*
