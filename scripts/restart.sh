#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# restart.sh — Lightweight restart for Orca + Inngest
#
# Brings services back up without the full deploy process (no git pull, no
# npm install, no frontend build). Safe to run when things are already running.
# ---------------------------------------------------------------------------
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

log() { echo "[restart] $(date '+%H:%M:%S') $*"; }

# Helper: extract a field from JSON via stdin. Usage: echo '{}' | json_field fieldName default
json_field() {
  node -e "
    var d='';
    process.stdin.on('data',function(c){d+=c});
    process.stdin.on('end',function(){
      try { var v=JSON.parse(d)['$1']; console.log(v!==undefined&&v!==null?v:'$2') }
      catch(e) { console.log('$2') }
    })
  "
}

# ---------------------------------------------------------------------------
# Skip if a deploy is in progress
# ---------------------------------------------------------------------------
LOCKFILE="$PROJECT_DIR/.deploy.lock"
if [[ -f "$LOCKFILE" ]]; then
  LOCK_PID=$(cat "$LOCKFILE" 2>/dev/null || true)
  if [[ -n "$LOCK_PID" ]] && kill -0 "$LOCK_PID" 2>/dev/null; then
    log "deploy in progress (PID=$LOCK_PID) — skipping restart"
    exit 0
  fi
  log "stale deploy lockfile found (PID=$LOCK_PID not running) — ignoring"
fi

# ---------------------------------------------------------------------------
# Read deploy state
# ---------------------------------------------------------------------------
STATE_FILE="$PROJECT_DIR/deploy-state.json"
if [[ -f "$STATE_FILE" ]]; then
  ACTIVE_PORT=$(cat "$STATE_FILE" | json_field activePort 4000)
else
  ACTIVE_PORT=4000
fi

log "active port: $ACTIVE_PORT"

cd "$PROJECT_DIR"
PM2="$PROJECT_DIR/node_modules/.bin/pm2"

# ---------------------------------------------------------------------------
# Detect platform
# ---------------------------------------------------------------------------
IS_WINDOWS=false
if [[ "$(uname -s)" == MINGW* || "$(uname -s)" == MSYS* || "$(uname -s)" == CYGWIN* ]]; then
  IS_WINDOWS=true
fi

# ---------------------------------------------------------------------------
# Helper: get PM2 status for a process by name
# ---------------------------------------------------------------------------
pm2_status() {
  local name="$1"
  local jlist
  jlist=$($PM2 jlist 2>/dev/null || echo "[]")
  echo "$jlist" | node -e "
    var d='';
    process.stdin.on('data',function(c){d+=c});
    process.stdin.on('end',function(){
      try {
        var procs=JSON.parse(d);
        var p=procs.find(function(p){return p.name==='$name'});
        console.log(p?p.pm2_env.status:'not_found');
      } catch(e){console.log('not_found')}
    })
  " 2>/dev/null || echo "not_found"
}

# ---------------------------------------------------------------------------
# Kill stale process on port 8288 (cross-platform)
# ---------------------------------------------------------------------------
kill_stale_port_8288() {
  if [[ "$IS_WINDOWS" == "true" ]]; then
    STALE_PID=$(netstat -ano 2>/dev/null | grep ':8288 ' | grep LISTENING | awk '{print $NF}' | head -1 || true)
    if [[ -n "$STALE_PID" && "$STALE_PID" != "0" ]]; then
      log "found stale process (PID=$STALE_PID) on port 8288 — killing..."
      taskkill //PID "$STALE_PID" //F 2>/dev/null || true
      sleep 2
    fi
  else
    STALE_PIDS=$(lsof -ti tcp:8288 2>/dev/null || true)
    if [[ -n "$STALE_PIDS" ]]; then
      log "found stale process on port 8288 — killing..."
      echo "$STALE_PIDS" | xargs kill -9 2>/dev/null || true
      sleep 2
    fi
  fi
}

# ---------------------------------------------------------------------------
# Ensure Inngest dev server is running
# ---------------------------------------------------------------------------
log "checking Inngest..."
INNGEST_STATUS=$(pm2_status "inngest")

if [[ "$INNGEST_STATUS" == "online" ]]; then
  log "Inngest already online"
else
  if [[ "$INNGEST_STATUS" != "not_found" ]]; then
    log "Inngest status=$INNGEST_STATUS — cleaning up before restart..."
    $PM2 delete inngest 2>/dev/null || true
  fi

  kill_stale_port_8288

  log "starting Inngest dev server..."
  $PM2 start ecosystem.config.cjs --only inngest
  sleep 3
fi

# Health check Inngest (retry up to 15 times, 2s apart = 30s max)
log "health checking Inngest on port 8288..."
INNGEST_OK=false
for i in $(seq 1 15); do
  if curl -sf "http://localhost:8288/" > /dev/null 2>&1; then
    INNGEST_OK=true
    log "Inngest health check passed on attempt $i"
    break
  fi
  sleep 2
done

if [[ "$INNGEST_OK" != "true" ]]; then
  log "ERROR: Inngest health check failed after 30s"
  exit 1
fi

# ---------------------------------------------------------------------------
# Ensure Orca is running on active port
# ---------------------------------------------------------------------------
ORCA_NAME="orca-${ACTIVE_PORT}"
log "checking $ORCA_NAME..."
ORCA_STATUS=$(pm2_status "$ORCA_NAME")

if [[ "$ORCA_STATUS" == "online" ]]; then
  log "$ORCA_NAME already online"
else
  if [[ "$ORCA_STATUS" != "not_found" ]]; then
    log "$ORCA_NAME status=$ORCA_STATUS — cleaning up before restart..."
    $PM2 delete "$ORCA_NAME" 2>/dev/null || true
  fi

  log "starting $ORCA_NAME..."
  unset CLAUDECODE CLAUDE_CODE_ENTRYPOINT 2>/dev/null || true
  $PM2 start ecosystem.config.cjs --only "$ORCA_NAME"
fi

# Health check Orca (retry up to 30 times, 2s apart = 60s max)
log "health checking Orca on port $ACTIVE_PORT..."
ORCA_OK=false
for i in $(seq 1 30); do
  if curl -sf "http://localhost:$ACTIVE_PORT/api/status" > /dev/null 2>&1; then
    ORCA_OK=true
    log "Orca health check passed on attempt $i"
    break
  fi
  sleep 2
done

if [[ "$ORCA_OK" != "true" ]]; then
  log "ERROR: Orca health check failed after 60s"
  exit 1
fi

# ---------------------------------------------------------------------------
# Register Orca with Inngest
# ---------------------------------------------------------------------------
log "registering Inngest functions..."
INNGEST_REGISTER=$(curl -sf -X PUT "http://localhost:$ACTIVE_PORT/api/inngest" 2>&1 || true)
if echo "$INNGEST_REGISTER" | grep -q '"Successfully registered"'; then
  log "Inngest functions registered successfully"
else
  log "WARNING: Inngest registration may have failed: $INNGEST_REGISTER"
fi

log "done! Orca running on port $ACTIVE_PORT"
