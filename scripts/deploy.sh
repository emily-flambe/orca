#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# deploy.sh — Pull latest main, rebuild frontend, restart Orca
# Single deployment path — always use this script to deploy Orca.
# ---------------------------------------------------------------------------
set -euo pipefail

ORCA_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ORCA_DIR"

echo "[deploy] waiting for active sessions to finish..."
MAX_WAIT=900  # 15 min safety timeout
WAITED=0
while true; do
  active=$(curl -s http://localhost:4000/api/status | node -e "
    let d='';process.stdin.on('data',c=>d+=c);
    process.stdin.on('end',()=>console.log(JSON.parse(d).activeSessions||0))" 2>/dev/null) || active=""
  # If curl/parse failed (server not running), proceed immediately
  if [ -z "$active" ]; then
    echo "[deploy] Orca not responding — proceeding immediately"
    break
  fi
  [ "$active" = "0" ] && break
  if [ "$WAITED" -ge "$MAX_WAIT" ]; then
    echo "[deploy] timeout after ${MAX_WAIT}s — deploying anyway ($active sessions orphaned)"
    break
  fi
  echo "[deploy] $active session(s) still running, waiting 10s..."
  sleep 10
  WAITED=$((WAITED + 10))
done

echo "[deploy] killing existing Orca process (if any)..."
PIDFILE="$ORCA_DIR/orca.pid"
OLD_PID=""
if [ -f "$PIDFILE" ]; then
  OLD_PID=$(cat "$PIDFILE" 2>/dev/null || true)
  if [ -n "$OLD_PID" ]; then
    echo "[deploy] killing PID $OLD_PID (from orca.pid)..."
    if command -v taskkill &>/dev/null; then
      taskkill //PID "$OLD_PID" //F 2>/dev/null || true
    else
      kill -9 "$OLD_PID" 2>/dev/null || true
    fi
  fi
  rm -f "$PIDFILE"
else
  echo "[deploy] no orca.pid found — trying port-based kill..."
  if command -v taskkill &>/dev/null; then
    # Windows: find process listening on the orca port and kill it
    PORT="${ORCA_PORT:-4000}"
    netstat -ano 2>/dev/null \
      | grep ":${PORT}.*LISTENING" \
      | awk '{print $NF}' \
      | while read -r pid; do taskkill //PID "$pid" //F 2>/dev/null || true; done \
      || true
  else
    pkill -f "tsx.*cli/index" 2>/dev/null || true
  fi
fi

echo "[deploy] waiting for old process to exit..."
KILL_WAIT=0
KILL_MAX=20  # 20 iterations × 0.5s = 10s timeout
if [ -n "$OLD_PID" ]; then
  # Wait for the specific PID to disappear
  while kill -0 "$OLD_PID" 2>/dev/null; do
    if [ "$KILL_WAIT" -ge "$KILL_MAX" ]; then
      echo "[deploy] old process still alive after 10s — continuing anyway"
      break
    fi
    sleep 0.5
    KILL_WAIT=$((KILL_WAIT + 1))
  done
else
  # Wait for the port to become free
  PORT="${ORCA_PORT:-4000}"
  while netstat -ano 2>/dev/null | grep -q ":${PORT}.*LISTENING"; do
    if [ "$KILL_WAIT" -ge "$KILL_MAX" ]; then
      echo "[deploy] port ${PORT} still in use after 10s — continuing anyway"
      break
    fi
    sleep 0.5
    KILL_WAIT=$((KILL_WAIT + 1))
  done
fi
echo "[deploy] old process gone (waited ~$((KILL_WAIT / 2))s)"

echo "[deploy] pulling latest main..."
git checkout main
git pull origin main

echo "[deploy] installing dependencies..."
npm install

echo "[deploy] rebuilding frontend..."
(cd web && npm run build)

echo "[deploy] starting Orca..."
# Strip Claude nesting-detection env vars so spawned Claude sessions don't refuse to start.
# These are inherited when deploy.sh is run from within a Claude Code session.
unset CLAUDECODE CLAUDE_CODE_ENTRYPOINT
npx tsx src/cli/index.ts start >> "$ORCA_DIR/orca.log" 2>&1 &
disown

echo "[deploy] done. Orca is running in the background (logging to orca.log)."
