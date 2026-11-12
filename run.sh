#!/bin/bash
set -e

# Move to script directory
cd "$(dirname "$0")"

echo "=== Starting VoxPrep — AI Voice Interview Simulator ==="

# Check virtual environment
if [ ! -d ".venv" ]; then
    echo "Creating virtual environment using uv/python3..."
    uv venv .venv 2>/dev/null || python3 -m venv .venv
fi

source .venv/bin/activate

echo "Verifying Python dependencies..."
if command -v uv >/dev/null 2>&1; then
    uv pip install -r requirements.txt
else
    .venv/bin/python -m pip install -r requirements.txt
fi

echo "=== Launching web server ==="
echo "Application running locally at: http://127.0.0.1:8000"
echo "Press Ctrl+C to stop."
echo "=============================================="

uvicorn backend.main:app --host 127.0.0.1 --port 8000 --reload
