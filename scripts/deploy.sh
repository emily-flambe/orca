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
# Pull, install, build  (must succeed before we touch the running instance)
# ---------------------------------------------------------------------------
cd "$PROJECT_DIR"
log "pulling latest code..."
git checkout main
git pull origin main

log "installing dependencies..."
npm install

log "building frontend..."
(cd web && npm run build)

# Build succeeded — safe to clean up before starting new instance
# Stop any existing PM2 processes on the standby port (clean slate)
log "stopping any existing PM2 process on standby port $STANDBY_PORT..."
PM2="$PROJECT_DIR/node_modules/.bin/pm2"
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
  if curl -sf "http://localhost:$STANDBY_PORT/api/status" > /dev/null 2>&1; then
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
# Drain old instance and stop via PM2
# ---------------------------------------------------------------------------
if $PM2 describe "orca-${ACTIVE_PORT}" &>/dev/null; then
  log "draining old instance on port $ACTIVE_PORT (stop scheduler)..."
  curl -sf -X POST "http://localhost:$ACTIVE_PORT/api/deploy/drain" > /dev/null 2>&1 || true

  log "stopping old instance via PM2..."
  $PM2 delete "orca-${ACTIVE_PORT}" 2>/dev/null || true
fi

# ---------------------------------------------------------------------------
# Post-deploy: re-register with Inngest server
# ---------------------------------------------------------------------------
log "re-registering Inngest functions..."
INNGEST_REGISTER=$(curl -sf -X PUT "http://localhost:$STANDBY_PORT/api/inngest" 2>&1 || true)
if echo "$INNGEST_REGISTER" | grep -q '"modified":true'; then
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

log "done! active=$STANDBY_PORT  (next deploy will use port $ACTIVE_PORT)"
