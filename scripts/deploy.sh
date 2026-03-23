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

# ---------------------------------------------------------------------------
# Lockfile — prevent concurrent deploys
# ---------------------------------------------------------------------------
LOCKFILE="$PROJECT_DIR/.deploy.lock"
if [[ -f "$LOCKFILE" ]]; then
  LOCK_PID=$(cat "$LOCKFILE" 2>/dev/null || true)
  if [[ -n "$LOCK_PID" ]] && kill -0 "$LOCK_PID" 2>/dev/null; then
    log "ERROR: deploy already running (PID=$LOCK_PID)"
    exit 1
  fi
  log "WARNING: stale lockfile found (PID=$LOCK_PID not running) — removing"
fi
echo $$ > "$LOCKFILE"
trap "rm -f $LOCKFILE" EXIT

# ---------------------------------------------------------------------------
# Deploy cooldown — skip if last deploy was less than 10 minutes ago
# (override with FORCE_DEPLOY=1 to bypass)
# ---------------------------------------------------------------------------
STATE_FILE="$PROJECT_DIR/deploy-state.json"
DEPLOY_COOLDOWN_S=600
if [[ -f "$STATE_FILE" && "${FORCE_DEPLOY:-}" != "1" ]]; then
  LAST_DEPLOY=$(cat "$STATE_FILE" | json_field deployedAt "")
  if [[ -n "$LAST_DEPLOY" ]]; then
    DEPLOY_AGE_S=$(node -e "console.log(Math.floor((Date.now()-new Date('$LAST_DEPLOY').getTime())/1000))" 2>/dev/null || echo "999")
    if [[ "$DEPLOY_AGE_S" -lt "$DEPLOY_COOLDOWN_S" ]]; then
      log "deploy cooldown: last deploy was ${DEPLOY_AGE_S}s ago (cooldown=${DEPLOY_COOLDOWN_S}s) — skipping (set FORCE_DEPLOY=1 to override)"
      exit 0
    fi
  fi
fi

# ---------------------------------------------------------------------------
# Read deploy state (defaults: active=4000, standby=4001)
# ---------------------------------------------------------------------------
if [[ -f "$STATE_FILE" ]]; then
  ACTIVE_PORT=$(cat "$STATE_FILE" | json_field activePort 4000)
  STANDBY_PORT=$(cat "$STATE_FILE" | json_field standbyPort 4001)
else
  ACTIVE_PORT=4000
  STANDBY_PORT=4001
fi

log "active=$ACTIVE_PORT  standby=$STANDBY_PORT"

# ---------------------------------------------------------------------------
# Pull, install, build  (must succeed before we touch the running instance)
# ---------------------------------------------------------------------------
cd "$PROJECT_DIR"
log "pulling latest code..."
git checkout main
git pull origin main

log "installing dependencies..."
npm install

log "building backend (MCP server)..."
npm run build

log "building frontend..."
(cd web && npm run build)

# Build succeeded — safe to clean up before starting new instance
PM2="$PROJECT_DIR/node_modules/.bin/pm2"

# ---------------------------------------------------------------------------
# Ensure Inngest dev server is running (shared service, not restarted on deploy)
# ---------------------------------------------------------------------------
# Kill any stale process holding port 8288 (e.g., orphaned inngest.exe after PM2 crash)
STALE_PID=$(netstat -ano 2>/dev/null | grep ':8288 ' | grep LISTENING | awk '{print $NF}' | head -1 || true)
if [[ -n "$STALE_PID" && "$STALE_PID" != "0" ]]; then
  log "found stale process (PID=$STALE_PID) on port 8288 — killing..."
  taskkill //PID "$STALE_PID" //F 2>/dev/null || true
  sleep 2
  # Verify port is freed
  if netstat -ano 2>/dev/null | grep ':8288 ' | grep -q LISTENING; then
    log "WARNING: port 8288 still in use after killing PID=$STALE_PID"
  else
    log "port 8288 freed"
  fi
fi

# Clean up errored/stopped PM2 entry before starting fresh
if $PM2 describe inngest &>/dev/null; then
  INNGEST_STATUS=$($PM2 jlist 2>/dev/null | node -e "
    var d='';
    process.stdin.on('data',function(c){d+=c});
    process.stdin.on('end',function(){
      try {
        var procs=JSON.parse(d);
        var ing=procs.find(function(p){return p.name==='inngest'});
        console.log(ing?ing.pm2_env.status:'unknown');
      } catch(e){console.log('unknown')}
    })
  " 2>/dev/null || echo "unknown")
  if [[ "$INNGEST_STATUS" == "online" ]]; then
    log "Inngest dev server already running via PM2"
  else
    log "Inngest PM2 entry exists but status=$INNGEST_STATUS — restarting..."
    $PM2 delete inngest 2>/dev/null || true
    $PM2 start ecosystem.config.cjs --only inngest
    sleep 3
    if $PM2 describe inngest &>/dev/null; then
      log "Inngest dev server restarted"
    else
      log "WARNING: Inngest dev server failed to start — task dispatching may not work"
    fi
  fi
else
  log "starting Inngest dev server..."
  $PM2 start ecosystem.config.cjs --only inngest
  sleep 3
  if $PM2 describe inngest &>/dev/null; then
    log "Inngest dev server started"
  else
    log "WARNING: Inngest dev server failed to start — task dispatching may not work"
  fi
fi

# Stop any existing PM2 processes on the standby port (clean slate)
log "stopping any existing PM2 process on standby port $STANDBY_PORT..."
$PM2 delete "orca-${STANDBY_PORT}" 2>/dev/null || true

# ---------------------------------------------------------------------------
# Start new instance on standby port
# ---------------------------------------------------------------------------
log "starting new instance on port $STANDBY_PORT..."
unset CLAUDECODE CLAUDE_CODE_ENTRYPOINT 2>/dev/null || true

# Start via PM2 ecosystem config
$PM2 start ecosystem.config.cjs --only "orca-${STANDBY_PORT}"
log "new instance started via PM2"

# ---------------------------------------------------------------------------
# Health check new instance (retry up to 60 times, 2s apart = 120s max)
# ---------------------------------------------------------------------------
log "health checking new instance on port $STANDBY_PORT..."
HEALTH_OK=false
for i in $(seq 1 60); do
  if curl -sf --max-time 5 "http://localhost:$STANDBY_PORT/api/health/ping" > /dev/null 2>&1; then
    HEALTH_OK=true
    log "health check passed on attempt $i"
    break
  fi
  sleep 2
done

if [[ "$HEALTH_OK" != "true" ]]; then
  log "ERROR: health check failed after 120s — rolling back"
  $PM2 delete "orca-${STANDBY_PORT}" 2>/dev/null || true
  exit 1
fi

# ---------------------------------------------------------------------------
# Helper: log a deploy event to the running instance's system_events table
# ---------------------------------------------------------------------------
log_deploy_event() {
  local port="$1"
  local status="$2"
  local message="$3"
  curl -sf --max-time 5 -X POST "http://localhost:$port/api/deploy/event" \
    -H "Content-Type: application/json" \
    -d "{\"status\":\"$status\",\"message\":\"$message\"}" > /dev/null 2>&1 || true
}

# ---------------------------------------------------------------------------
# Drain old instance BEFORE switching tunnel — prevents new sessions starting
# on old instance after traffic is cut over.
# ---------------------------------------------------------------------------
DRAIN_TIMEOUT_S=600  # Max seconds to wait for sessions to finish (10 min)
if $PM2 describe "orca-${ACTIVE_PORT}" &>/dev/null; then
  log "signaling drain on old instance (port $ACTIVE_PORT) before tunnel switch..."
  curl -sf --max-time 5 -X POST "http://localhost:$ACTIVE_PORT/api/deploy/drain" > /dev/null 2>&1 || true

  # Poll active sessions — wait for them to finish before switching tunnel
  DRAIN_START=$(date +%s)
  while true; do
    ACTIVE_SESSIONS=$(curl -sf --max-time 5 "http://localhost:$ACTIVE_PORT/api/status" 2>/dev/null \
      | node -e "var d='';process.stdin.on('data',function(c){d+=c});process.stdin.on('end',function(){try{console.log(JSON.parse(d).activeSessions||0)}catch(e){console.log(0)}})" 2>/dev/null \
      || echo "0")

    if [[ "$ACTIVE_SESSIONS" == "0" ]]; then
      log "all sessions drained — proceeding with tunnel switch"
      break
    fi

    ELAPSED=$(( $(date +%s) - DRAIN_START ))
    if [[ "$ELAPSED" -ge "$DRAIN_TIMEOUT_S" ]]; then
      log "drain timeout after ${ELAPSED}s with $ACTIVE_SESSIONS active session(s) — proceeding with tunnel switch anyway"
      break
    fi

    log "waiting for $ACTIVE_SESSIONS active session(s) to finish (${ELAPSED}s/${DRAIN_TIMEOUT_S}s)..."
    sleep 10
  done
else
  log "no old instance running on port $ACTIVE_PORT — skipping drain"
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

TUNNEL_SWITCHED=false
RAW_TUNNEL_CONFIG=""

if [[ -n "$CF_TUNNEL_ID" && -n "$CF_ACCOUNT_ID" && -n "$CF_API_TOKEN" ]]; then
  log "switching Cloudflare tunnel origin to port $STANDBY_PORT..."

  CF_API_BASE="https://api.cloudflare.com/client/v4/accounts/$CF_ACCOUNT_ID/cfd_tunnel/$CF_TUNNEL_ID/configurations"

  RAW_TUNNEL_CONFIG=$(curl -sf --max-time 15 \
    -H "Authorization: Bearer $CF_API_TOKEN" \
    -H "Content-Type: application/json" \
    "$CF_API_BASE" 2>/dev/null || true)

  if [[ -z "$RAW_TUNNEL_CONFIG" ]]; then
    log "ERROR: failed to fetch tunnel config — aborting deploy, keeping old instance"
    log_deploy_event "$ACTIVE_PORT" "failure" "Deploy aborted: could not fetch tunnel config"
    $PM2 delete "orca-${STANDBY_PORT}" 2>/dev/null || true
    exit 1
  fi

  UPDATED_CONFIG=$(echo "$RAW_TUNNEL_CONFIG" | node -e "
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

  PUT_RESULT=$(curl -sf --max-time 15 -X PUT \
    -H "Authorization: Bearer $CF_API_TOKEN" \
    -H "Content-Type: application/json" \
    -d "$UPDATED_CONFIG" \
    "$CF_API_BASE" 2>/dev/null || true)

  SUCCESS=$(echo "$PUT_RESULT" | json_field success false)
  if [[ "$SUCCESS" == "true" ]]; then
    TUNNEL_SWITCHED=true
    log "tunnel origin switched to port $STANDBY_PORT"
  else
    log "ERROR: tunnel switch PUT failed — aborting deploy, keeping old instance"
    log_deploy_event "$ACTIVE_PORT" "failure" "Deploy aborted: tunnel switch PUT failed"
    $PM2 delete "orca-${STANDBY_PORT}" 2>/dev/null || true
    exit 1
  fi
else
  log "WARNING: Cloudflare tunnel vars not set — skipping tunnel switch"
fi

# ---------------------------------------------------------------------------
# Post-switch health check — verify new instance is still healthy
# If it fails, roll back the tunnel and abort (old instance stays up)
# ---------------------------------------------------------------------------
log "post-switch health check on port $STANDBY_PORT..."
POST_SWITCH_OK=false
for i in $(seq 1 15); do
  if curl -sf --max-time 5 "http://localhost:$STANDBY_PORT/api/health/ping" > /dev/null 2>&1; then
    POST_SWITCH_OK=true
    log "post-switch health check passed on attempt $i"
    break
  fi
  sleep 2
done

if [[ "$POST_SWITCH_OK" != "true" ]]; then
  log "ERROR: post-switch health check failed — rolling back tunnel to port $ACTIVE_PORT"

  if [[ "$TUNNEL_SWITCHED" == "true" ]]; then
    ROLLBACK_CONFIG=$(echo "$RAW_TUNNEL_CONFIG" | node -e "
      var d='';
      process.stdin.on('data',function(c){d+=c});
      process.stdin.on('end',function(){
        var cfg=JSON.parse(d);
        console.log(JSON.stringify({config:{ingress:cfg.result.config.ingress}}));
      })
    ")
    curl -sf --max-time 15 -X PUT \
      -H "Authorization: Bearer $CF_API_TOKEN" \
      -H "Content-Type: application/json" \
      -d "$ROLLBACK_CONFIG" \
      "$CF_API_BASE" > /dev/null 2>&1 \
      && log "tunnel rolled back to port $ACTIVE_PORT" \
      || log "WARNING: tunnel rollback PUT failed — manual intervention may be needed"
  fi

  log_deploy_event "$ACTIVE_PORT" "failure" "Deploy aborted: post-switch health check failed"
  $PM2 delete "orca-${STANDBY_PORT}" 2>/dev/null || true
  exit 1
fi

# ---------------------------------------------------------------------------
# Stop old instance: sessions already drained before tunnel switch, so kill immediately.
# ---------------------------------------------------------------------------
if $PM2 describe "orca-${ACTIVE_PORT}" &>/dev/null; then
  log "stopping old instance (sessions already drained)..."
  $PM2 delete "orca-${ACTIVE_PORT}" 2>/dev/null || true
fi

# ---------------------------------------------------------------------------
# Post-deploy: re-register with Inngest server
# ---------------------------------------------------------------------------
log "re-registering Inngest functions..."
INNGEST_REGISTER=$(curl -sf --max-time 10 -X PUT "http://localhost:$STANDBY_PORT/api/inngest" 2>&1 || true)
if echo "$INNGEST_REGISTER" | grep -q '"Successfully registered"'; then
  log "Inngest functions registered successfully"
else
  log "WARNING: Inngest registration may have failed: $INNGEST_REGISTER"
fi
log "post-deploy health verified"

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
    pm2Name:'orca-$STANDBY_PORT'
  },null,2)+'\n');
"

log_deploy_event "$STANDBY_PORT" "success" "Deploy completed successfully on port $STANDBY_PORT"

log "done! active=$STANDBY_PORT  (next deploy will use port $ACTIVE_PORT)"
