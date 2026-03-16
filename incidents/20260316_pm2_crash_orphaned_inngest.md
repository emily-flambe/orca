# Incident Report: PM2 daemon crash left Orca and Inngest down

**Date:** 2026-03-16
**Severity:** SEV-1 (total outage)
**Duration:** Unknown — at least hours. Detected ~15:43 UTC by user report.
**Status:** Mitigated (manually restarted), permanent fix in progress
**Fixed in:** TBD

## Summary

PM2 daemon died silently, killing the `orca-4001` process. A stale `inngest.exe` process (PID 19360) survived outside PM2 and held port 8288, preventing Inngest from restarting during recovery. Both Orca and Inngest were down — no task dispatching, no dashboard, no API.

## Detection

User reported `orca.emilycogsdill.com` not loading. Manual investigation confirmed:
- PM2 daemon was not running (freshly spawned with empty process list on check)
- Port 4001 (active) and 4000 (standby) both unresponsive (curl exit code 7)
- Cloudflare tunnel returned 302 (no backend to proxy to)

## Impact

- Complete outage of Orca dashboard, API, and task dispatching
- Duration unknown — no alerting fired (monitoring gap)
- Any tasks in `running` state would have been orphaned
- No data loss (SQLite DB intact)

## Root Cause

Two compounding failures:

1. **PM2 daemon crash**: PM2 itself stopped running at some unknown point. When queried, it had to freshly spawn its daemon and reported zero processes. This is the same class of failure as the 2026-03-14 silent crash — PM2 is supposed to be the process supervisor, but nothing supervises PM2.

2. **Orphaned Inngest process**: The `inngest.exe` process (started by PM2 originally) survived the PM2 crash and continued holding port 8288. When `deploy.sh` ran recovery, it checked `pm2 describe inngest` which returned false (PM2 had no record of it), so it tried to start a fresh Inngest — which crash-looped 9 times because port 8288 was already bound.

The deploy script has no logic to detect or kill orphaned processes on the Inngest port before starting a new instance.

## Timeline

| Time (UTC) | Event |
|------------|-------|
| Unknown | PM2 daemon dies, taking orca-4001 down |
| Unknown | inngest.exe (PID 19360) survives, holds port 8288 |
| ~15:43 | User reports orca.emilycogsdill.com not working |
| 15:43 | Investigation: PM2 empty, ports 4000/4001 unresponsive |
| 15:43 | `deploy.sh` run — Orca starts on 4000, but Inngest crash-loops (port conflict) |
| 15:44 | Stale inngest.exe identified on port 8288 (PID 19360) |
| 15:44 | `taskkill /PID 19360 /F`, then `pm2 restart inngest` |
| 15:44 | Both orca-4000 and inngest confirmed healthy |

## Mitigation Applied

1. Ran `deploy.sh` to bring Orca back on port 4000
2. Identified and killed stale `inngest.exe` (PID 19360)
3. Restarted Inngest via PM2

## Resolution

Permanent fix in progress:
1. `deploy.sh` must kill any process holding the Inngest port before starting a new instance
2. A watchdog mechanism is needed to detect PM2 daemon death and auto-recover

## Lessons Learned

### What went well
- Recovery was straightforward once the port conflict was identified
- SQLite DB and task state were intact — no data loss
- Deploy script successfully brought Orca back

### What went wrong
- No alerting — outage duration is unknown because nothing monitors PM2 health
- PM2 is a single point of failure with no supervisor above it
- `deploy.sh` doesn't handle orphaned processes on the Inngest port
- This is the second silent crash in 3 days (see 20260314 incident) — same root cause class

### Action items

| Action | Owner | Status |
|--------|-------|--------|
| Fix deploy.sh to kill stale processes on Inngest port before starting | orca | In progress |
| Add Windows Task Scheduler watchdog for PM2/Orca health | orca | Open |
| Investigate why PM2 daemon itself is dying | orca | Open |
