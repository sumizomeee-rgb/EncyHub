@echo off
setlocal
REM ============================================================
REM  EncyHub 运行时数据同步（Windows 开发机 -> Linux 部署机，单向）
REM
REM  只同步"用户数据"类文件：
REM    data/gm_console/custom_gm.json   自定义 GM 命令（跨机通用）
REM    data/adb_master/config.json      ADB 设备缓存与 push/pull 路径历史
REM    data/ios_master/config.json      iOS push/pull 路径历史
REM
REM  以下文件刻意【不同步】（机器状态或机器专属路径，各机独立）：
REM    data/registry.json               运行时状态（pid/port/启用记忆）
REM    data/flow_svn/config.json        SVN 任务含本机路径（如 F:\HaruTrunk）
REM    data/gm_console/haruroot_config.json  HaruRoot 路径（两机不同）
REM    data/gm_console/proto_cache.json 可再生的 proto 解析缓存
REM ============================================================

set "SSH_CONFIG=E:/Such_Proj/Other/Haru-ssh-setup/ssh_config"
set "TARGET=haru-public-linux"
set "LOCAL_ROOT=E:\Such_Proj\Other\EncyHub"
set "REMOTE_ROOT=/home/harucode/EncyHub"

echo [1/3] custom_gm.json ...
scp -F "%SSH_CONFIG%" "%LOCAL_ROOT%\data\gm_console\custom_gm.json" "%TARGET%:%REMOTE_ROOT%/data/gm_console/custom_gm.json" || goto :fail

echo [2/3] adb_master/config.json ...
scp -F "%SSH_CONFIG%" "%LOCAL_ROOT%\data\adb_master\config.json" "%TARGET%:%REMOTE_ROOT%/data/adb_master/config.json" || goto :fail

echo [3/3] ios_master/config.json ...
scp -F "%SSH_CONFIG%" "%LOCAL_ROOT%\data\ios_master\config.json" "%TARGET%:%REMOTE_ROOT%/data/ios_master/config.json" || goto :fail

echo.
echo [OK] 同步完成。若对应工具在部署机上正在运行，在页面重启该工具后生效。
exit /b 0

:fail
echo.
echo [ERROR] 同步失败，请检查 SSH 连接（ssh -F %SSH_CONFIG% %TARGET%）
exit /b 1
