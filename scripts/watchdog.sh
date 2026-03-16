#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="/c/Users/emily/Documents/Github/orca"
cd "$PROJECT_DIR"

PM2="$PROJECT_DIR/node_modules/.bin/pm2"
LOG_FILE="$PROJECT_DIR/logs/watchdog.log"
STATE_FILE="$PROJECT_DIR/deploy-state.json"

mkdir -p "$PROJECT_DIR/logs"

log() { echo "[watchdog] $(date '+%Y-%m-%d %H:%M:%S') $*" >> "$LOG_FILE"; }

# Trim log to last 1000 lines to prevent unbounded growth
trim_log() {
  if [[ -f "$LOG_FILE" ]]; then
    local line_count
    line_count=$(wc -l < "$LOG_FILE" 2>/dev/null || echo "0")
    if [[ "$line_count" -gt 1000 ]]; then
      tail -n 1000 "$LOG_FILE" > "$LOG_FILE.tmp" && mv "$LOG_FILE.tmp" "$LOG_FILE"
    fi
  fi
}

# Read active port from deploy-state.json
get_active_port() {
  if [[ -f "$STATE_FILE" ]]; then
    node -e "
      var fs=require('fs');
      try { console.log(JSON.parse(fs.readFileSync('$STATE_FILE','utf8')).activePort||4000) }
      catch(e) { console.log(4000) }
    "
  else
    echo "4000"
  fi
}

FAILED=false
FAILURES=""

# Check 1: PM2 daemon responsive
if ! $PM2 ping &>/dev/null; then
  FAILED=true
  FAILURES="PM2 daemon not responsive"
fi

# Check 2: Orca health on active port
ACTIVE_PORT=$(get_active_port)
if ! curl -sf "http://localhost:$ACTIVE_PORT/api/status" > /dev/null 2>&1; then
  FAILED=true
  FAILURES="${FAILURES:+$FAILURES; }Orca not responding on port $ACTIVE_PORT"
fi

# Check 3: Inngest health
if ! curl -sf "http://localhost:8288/" > /dev/null 2>&1; then
  FAILED=true
  FAILURES="${FAILURES:+$FAILURES; }Inngest not responding on port 8288"
fi

if [[ "$FAILED" == "true" ]]; then
  log "FAILURE DETECTED: $FAILURES"
  log "triggering recovery via deploy.sh..."
  bash "$PROJECT_DIR/scripts/deploy.sh" >> "$LOG_FILE" 2>&1 || log "deploy.sh exited with error (exit code $?)"
  log "recovery attempt completed"
fi

trim_log
