#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

echo "========================================"
echo "  EncyHub Startup Script"
echo "========================================"
echo ""

# 1. Check Python (require >= 3.10; skip old system pythons)
echo "[1/6] Checking environment..."
PYTHON=""
for cand in python3.13 python3.12 python3.11 python3.10 python3 python; do
    if command -v "$cand" &>/dev/null && "$cand" -c 'import sys; raise SystemExit(0 if sys.version_info >= (3, 10) else 1)' 2>/dev/null; then
        PYTHON="$cand"
        break
    fi
done
if [ -z "$PYTHON" ]; then
    echo "[ERROR] Python >= 3.10 not found"
    exit 1
fi
echo "      Python: OK ($PYTHON - $($PYTHON --version 2>&1))"

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
RECREATE_VENV=0
if [ ! -f ".venv/bin/activate" ]; then
    RECREATE_VENV=1
else
    # Check venv Python version matches system Python
    VENV_PYVER=$(.venv/bin/python -c "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')" 2>/dev/null || echo "0.0")
    SYS_PYVER=$($PYTHON -c "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')" 2>/dev/null || echo "0.0")
    if [ "$VENV_PYVER" != "$SYS_PYVER" ]; then
        echo "      venv Python ($VENV_PYVER) != system Python ($SYS_PYVER), recreating..."
        rm -rf .venv
        RECREATE_VENV=1
    fi
fi
if [ $RECREATE_VENV -eq 1 ]; then
    echo "      Creating venv with $PYTHON..."
    $PYTHON -m venv .venv
fi
echo "      Venv: OK ($(.venv/bin/python -c 'import sys; print(sys.version.split()[0])'))"

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
    # Install only when node_modules is missing; use npm ci so package-lock.json
    # is never rewritten (keeps worktree clean for git pull on deploy machines).
    # After pulling dependency changes, run: npm ci --include=optional
    if [ ! -d node_modules ]; then
        npm ci --include=optional --silent 2>/dev/null || npm install --silent 2>/dev/null || true
    fi
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
