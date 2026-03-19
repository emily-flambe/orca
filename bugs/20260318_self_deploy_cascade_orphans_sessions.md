# Bug Report: Self-deploy cascade orphans all running sessions

**Date:** 2026-03-18
**Severity:** High
**Status:** Fixed
**Fixed in:** Auto-deploy removed (prior), drain wait added (`c6851ea`), cooldown + 10-min drain (`93402ac`+)

## Summary

When Orca merges a PR to main, the GitHub push webhook triggers a self-deploy that immediately kills the old instance, orphaning all running sessions. On busy days this creates a cascade: merge → deploy → orphan → retry → merge → deploy → orphan.

## Symptoms

- 9+ deploys on 2026-03-18, each orphaning 3-6 running sessions
- 152 total invocations with `orphaned by crash/restart` across history
- Tasks accumulate `staleSessionRetryCount` from repeated orphaning
- Locked worktrees (`WorktreeLockedError: EPERM`) from killed sessions blocking subsequent dispatch

## Root Cause

`scripts/deploy.sh` lines 283-291:

```bash
# Stop old instance: signal drain (preserves worktrees), then kill immediately.
# Sessions run 10-45 min so waiting is pointless — the new instance picks up.
log "signaling drain on old instance (port $ACTIVE_PORT)..."
curl -sf -X POST "http://localhost:$ACTIVE_PORT/api/deploy/drain" > /dev/null 2>&1 || true
log "stopping old instance..."
$PM2 delete "orca-${ACTIVE_PORT}" 2>/dev/null || true
```

The drain signal is sent but the instance is killed immediately after — no wait time for sessions to wrap up. The comment says "waiting is pointless" but the consequence is orphaned sessions that burn retries and budget.

The deploy trigger chain:
1. Orca merges PR → push to main
2. GitHub webhook received by Orca → `push to main detected — triggering graceful deploy`
3. deploy.sh runs → new instance starts on standby port
4. Old instance killed immediately → all sessions orphaned
5. New instance reconciles orphaned tasks → re-dispatches them
6. If any re-dispatched task merges another PR → cycle repeats

On 2026-03-18:
- 04:02 EMI-322 merged → deploy (6 orphaned)
- 04:27 EMI-30 merged → deploy (4 orphaned)
- 05:15 EMI-82 merged → deploy (6 orphaned)
- Plus 6+ more deploys through the day

## Impact

- 152 orphaned invocations total
- Each orphan increments `staleSessionRetryCount`, contributing to permanent task failure
- Wasted compute on sessions that made progress but were killed before completion
- Locked worktrees that block subsequent dispatch attempts

## Fix

The deploy script should wait for active sessions to complete (with a timeout) before killing the old instance. The drain endpoint already exists — it just needs time to work.

Add a drain wait period:
1. Signal drain (stops new task dispatch)
2. Wait up to N minutes for active sessions to finish (poll `/api/status` for `activeSessions: 0`)
3. Force kill if timeout exceeded
4. Alternatively: hand off session handles to the new instance before killing old

## Prevention

- Add a deploy cooldown: don't self-deploy more than once per 30 minutes
- Consider not self-deploying on non-Orca repo merges (only deploy when Orca's own code changes)
- Track deploy-triggered orphans separately from genuine crashes

## Timeline

| Time (UTC) | Event |
|------------|-------|
| Ongoing | Every PR merge to main triggers a deploy that orphans sessions |
| 2026-03-18 | 9+ deploys in one day, ~30 sessions orphaned |
| 2026-03-19 02:30 | Pattern identified during crash/restart investigation |
