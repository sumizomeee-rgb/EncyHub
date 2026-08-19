@echo off
setlocal
chcp 65001 >nul

set "SSH_CONFIG=E:/Such_Proj/Other/Haru-ssh-setup/hosts/harucode-template/ssh_config"
set "TARGET=harucode-template"
set "REMOTE_ROOT=/home/harucode/EncyHub"
set "NO_PAUSE=%~1"

echo [1/5] 正在更新部署机上的 EncyHub ...
ssh -F "%SSH_CONFIG%" -o BatchMode=yes -o ConnectTimeout=10 "%TARGET%" "set -eu; git -C '%REMOTE_ROOT%' pull --ff-only" || goto :fail

echo [2/5] 正在安装前端依赖并构建 ...
ssh -F "%SSH_CONFIG%" -o BatchMode=yes -o ConnectTimeout=10 "%TARGET%" "set -eu; cd '%REMOTE_ROOT%'; if [ -f frontend/package-lock.json ]; then npm --prefix frontend ci --include=optional --silent; else npm --prefix frontend install --silent; fi; npm --prefix frontend run build" || goto :fail

echo [3/5] 正在通过 systemd 重启 Hub ...
ssh -F "%SSH_CONFIG%" -o BatchMode=yes -o ConnectTimeout=10 "%TARGET%" "set -eu; systemctl --user restart encyhub.service; for i in $(seq 1 30); do if curl -fsS 'http://127.0.0.1:9524/api/hub/tools' >/dev/null 2>&1; then exit 0; fi; sleep 1; done; echo '[ERROR] Hub 30 秒内未恢复'; systemctl --user status encyhub.service --no-pager; exit 1" || goto :fail

echo [4/5] 正在确保 GM Console 启动 ...
ssh -F "%SSH_CONFIG%" -o BatchMode=yes -o ConnectTimeout=10 "%TARGET%" "set -eu; if ! curl -fsS 'http://127.0.0.1:9524/api/gm_console/' >/dev/null 2>&1; then curl -fsS -X POST 'http://127.0.0.1:9524/api/hub/tools/gm_console/start' >/dev/null || true; fi; for i in $(seq 1 30); do if curl -fsS 'http://127.0.0.1:9524/api/gm_console/' >/dev/null 2>&1; then exit 0; fi; sleep 1; done; echo '[ERROR] GM Console 30 秒内未恢复'; curl -fsS 'http://127.0.0.1:9524/api/hub/tools/gm_console' || true; exit 1" || goto :fail

echo [5/5] 正在验证服务状态 ...
ssh -F "%SSH_CONFIG%" -o BatchMode=yes -o ConnectTimeout=10 "%TARGET%" "set -eu; systemctl --user is-active --quiet encyhub.service; curl -fsS 'http://127.0.0.1:9524/api/hub/tools/gm_console'; echo; ss -ltn 2>/dev/null | grep -E ':(9524|12581)[[:space:]]'" || goto :fail

echo.
echo [OK] 部署机 EncyHub 已更新并重启，GM Console 已启动。
goto :end

:fail
echo.
echo [ERROR] 更新或重启失败，请检查上方输出与远端 systemd 日志。
if /i not "%NO_PAUSE%"=="--no-pause" pause
exit /b 1

:end
if /i not "%NO_PAUSE%"=="--no-pause" pause
exit /b 0
