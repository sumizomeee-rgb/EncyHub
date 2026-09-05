# FlowSVN

FlowSVN 管理 SVN 更新任务及其执行记录。

## 数据位置

- 后端：`tools/flow_svn/`
- 本机配置：`.local/data/flow_svn/config.json`
- 日志：`.local/logs/flow_svn/`
- 可共享模板：`config/flow_svn/config.example.json`

任务通常包含当前机器上的工作副本路径，因此实际配置不应同步到其他机器或提交到 Git。

## 维护原则

- 任务执行必须使用当前配置文件推导出的项目本机目录。
- 调度器日志和任务结果要写入同一套 `.local` 目录，避免启动方式不同导致查错实例。
- 修改计划任务或启动入口后，应同时验证实际执行用户、工作目录和 Python 环境。
