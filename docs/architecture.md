# 系统架构

EncyHub 是一个 FastAPI Hub 加多个独立工具服务组成的开发工具平台。React 前端通过 Hub 的统一入口访问工具，Hub 负责工具注册、进程生命周期、HTTP/WebSocket 代理和静态资源服务。

## 目录职责

```text
EncyHub/
├── hub_core/       Hub 配置、注册表、进程管理和代理
├── tools/          各工具后端
├── frontend/       React 前端
├── config/         可提交的配置模板
├── docs/           当前有效文档
├── deploy/         通用部署流程
├── assets/         随项目分发的资源
└── .local/         当前机器的数据、日志、缓存和部署目标
```

`.venv`、`node_modules`、`.pytest_cache` 和 `frontend/dist` 继续使用各自生态的标准位置，不迁入 `.local`。

## 运行模型

Hub 默认监听 `9524`。工具由 `hub_core.process_manager` 启动，并从 `.local/data/<tool_id>` 获取独立数据目录。端口与进程状态记录在 `.local/data/registry.json`。

前端生产资源来自 `frontend/dist`。HTTP 和 WebSocket 请求均从 Hub 入口代理到对应工具，因此浏览器不需要直接知道工具进程端口。

## 本机状态

默认路径由 `hub_core.config` 统一提供：

- 数据：`.local/data`
- 日志：`.local/logs`
- 缓存：`.local/cache`

可用 `ENCYHUB_LOCAL_DIR` 覆盖整个本机目录。首次加载新版配置时，程序会尽力把旧 `data/`、`logs/` 内容合并迁移；目标已存在的文件不会被覆盖。

## 扩展工具

新增工具通常需要：

1. 在 `tools/<tool_id>/` 提供 FastAPI 应用。
2. 在注册表中声明显示名称、入口模块和启动参数。
3. 在 `frontend/src/pages/` 增加页面并接入路由。
4. 将实际配置写入工具的数据目录，将可共享模板写入 `config/`。
