#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

echo "========================================"
echo "  EncyHub Startup Script"
echo "========================================"
echo ""

# 1. Check Python
echo "[1/6] Checking environment..."
if command -v python3 &>/dev/null; then
    PYTHON=python3
elif command -v python &>/dev/null; then
    PYTHON=python
else
    echo "[ERROR] Python not found"
    exit 1
fi
echo "      Python: OK ($($PYTHON --version 2>&1))"

# Check Node
if command -v node &>/dev/null; then
    echo "      Node.js: OK ($(node --version))"
else
    echo "[ERROR] Node.js not found"
    exit 1
fi

# 2. Create venv
echo ""
echo "[2/6] Setting up virtual environment..."
if [ ! -f ".venv/bin/activate" ]; then
    echo "      Creating venv..."
    $PYTHON -m venv .venv
fi
echo "      Venv: OK"

# 3. Install Python deps
echo ""
echo "[3/6] Installing Python dependencies..."
source .venv/bin/activate
pip install fastapi "uvicorn[standard]" httpx psutil websockets python-multipart --quiet
echo "      Dependencies: OK"

# 4. Build frontend
echo ""
echo "[4/6] Building frontend..."
if [ -f "frontend/package.json" ]; then
    cd frontend
    npm install --silent 2>/dev/null || true
    npm run build 2>/dev/null || true
    cd ..
fi
echo "      Frontend: OK"

# 5. Kill old EncyHub process on port 9524
echo ""
echo "[5/6] Cleaning up old processes..."
OLD_PID=$(lsof -ti :9524 2>/dev/null || true)
if [ -n "$OLD_PID" ]; then
    echo "      Killing old process on port 9524 (PID=$OLD_PID)"
    kill -9 $OLD_PID 2>/dev/null || true
fi
sleep 1
echo "      Cleanup: OK"

# 6. Start server
echo ""
echo "[6/6] Starting EncyHub..."
echo ""
echo "========================================"
echo "  URL: http://localhost:9524"
echo "  LAN: http://0.0.0.0:9524"
echo "  (Ctrl+C or Dashboard to stop)"
echo "========================================"
echo ""

start_loop() {
    .venv/bin/python main.py
    EXIT_CODE=$?

    # Exit code 0 = normal shutdown (Ctrl+C / Dashboard), don't restart
    if [ $EXIT_CODE -eq 0 ]; then
        echo ""
        echo "[EncyHub] Stopped normally."
        exit 0
    fi

    # Non-zero = killed externally, auto restart
    echo ""
    echo "[EncyHub] Process exited unexpectedly (code=$EXIT_CODE), restarting in 3s..."
    sleep 3
    start_loop
}

start_loop
