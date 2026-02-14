@echo off
setlocal enabledelayedexpansion

cd /d "%~dp0"

echo ========================================
echo   EncyHub Stop Script
echo ========================================
echo.

set HUB_PORT=9524
set KILLED=0

:: 1. Kill tool subprocesses from registry.json
echo [1/3] Stopping tool subprocesses...
if exist "data\registry.json" (
    for /f "tokens=*" %%a in ('findstr /r "\"pid\": [0-9]" data\registry.json') do (
        for /f "tokens=2 delims=: " %%p in ("%%a") do (
            set "PID=%%p"
            set "PID=!PID:,=!"
            if !PID! GTR 0 (
                taskkill /F /T /PID !PID! >nul 2>&1
                if not errorlevel 1 (
                    echo       Killed tool process PID=!PID!
                    set KILLED=1
                )
            )
        )
    )
)
if %KILLED%==0 echo       No tool processes found
echo       Done

:: 2. Kill Hub process on port
echo.
echo [2/3] Stopping Hub process on port %HUB_PORT%...
set KILLED_HUB=0
for /f "tokens=5" %%a in ('netstat -aon ^| findstr ":%HUB_PORT% " ^| findstr "LISTENING"') do (
    taskkill /F /T /PID %%a >nul 2>&1
    if not errorlevel 1 (
        echo       Killed Hub process PID=%%a
        set KILLED_HUB=1
    )
)
if %KILLED_HUB%==0 echo       Hub not running

:: 3. Clean registry PIDs
echo.
echo [3/3] Cleaning up registry...
if exist ".venv\Scripts\python.exe" (
    .venv\Scripts\python.exe -c "import json,pathlib;p=pathlib.Path('data/registry.json');d=json.loads(p.read_text('utf-8')) if p.exists() else {};[t.update(pid=None,port=None) for t in d.values()];p.write_text(json.dumps(d,indent=2,ensure_ascii=False),'utf-8') if d else None" 2>nul
    echo       Registry cleaned
) else (
    echo       Skipped (venv not found)
)

echo.
echo ========================================
echo   EncyHub stopped
echo ========================================
timeout /t 3
