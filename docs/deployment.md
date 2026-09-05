# 部署与本机配置

通用部署流程保存在 `deploy/`，机器专属地址和路径保存在 `.local/deploy/targets.json`。这样脚本可提交复用，同时不会把个人 SSH 路径或部署机信息写入仓库。

## 配置部署目标

复制 `deploy/targets.example.json` 到 `.local/deploy/targets.json`，然后填写：

- `default`：默认目标名称
- `ssh_config`：本机 SSH config 路径
- `ssh_target`：SSH Host 名称
- `remote_root`：远端 EncyHub 仓库目录

## 命令

```powershell
# 查看解析后的目标
powershell -File deploy/encyhub.ps1 -Action show

# 仅拉取代码
powershell -File deploy/encyhub.ps1 -Action update

# 拉取、构建、重启并验证（默认）
powershell -File deploy/encyhub.ps1 -Action restart

# 同步允许跨机器复用的用户数据
powershell -File deploy/encyhub.ps1 -Action sync-data
```

也可继续使用同目录中的 BAT 包装脚本。目标名可作为参数传入；省略时使用配置中的 `default`。

## 重启部署流程

`restart` 会依次执行：

1. 远端 `git pull --ff-only`。
2. 安装前端依赖并运行生产构建。
3. 重启用户级 `encyhub.service`。
4. 确保 GM Console 已启动。
5. 验证 `.local/data`、Hub 状态以及 `9524`、`12581` 监听端口。

## 数据同步边界

`sync-data` 只同步明确适合跨机器复用的用户数据：

- `gm_console/custom_gm.json`

不会同步 ADB/iOS 设备信息与路径历史、进程注册表、FlowSVN 本机路径、HaruRoot 路径或可再生成缓存。
