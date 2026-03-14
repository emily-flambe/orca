#!/usr/bin/env bash
# Start the Inngest self-hosted server (single-node mode).
#
# State is persisted to .inngest/ (SQLite, created automatically).
# UI/API:          http://localhost:8288
# Connect gateway: http://localhost:8289
#
# Keys must match INNGEST_EVENT_KEY and INNGEST_SIGNING_KEY in .env.
# For local dev, any non-empty string works (defaults: "local").
#
# Usage: bash scripts/start-inngest.sh [--event-key KEY] [--signing-key KEY]

set -euo pipefail

# Load .env if present so defaults below pick up configured values.
if [ -f .env ]; then
  set -a
  source .env
  set +a
fi

EVENT_KEY="${INNGEST_EVENT_KEY:-local}"
SIGNING_KEY="${INNGEST_SIGNING_KEY:-local}"

# Allow CLI overrides.
while [[ $# -gt 0 ]]; do
  case "$1" in
    --event-key)   EVENT_KEY="$2";   shift 2 ;;
    --signing-key) SIGNING_KEY="$2"; shift 2 ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

# Check if port 8288 is already in use.
if command -v lsof &>/dev/null; then
  if lsof -ti tcp:8288 &>/dev/null; then
    echo "[inngest] ERROR: Port 8288 is already in use." >&2
    echo "[inngest] Stop the existing process or use a different port with --port." >&2
    exit 1
  fi
elif command -v netstat &>/dev/null; then
  if netstat -ano 2>/dev/null | grep -q ":8288 "; then
    echo "[inngest] ERROR: Port 8288 is already in use." >&2
    echo "[inngest] Stop the existing process or use a different port with --port." >&2
    exit 1
  fi
fi

echo "[inngest] Starting self-hosted Inngest server..."
echo "[inngest] UI/API:    http://localhost:8288"
echo "[inngest] Connect:   http://localhost:8289"
echo "[inngest] Data dir:  .inngest/"

exec npx inngest-cli@latest start \
  --sqlite-dir .inngest \
  --port 8288 \
  --event-key "$EVENT_KEY" \
  --signing-key "$SIGNING_KEY"
