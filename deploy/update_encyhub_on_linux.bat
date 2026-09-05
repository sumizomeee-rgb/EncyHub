@echo off
setlocal
chcp 65001 >nul
set "TARGET_NAME=%~1"
set "NO_PAUSE=%~2"
if /i "%TARGET_NAME%"=="--no-pause" (
    set "TARGET_NAME="
    set "NO_PAUSE=--no-pause"
)
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0encyhub.ps1" -Action update -TargetName "%TARGET_NAME%"
set "EXIT_CODE=%ERRORLEVEL%"
if /i not "%NO_PAUSE%"=="--no-pause" pause
exit /b %EXIT_CODE%
