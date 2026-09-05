# iOS Master

iOS Master 是与 ADB Master 并列的设备管理工具，提供设备发现、信息查看、Syslog、文件访问、截图、应用安装与管理等能力。

## 数据与入口

- 后端：`tools/ios_master/`
- 前端：`frontend/src/pages/IosMaster.jsx`
- 本机数据：`.local/data/ios_master/`

## 平台差异

iOS 文件访问受 AFC、应用容器和设备信任状态限制，不能假设拥有 Android ADB 式的全局文件系统权限。页面只应展示当前连接方式确实支持的能力，并把未信任、驱动缺失和权限受限作为明确错误反馈。

## 配置原则

设备昵称、路径历史等本机状态写入 `.local/data/ios_master/config.json`。可跨机器复用的配置可通过部署数据同步命令传输，但运行时连接状态不应同步。
