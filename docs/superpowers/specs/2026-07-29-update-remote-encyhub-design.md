# 远端 EncyHub 更新脚本设计

## 目标

在 `deploy` 目录新增一个 Windows BAT 脚本，使开发者能够通过一次执行更新 Haru Linux 部署机上的 EncyHub 仓库。

## 已确认环境

- SSH 配置：`E:\Such_Proj\Other\Haru-ssh-setup\ssh_config`
- SSH 目标别名：`haru-public-linux`
- 远端用户：`harucode`
- 远端仓库：`/home/harucode/EncyHub`
- 远端分支：`master`

## 脚本行为

新增 `deploy/update_encyhub_on_linux.bat`。

脚本通过指定的 SSH 配置连接部署机，并在远端执行：

```bash
git -C /home/harucode/EncyHub pull --ff-only
```

使用 `--ff-only` 可以避免分支发生分叉时自动生成合并提交。此时脚本应直接失败，并保留 Git 的原始错误信息。

## 范围边界

脚本只更新远端 Git 工作树，不执行以下操作：

- 不重启 `encyhub.service`
- 不安装或更新 Python 依赖
- 不修改运行时数据
- 不切换远端分支
- 不自动处理远端未提交修改或分支分叉

## 连接与错误处理

- 使用 `BatchMode=yes`，确保免密连接不可用时快速失败，不进入密码交互。
- 使用有限的 SSH 连接超时时间，避免目标不可达时长时间等待。
- SSH 或 Git 命令失败时返回非零退出码，并输出简短的检查提示。
- 更新成功时返回退出码 `0`。

## 验证

实施时应先通过自动化测试验证脚本包含正确的 SSH 配置、目标别名、远端路径、快进拉取参数，以及不含服务重启命令。随后执行 BAT 语法检查，并通过只读方式验证 SSH 目标和远端仓库路径。

