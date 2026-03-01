#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# deploy.sh — Pull latest main, rebuild frontend, restart Orca
# Run after merging agent PRs on GitHub.
# ---------------------------------------------------------------------------
set -euo pipefail

ORCA_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ORCA_DIR"

echo "[deploy] pulling latest main..."
git checkout main
git pull origin main

echo "[deploy] installing dependencies..."
npm install

echo "[deploy] rebuilding frontend..."
(cd web && npm run build)

echo "[deploy] killing existing Orca process (if any)..."
# Kill any running orca process — use taskkill on Windows, pkill on Unix
if command -v taskkill &>/dev/null; then
  # Windows: find node.exe PIDs running orca and kill them
  wmic process where "name='node.exe' and CommandLine like '%orca%start%'" get ProcessId 2>/dev/null \
    | grep -oE '[0-9]+' \
    | while read -r pid; do taskkill //PID "$pid" //F 2>/dev/null || true; done
else
  pkill -f "node.*orca.*start" 2>/dev/null || true
fi
sleep 2

echo "[deploy] starting Orca..."
npx tsx src/cli/index.ts start >> "$ORCA_DIR/orca.log" 2>&1 &
disown

echo "[deploy] done. Orca is running in the background."
