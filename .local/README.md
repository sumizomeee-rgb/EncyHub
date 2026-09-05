# 本机目录

这里存放只属于当前开发机或部署机的内容，不纳入 Git：

- `data/`：运行状态、实际配置和用户数据
- `logs/`：Hub 与工具日志
- `cache/`：可再生成的缓存
- `deploy/targets.json`：部署目标、SSH 配置与远端目录

源码、通用脚本和可共享配置模板不要放在这里。部署目标配置可从
`deploy/targets.example.json` 复制后按本机环境修改。
