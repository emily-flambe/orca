# Incident Report: Watchdog-Deploy Port Ping-Pong

**Date:** 2026-03-17
**Severity:** Medium
**Duration:** Ongoing since watchdog was installed (~Mar 16)
**Impact:** Every deploy triggers a counter-deploy that flips the port back, orphaning sessions twice per deploy cycle

## Summary

The OrcaWatchdog scheduled task (runs every ~2 minutes) health-checks the active port. When a deploy switches from port A to port B, the watchdog fires before the new instance is fully warmed up, detects a "failure," and runs `deploy.sh` again — which starts a new instance on the old port A and switches back. This creates a loop where every deploy effectively runs twice, orphaning all active sessions both times.

## Timeline (2026-03-17 23:28–23:30 local)

1. **23:28:48** — Manual deploy starts. `deploy-state.json` shows `activePort: 4000`
2. **23:28:52** — New orca-4001 instance starts, listens on port 4001
3. **23:29:02** — Tunnel switched to port 4001
4. **23:29:04** — Drain signal sent to orca-4000
5. **23:29:35** — Drain timeout. `pm2 delete orca-4000` kills the old instance (3 sessions orphaned)
6. **23:29:36** — Deploy writes `deploy-state.json` with `activePort: 4001`. Deploy script exits.
7. **~23:29:56** — OrcaWatchdog fires, reads `activePort: 4001`, health-checks port 4001
8. **23:29:56** — Health check either fails (orca-4001 under load) or watchdog runs `deploy.sh` as "recovery"
9. **23:29:57** — Second deploy starts orca-4000 (standby port), switches tunnel back
10. **23:30:06** — orca-4000 now active, re-emits all task/ready events, orphaning orca-4001 sessions

## Root Cause

`scripts/watchdog.sh` has no awareness of in-progress deploys. It does not check:
- The `.deploy.lock` lockfile
- Whether a deploy completed recently (within last 2 minutes)
- Whether the instance is still warming up

When the watchdog detects any health check failure, it immediately runs `deploy.sh`, which does a full blue/green swap — exactly the wrong recovery action when the "failure" is just a new instance warming up.

## Impact

- **Double session orphaning**: Every deploy orphans sessions twice (once from the real deploy, once from the watchdog's counter-deploy)
- **Port instability**: Active port alternates unpredictably between 4000 and 4001
- **Monitoring confusion**: External monitoring can't reliably know which port is active
- **Wasted budget**: Orphaned sessions burn retry budget and cost money

## Fix

The watchdog should:
1. Check for `.deploy.lock` and skip if a deploy is in progress
2. Check `deploy-state.json`'s `deployedAt` timestamp and skip if a deploy completed within the last 3 minutes (warmup grace period)
3. Alternatively, use `restart.sh` instead of `deploy.sh` for recovery — restart.sh is idempotent and won't flip ports

## Related

- EMI-359: Graceful deploy (wait for running sessions before swapping)
- The auto-retry reconciler (EMI-357) masked this issue by automatically retrying orphaned tasks
