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
echo ========================================
echo.
.venv\Scripts\python.exe main.py

pause
