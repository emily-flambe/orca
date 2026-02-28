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
# Find and kill any running orca process (node with orca in args)
pkill -f "node.*orca.*start" 2>/dev/null || true
sleep 1

echo "[deploy] starting Orca..."
npx tsx src/cli/index.ts start &
disown

echo "[deploy] done. Orca is running in the background."
