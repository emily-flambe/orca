#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# deploy.sh — Blue/Green zero-downtime deploy for Orca
#
# Starts a new instance on a standby port, health checks it, switches the
# Cloudflare tunnel origin, drains the old instance, then kills it.
# Reads/writes deploy-state.json to alternate ports across deploys.
# ---------------------------------------------------------------------------
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

log() { echo "[deploy] $(date '+%H:%M:%S') $*"; }

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

# Helper: kill a process (cross-platform)
kill_pid() {
  local pid="$1"
  if command -v taskkill &>/dev/null; then
    taskkill //PID "$pid" //F 2>/dev/null || true
  else
    kill -9 "$pid" 2>/dev/null || true
  fi
}

# ---------------------------------------------------------------------------
# Read deploy state (defaults: active=4000, standby=4001)
# ---------------------------------------------------------------------------
STATE_FILE="$PROJECT_DIR/deploy-state.json"
if [[ -f "$STATE_FILE" ]]; then
  ACTIVE_PORT=$(cat "$STATE_FILE" | json_field activePort 4000)
  STANDBY_PORT=$(cat "$STATE_FILE" | json_field standbyPort 4001)
else
  ACTIVE_PORT=4000
  STANDBY_PORT=4001
fi

log "active=$ACTIVE_PORT  standby=$STANDBY_PORT"

# ---------------------------------------------------------------------------
# Save old PID BEFORE building (pidfile will be overwritten by new instance)
# ---------------------------------------------------------------------------
OLD_PID=""
for PIDFILE in "$PROJECT_DIR/orca-${ACTIVE_PORT}.pid" "$PROJECT_DIR/orca.pid"; do
  if [[ -f "$PIDFILE" ]]; then
    OLD_PID=$(cat "$PIDFILE" 2>/dev/null || true)
    if [[ -n "$OLD_PID" ]]; then
      log "old instance PID=$OLD_PID (from $PIDFILE)"
      break
    fi
  fi
done

if [[ -z "$OLD_PID" ]]; then
  log "WARNING: no pidfile found — old instance may need manual cleanup"
fi

# ---------------------------------------------------------------------------
# Pull, install, build
# ---------------------------------------------------------------------------
cd "$PROJECT_DIR"
log "pulling latest code..."
git checkout main
git pull origin main

log "installing dependencies..."
npm install

log "building frontend..."
(cd web && npm run build)

# ---------------------------------------------------------------------------
# Start new instance on standby port with scheduler paused
# ---------------------------------------------------------------------------
log "starting new instance on port $STANDBY_PORT (scheduler paused)..."
unset CLAUDECODE CLAUDE_CODE_ENTRYPOINT 2>/dev/null || true
ORCA_PORT=$STANDBY_PORT ORCA_EXTERNAL_TUNNEL=true \
  npx tsx src/cli/index.ts start --scheduler-paused \
  >> "$PROJECT_DIR/orca.log" 2>&1 &
NEW_PID=$!
disown
log "new instance PID=$NEW_PID"

# ---------------------------------------------------------------------------
# Health check new instance (retry up to 30 times, 2s apart = 60s max)
# ---------------------------------------------------------------------------
log "health checking new instance on port $STANDBY_PORT..."
HEALTH_OK=false
for i in $(seq 1 30); do
  if curl -sf "http://localhost:$STANDBY_PORT/api/status" > /dev/null 2>&1; then
    HEALTH_OK=true
    log "health check passed on attempt $i"
    break
  fi
  sleep 2
done

if [[ "$HEALTH_OK" != "true" ]]; then
  log "ERROR: health check failed after 60s — rolling back"
  kill_pid "$NEW_PID"
  exit 1
fi

# ---------------------------------------------------------------------------
# Update Cloudflare tunnel origin (if vars are set)
# ---------------------------------------------------------------------------
if [[ -f "$PROJECT_DIR/.env" ]]; then
  set -a
  source <(grep -E '^CLOUDFLARE_' "$PROJECT_DIR/.env" | sed 's/\r$//')
  set +a
fi

CF_TUNNEL_ID="${CLOUDFLARE_TUNNEL_ID:-}"
CF_ACCOUNT_ID="${CLOUDFLARE_ACCOUNT_ID:-}"
CF_API_TOKEN="${CLOUDFLARE_API_TOKEN:-}"

if [[ -n "$CF_TUNNEL_ID" && -n "$CF_ACCOUNT_ID" && -n "$CF_API_TOKEN" ]]; then
  log "switching Cloudflare tunnel origin to port $STANDBY_PORT..."

  CF_API_BASE="https://api.cloudflare.com/client/v4/accounts/$CF_ACCOUNT_ID/cfd_tunnel/$CF_TUNNEL_ID/configurations"

  CURRENT_CONFIG=$(curl -sf \
    -H "Authorization: Bearer $CF_API_TOKEN" \
    -H "Content-Type: application/json" \
    "$CF_API_BASE" || true)

  if [[ -z "$CURRENT_CONFIG" ]]; then
    log "WARNING: failed to fetch tunnel config — skipping tunnel update"
  else
    UPDATED_CONFIG=$(echo "$CURRENT_CONFIG" | node -e "
      var d='';
      process.stdin.on('data',function(c){d+=c});
      process.stdin.on('end',function(){
        var cfg=JSON.parse(d);
        var ingress=cfg.result.config.ingress.map(function(r){
          if(r.service&&r.service.indexOf('localhost')!==-1){
            r.service=r.service.replace(/:\d+/,':$STANDBY_PORT');
          }
          return r;
        });
        console.log(JSON.stringify({config:{ingress:ingress}}));
      })
    ")

    PUT_RESULT=$(curl -sf -X PUT \
      -H "Authorization: Bearer $CF_API_TOKEN" \
      -H "Content-Type: application/json" \
      -d "$UPDATED_CONFIG" \
      "$CF_API_BASE" || true)

    SUCCESS=$(echo "$PUT_RESULT" | json_field success false)
    if [[ "$SUCCESS" == "true" ]]; then
      log "tunnel origin switched to port $STANDBY_PORT"
    else
      log "WARNING: tunnel config update may have failed"
    fi
  fi
else
  log "WARNING: Cloudflare tunnel vars not set — skipping tunnel switch"
fi

# ---------------------------------------------------------------------------
# Drain old instance
# ---------------------------------------------------------------------------
if [[ -n "$OLD_PID" ]]; then
  log "draining old instance on port $ACTIVE_PORT..."
  curl -sf -X POST "http://localhost:$ACTIVE_PORT/api/deploy/drain" > /dev/null 2>&1 || true

  log "waiting for old instance sessions to drain..."
  DRAIN_WAITED=0
  DRAIN_MAX=300
  while true; do
    SESSIONS=$(curl -s "http://localhost:$ACTIVE_PORT/api/status" 2>/dev/null \
      | json_field activeSessions 0 || echo "0")
    if [[ "$SESSIONS" == "0" ]]; then
      log "old instance drained"
      break
    fi
    if [[ "$DRAIN_WAITED" -ge "$DRAIN_MAX" ]]; then
      log "WARNING: drain timeout after ${DRAIN_MAX}s ($SESSIONS sessions orphaned)"
      break
    fi
    log "  $SESSIONS session(s) still active, waiting..."
    sleep 5
    DRAIN_WAITED=$((DRAIN_WAITED + 5))
  done

  log "killing old instance (PID=$OLD_PID)..."
  kill_pid "$OLD_PID"

  rm -f "$PROJECT_DIR/orca-${ACTIVE_PORT}.pid" 2>/dev/null || true
fi

# ---------------------------------------------------------------------------
# Unpause new instance scheduler
# ---------------------------------------------------------------------------
log "unpausing scheduler on new instance..."
UNPAUSE=$(curl -sf -X POST "http://localhost:$STANDBY_PORT/api/deploy/unpause" 2>/dev/null || echo '{"error":"failed"}')
log "unpause result: $UNPAUSE"

# ---------------------------------------------------------------------------
# Write deploy state (swap ports for next deploy)
# ---------------------------------------------------------------------------
node -e "
  var fs=require('fs'),path=require('path');
  var stateFile=path.join(process.cwd(),'deploy-state.json');
  fs.writeFileSync(stateFile,JSON.stringify({
    activePort:$STANDBY_PORT,
    standbyPort:$ACTIVE_PORT,
    deployedAt:new Date().toISOString(),
    pid:$NEW_PID
  },null,2)+'\n');
"

log "done! active=$STANDBY_PORT  (next deploy will use port $ACTIVE_PORT)"
