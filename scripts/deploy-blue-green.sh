#!/usr/bin/env bash
set -euo pipefail

# ---------------------------------------------------------------------------
# Blue/Green Deploy for Orca
#
# Reads deploy-state.json for active/standby ports, starts a new instance on
# the standby port, health checks it, switches the Cloudflare tunnel origin,
# drains the old instance, waits for active sessions to finish, kills old,
# unpauses new scheduler, and writes updated state.
# ---------------------------------------------------------------------------

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
STATE_FILE="$PROJECT_DIR/deploy-state.json"

log() { echo "[deploy-blue-green] $(date '+%H:%M:%S') $*"; }

# ---------------------------------------------------------------------------
# Read deploy state (defaults: active=4000, standby=4001)
# ---------------------------------------------------------------------------
if [[ -f "$STATE_FILE" ]]; then
  ACTIVE_PORT=$(jq -r '.activePort // 4000' "$STATE_FILE")
  STANDBY_PORT=$(jq -r '.standbyPort // 4001' "$STATE_FILE")
else
  ACTIVE_PORT=4000
  STANDBY_PORT=4001
fi

log "active=$ACTIVE_PORT  standby=$STANDBY_PORT"

# ---------------------------------------------------------------------------
# Save old PID BEFORE building (pidfile may be overwritten by new instance)
# ---------------------------------------------------------------------------
OLD_PID_FILE="$PROJECT_DIR/orca-${ACTIVE_PORT}.pid"
OLD_PID=""
if [[ -f "$OLD_PID_FILE" ]]; then
  OLD_PID=$(cat "$OLD_PID_FILE")
  log "old instance PID=$OLD_PID (from $OLD_PID_FILE)"
else
  log "WARNING: no pidfile at $OLD_PID_FILE — old instance may need manual cleanup"
fi

# ---------------------------------------------------------------------------
# Pull, install, build
# ---------------------------------------------------------------------------
cd "$PROJECT_DIR"
log "pulling latest code..."
git pull --ff-only

log "installing dependencies..."
npm install --no-audit --no-fund

log "building frontend..."
npm run build:web 2>/dev/null || true

# ---------------------------------------------------------------------------
# Start new instance on standby port with scheduler paused
# ---------------------------------------------------------------------------
log "starting new instance on port $STANDBY_PORT (scheduler paused)..."
ORCA_PORT=$STANDBY_PORT ORCA_EXTERNAL_TUNNEL=true \
  node --import tsx/esm src/cli/index.ts start --scheduler-paused \
  >> "$PROJECT_DIR/orca.log" 2>&1 &
NEW_PID=$!
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
  log "ERROR: health check failed after 30 attempts — rolling back"
  kill "$NEW_PID" 2>/dev/null || true
  exit 1
fi

# ---------------------------------------------------------------------------
# Update Cloudflare tunnel origin (if vars are set)
# ---------------------------------------------------------------------------
CF_TUNNEL_ID="${CLOUDFLARE_TUNNEL_ID:-}"
CF_ACCOUNT_ID="${CLOUDFLARE_ACCOUNT_ID:-}"
CF_API_TOKEN="${CLOUDFLARE_API_TOKEN:-}"

if [[ -n "$CF_TUNNEL_ID" && -n "$CF_ACCOUNT_ID" && -n "$CF_API_TOKEN" ]]; then
  log "updating Cloudflare tunnel origin to port $STANDBY_PORT..."

  CF_API_BASE="https://api.cloudflare.com/client/v4/accounts/$CF_ACCOUNT_ID/cfd_tunnel/$CF_TUNNEL_ID/configurations"

  # Fetch current config
  CURRENT_CONFIG=$(curl -sf \
    -H "Authorization: Bearer $CF_API_TOKEN" \
    -H "Content-Type: application/json" \
    "$CF_API_BASE")

  if [[ -z "$CURRENT_CONFIG" ]]; then
    log "WARNING: failed to fetch tunnel config — skipping tunnel update"
  else
    # Update localhost port in ingress rules
    UPDATED_CONFIG=$(echo "$CURRENT_CONFIG" | jq --arg port "$STANDBY_PORT" '
      .result.config.ingress |= map(
        if .service and (.service | test("localhost:\\d+")) then
          .service = (.service | sub("localhost:\\d+"; "localhost:" + $port))
        else . end
      ) | .result.config
    ')

    # PUT updated config
    PUT_RESULT=$(curl -sf -X PUT \
      -H "Authorization: Bearer $CF_API_TOKEN" \
      -H "Content-Type: application/json" \
      -d "{\"config\": $UPDATED_CONFIG}" \
      "$CF_API_BASE")

    if echo "$PUT_RESULT" | jq -e '.success' > /dev/null 2>&1; then
      log "tunnel origin updated to port $STANDBY_PORT"
    else
      log "WARNING: tunnel config update may have failed: $PUT_RESULT"
    fi
  fi
else
  log "WARNING: Cloudflare tunnel vars not set — skipping tunnel origin update"
fi

# ---------------------------------------------------------------------------
# Drain old instance
# ---------------------------------------------------------------------------
if [[ -n "$OLD_PID" ]]; then
  log "draining old instance on port $ACTIVE_PORT..."
  curl -sf -X POST "http://localhost:$ACTIVE_PORT/api/deploy/drain" > /dev/null 2>&1 || true

  # Wait for active sessions to reach 0 (poll up to 5 minutes)
  log "waiting for old instance sessions to drain..."
  DRAIN_OK=false
  for i in $(seq 1 60); do
    SESSIONS=$(curl -sf "http://localhost:$ACTIVE_PORT/api/status" 2>/dev/null | jq -r '.activeSessions // 0' 2>/dev/null || echo "0")
    if [[ "$SESSIONS" == "0" ]]; then
      DRAIN_OK=true
      log "old instance drained (0 active sessions)"
      break
    fi
    log "  waiting... $SESSIONS session(s) still active"
    sleep 5
  done

  if [[ "$DRAIN_OK" != "true" ]]; then
    log "WARNING: drain timeout — killing old instance anyway"
  fi

  # Kill old instance using saved PID (NOT from pidfile which may be overwritten)
  log "killing old instance (PID=$OLD_PID)..."
  kill "$OLD_PID" 2>/dev/null || true

  # Wait briefly for process to exit
  sleep 2
  if kill -0 "$OLD_PID" 2>/dev/null; then
    log "old instance still alive — sending SIGKILL"
    kill -9 "$OLD_PID" 2>/dev/null || true
  fi
fi

# ---------------------------------------------------------------------------
# Unpause new instance scheduler
# ---------------------------------------------------------------------------
log "unpausing scheduler on new instance..."
UNPAUSE_RESULT=$(curl -sf -X POST "http://localhost:$STANDBY_PORT/api/deploy/unpause" 2>/dev/null || echo '{"error":"failed"}')
log "unpause result: $UNPAUSE_RESULT"

# ---------------------------------------------------------------------------
# Write new deploy state (swap ports)
# ---------------------------------------------------------------------------
jq -n \
  --arg active "$STANDBY_PORT" \
  --arg standby "$ACTIVE_PORT" \
  --arg deployedAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --arg pid "$NEW_PID" \
  '{activePort: ($active | tonumber), standbyPort: ($standby | tonumber), deployedAt: $deployedAt, pid: ($pid | tonumber)}' \
  > "$STATE_FILE"

log "deploy complete! active=$STANDBY_PORT standby=$ACTIVE_PORT"
