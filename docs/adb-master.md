# ADB Master

ADB Master 提供安卓设备发现、设备信息、文件传输、Logcat、APK 管理和 Scrcpy Web 投屏。

## 数据与入口

- 后端：`tools/adb_master/`
- 前端：`frontend/src/pages/AdbMaster.jsx`
- 本机数据：`.local/data/adb_master/`

## Scrcpy 当前实现

投屏由后端启动 scrcpy-server，并分别维护视频与控制连接。浏览器通过 WebSocket 接收视频数据、发送触摸和按键控制；多设备会话相互独立。

协议实现需要保持以下约束：

- 视频连接先于控制连接建立。
- 分辨率以设备元数据为准，触摸坐标必须按显示区域换算。
- 用户主动停止、设备切换和异常断开要区分，避免无意义的自动重连循环。
- 会话结束后及时关闭 WebSocket、ADB forward 和后台任务。

## 文件与 APK

文件传输使用本机路径和设备路径，不依赖浏览器上传整个目录。APK 提取通过设备包列表、`pm path` 和 ADB 拉取完成；受权限限制的应用应单独报告失败，不阻断批量任务。

## 维护注意

- Android `/data/...` 是设备路径，不应与项目 `.local/data` 混淆。
- Scrcpy 协议升级时优先核对握手、帧头和控制消息结构。
- 新增机器相关路径时写入 `.local/data/adb_master/config.json`，不要写死在源码中。
