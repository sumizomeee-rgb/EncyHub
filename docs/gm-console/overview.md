# GM Console 总览

GM Console 通过单一 TCP 监听端口连接多个游戏实例，并向 Web 页面提供 Lua 执行、运行时检查和专项监控能力。

## 入口

- 后端：`tools/gm_console/`
- 游戏端：`tools/gm_console/runtime_gm_client.lua`
- 前端：`frontend/src/pages/GmConsole.jsx`
- 本机数据：`.local/data/gm_console/`

## 连接模型

默认握手端口为 `12581`。多个客户端共享该端口，服务端按会话标识区分连接。连接初期可使用临时标识，收到客户端信息后再切换为稳定标识。当前服务端会迁移 Animator 缓存和待完成 Lua 请求；新增任何以 `client_id` 为键的缓存或订阅时，也必须显式加入 rekey 迁移或清理逻辑。

前端只展示连接状态，不负责动态创建监听端口。Hub 通过统一的 HTTP/WebSocket 代理暴露 GM Console。

## RuntimeGM 代码

权威游戏端代码是 `runtime_gm_client.lua`。后端生成复制或注入内容时只替换启动调用中的连接地址，避免 README 和源码各维护一份。

实际配置包括：

- `custom_gm.json`：自定义 GM 项
- `haruroot_config.json`：本机游戏工程路径
- `proto_cache.json`：可再生成的协议缓存

其中只有 `custom_gm.json` 默认适合跨部署机同步。

## 功能文档

- [Hierarchy 与 Inspector](hierarchy.md)
- [Lua UI Inspector](lua-ui-inspector.md)
- [分包监控](subpackage-monitor.md)
- [配表查看器](table-viewer.md)
- [游戏日志](game-log.md)
