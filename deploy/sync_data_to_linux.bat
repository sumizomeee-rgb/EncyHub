@echo off
setlocal
REM ============================================================
REM  EncyHub 运行时数据同步（Windows 开发机 -> Linux 部署机，单向）
REM
REM  只同步 .local/data 下可跨机器复用的用户数据。
REM
REM  以下文件刻意【不同步】（机器状态或机器专属路径，各机独立）：
REM    registry.json、flow_svn/config.json、haruroot_config.json、proto_cache.json
REM ============================================================

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0encyhub.ps1" -Action sync-data -TargetName "%~1"
exit /b %ERRORLEVEL%
