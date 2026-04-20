#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

echo "========================================"
echo "  EncyHub Stop Script"
echo "========================================"
echo ""

HUB_PORT=9524
KILLED=0

# 1. Kill tool subprocesses from registry.json
echo "[1/3] Stopping tool subprocesses..."
if [ -f "data/registry.json" ]; then
    while IFS= read -r PID; do
        PID=$(echo "$PID" | tr -d ', ')
        if [ -n "$PID" ] && [ "$PID" -gt 0 ] 2>/dev/null; then
            if kill -9 "$PID" 2>/dev/null; then
                echo "      Killed tool process PID=$PID"
                KILLED=1
            fi
        fi
    done < <(grep -oP '"pid":\s*\K[0-9]+' data/registry.json 2>/dev/null || true)
fi
if [ $KILLED -eq 0 ]; then
    echo "      No tool processes found"
fi
echo "      Done"

# 2. Kill Hub process on port
echo ""
echo "[2/3] Stopping Hub process on port $HUB_PORT..."
KILLED_HUB=0
HUB_PID=$(lsof -ti :$HUB_PORT 2>/dev/null || true)
if [ -n "$HUB_PID" ]; then
    kill -9 $HUB_PID 2>/dev/null || true
    echo "      Killed Hub process PID=$HUB_PID"
    KILLED_HUB=1
fi
if [ $KILLED_HUB -eq 0 ]; then
    echo "      Hub not running"
fi

# 3. Clean registry PIDs
echo ""
echo "[3/3] Cleaning up registry..."
if [ -f ".venv/bin/python" ]; then
    .venv/bin/python -c "
import json, pathlib
p = pathlib.Path('data/registry.json')
if p.exists():
    d = json.loads(p.read_text('utf-8'))
    for t in d.values():
        t.update(pid=None, port=None)
    p.write_text(json.dumps(d, indent=2, ensure_ascii=False), 'utf-8')
" 2>/dev/null || true
    echo "      Registry cleaned"
else
    echo "      Skipped (venv not found)"
fi

echo ""
echo "========================================"
echo "  EncyHub stopped"
echo "========================================"
sleep 3
