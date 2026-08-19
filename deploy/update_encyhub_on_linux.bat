@echo off
setlocal

set "SSH_CONFIG=E:/Such_Proj/Other/Haru-ssh-setup/hosts/harucode-template/ssh_config"
set "TARGET=harucode-template"
set "REMOTE_ROOT=/home/harucode/EncyHub"

echo [1/1] 正在更新部署机上的 EncyHub ...
ssh -F "%SSH_CONFIG%" -o BatchMode=yes -o ConnectTimeout=10 "%TARGET%" "git -C '%REMOTE_ROOT%' pull --ff-only" || goto :fail

echo.
echo [OK] EncyHub 代码更新完成。
pause
exit /b 0

:fail
echo.
echo [ERROR] 更新失败，请检查 SSH 连接和远端 Git 工作区。
pause
exit /b 1
