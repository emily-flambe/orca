# Incident Report: Inngest Process Repeatedly Dies Without Recovery

**Date:** 2026-03-24
**Severity:** SEV-2 (degraded service — tasks stop processing but no data loss)
**Duration:** Unknown (up to ~28 hours, between deploy at 2026-03-23 18:34 UTC and detection at 2026-03-24 23:05 UTC)
**Status:** Mitigated
**Fixed in:** TBD (health monitor implementation in progress)

## Summary

Inngest process repeatedly dies without automated recovery, leaving Orca tasks stranded in ready/running states with no dispatch mechanism. This is a recurring issue — not a one-time event.

## Detection

User noticed 3 queued tasks with 0 running sessions. The Orca API health endpoint reported `inngestReachable: false`.

## Impact

- All task dispatch halted — implement, review, fix, and merge workflows all depend on Inngest
- 3 tasks stuck in `ready` with no active sessions
- The stuck-task reconciler itself runs inside Inngest (cleanup cron), so it was also dead — no self-recovery possible
- Duration unknown — Orca was deployed 2026-03-23 18:34 UTC, Inngest could have died any time after
- No data loss

## Root Cause

Multiple supervision gaps compound to make Inngest death unrecoverable without manual intervention:

1. **PM2 `max_restarts: 10` exhausts on rapid crash loops.** When Inngest crash-loops, PM2 hits its restart limit and gives up permanently. No further restart attempts are made.

2. **Watchdog (Task Scheduler, every 2 min) has detection gap and depends on user being logged in.** The Windows Task Scheduler watchdog only runs when a user session is active, making it unreliable for headless or overnight operation.

3. **Orca's Node.js process detects failure but takes no corrective action.** The health check correctly identifies `inngestReachable: false` but only reports this status passively. No automated restart or alert is triggered.

4. **Reconcile-stuck-tasks cron has circular dependency on Inngest.** The cron that would recover orphaned tasks runs inside Inngest itself. When Inngest dies, the recovery mechanism dies with it — a fatal circular dependency.

5. **`GET /api/health` returns 200 even when Inngest is unreachable.** Deploy health checks pass despite Inngest being down, so blue/green deploys cannot detect this failure state. A healthy-looking Orca instance may have no functioning dispatch pipeline.

## Timeline

| Time (UTC) | Event |
|------------|-------|
| 2026-03-23 18:34 | Orca deployed successfully on port 4001 |
| Unknown | Inngest process dies (no alert, no automated detection) |
| 2026-03-24 23:05 | User checks status, sees 3 queued / 0 running, `inngestReachable: false` |
| 2026-03-24 23:10 | Manual Inngest restart via CLI |
| 2026-03-24 23:11 | Inngest back online, Orca resumes dispatching (2 active sessions) |

## Mitigation Applied

Manual restart of Inngest via `npx inngest-cli start` with correct environment variables.

## Resolution

Implementing an in-process Inngest health monitor (`src/inngest/health-monitor.ts`) that:

- Checks Inngest health every 30 seconds
- After 3 consecutive failures, auto-restarts Inngest via PM2
- Re-emits `task/ready` events after successful restart to un-strand orphaned tasks
- Enforces a 5-minute cooldown between restart attempts

## Lessons Learned

### What went well
- Health check API correctly reported `inngestReachable: false`, enabling quick diagnosis
- User was able to identify the problem and manually recover within minutes of detection

### What went wrong
- No automated recovery from Inngest process death — the system waited indefinitely for manual intervention
- Stuck-task reconciler has a circular dependency on the very system it is supposed to recover from
- `/api/health` returning 200 when Inngest is down masks a critical failure from deploy checks and external monitors
- No alerting on Inngest failure — the only detection method is a human checking the dashboard

### Action items

| Action | Owner | Ticket | Status |
|--------|-------|--------|--------|
| Implement in-process Inngest health monitor (`src/inngest/health-monitor.ts`) | orca | — | Open |
| Make `/api/health` return 503 when Inngest is unreachable | orca | — | Open |
| Consider Node.js-side fallback reconciler that does not depend on Inngest | orca | — | Open |
| Add alerting (webhook/Slack) on sustained Inngest unreachability | orca | — | Open |
