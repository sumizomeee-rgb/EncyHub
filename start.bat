@echo off
setlocal

cd /d "%~dp0"

echo ========================================
echo   EncyHub Startup Script
echo ========================================
echo.

:: Check Python
echo [1/6] Checking environment...
where python >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Python not found
    pause
    exit /b 1
)
echo       Python: OK

:: Check Node
where node >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Node.js not found
    pause
    exit /b 1
)
echo       Node.js: OK

:: Create venv
echo.
echo [2/6] Setting up virtual environment...
if not exist ".venv\Scripts\activate.bat" (
    echo       Creating venv...
    python -m venv .venv
)
echo       Venv: OK

:: Install Python deps
echo.
echo [3/6] Installing Python dependencies...
call .venv\Scripts\activate.bat
pip install fastapi "uvicorn[standard]" httpx psutil websockets python-multipart --quiet
echo       Dependencies: OK

:: Build frontend
echo.
echo [4/6] Building frontend...
if exist "frontend\package.json" (
    cd frontend
    call npm install --silent 2>nul
    call npm run build 2>nul
    cd ..
)
echo       Frontend: OK

:: Kill old EncyHub process on port 9524
echo.
echo [5/6] Cleaning up old processes...
for /f "tokens=5" %%a in ('netstat -aon ^| findstr ":9524 " ^| findstr "LISTENING"') do (
    echo       Killing old process on port 9524 ^(PID=%%a^)
    taskkill /F /PID %%a >nul 2>&1
)
timeout /t 1 /nobreak >nul
echo       Cleanup: OK

:: Start server
echo.
echo [6/6] Starting EncyHub...
echo.
echo ========================================
echo   URL: http://localhost:9524
echo   LAN: http://0.0.0.0:9524
echo   (Ctrl+C or Dashboard to stop)
echo ========================================
echo.

start "" "http://localhost:9524"

:: Marks the Hub process as supervised by this script. The restart API then exits
:: with RESTART_EXIT_CODE only and never spawns a second start.bat (prevents two
:: supervisors from killing each other's process in an endless restart loop).
set ENCYHUB_SUPERVISOR=start_bat

:start_loop
.venv\Scripts\python.exe main.py
set EXIT_CODE=%ERRORLEVEL%

:: Exit code 0 = normal shutdown (Ctrl+C / Dashboard), don't restart
if %EXIT_CODE%==0 (
    echo.
    echo [EncyHub] Stopped normally.
    goto end
)

:: Exit code 42 = platform restart requested (Dashboard restart button).
:: This script alone re-launches the hub (keep in sync with RESTART_EXIT_CODE
:: in hub_core/config.py).
if %EXIT_CODE%==42 (
    echo.
    echo [EncyHub] Restart requested, restarting in 3s...
    timeout /t 3 /nobreak >nul
    goto start_loop
)

:: Any other non-zero = crashed or killed externally: do NOT auto restart,
:: so two supervisors can never fight over port 9524 again.
echo.
echo [EncyHub] Process exited (code=%EXIT_CODE%), not restarting.
goto end

:end
pause
