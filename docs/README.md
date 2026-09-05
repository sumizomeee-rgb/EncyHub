# EncyHub 文档

这里仅维护与当前实现一致的说明。历史方案、施工步骤和失败尝试不再长期保留；需要追溯时使用 Git 历史。

## 平台

- [系统架构](architecture.md)
- [部署与本机配置](deployment.md)
- [ADB Master](adb-master.md)
- [FlowSVN](flow-svn.md)
- [iOS Master](ios-master.md)

## GM Console

- [总览与连接模型](gm-console/overview.md)
- [Hierarchy 与 Inspector](gm-console/hierarchy.md)
- [Lua UI Inspector](gm-console/lua-ui-inspector.md)
- [分包监控](gm-console/subpackage-monitor.md)
- [配表查看器](gm-console/table-viewer.md)
- [游戏日志](gm-console/game-log.md)

## 维护原则

- 文档描述当前行为，不复制大段正式源码。
- 尚未实现的想法放入独立提案，完成后合并到对应现状文档。
- 调试流水、临时接手提示词和逐文件施工清单不进入长期文档。
- 行为以代码和测试为准；文档发现偏差时，应在同一次改动中修正。
