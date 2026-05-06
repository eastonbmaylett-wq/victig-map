#!/bin/bash
# Run victig-map locally at http://localhost:8001
# Data stored in ./local-data/ (not the Fly.io volume)
export DATA_DIR="$(pwd)/local-data"
mkdir -p "$DATA_DIR"
echo "Starting victig-map at http://localhost:8001"
uv run uvicorn main:app --reload --port 8001
