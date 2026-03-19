# Bug Report: Watchdog checks standby port instead of active port

**Date:** 2026-03-18
**Severity:** Low
**Status:** Open
**Fixed in:** TBD

## Summary

After a blue-green deploy switches the active port (e.g., 4000→4001), the watchdog continues checking the old port (4000), triggering false-positive "Orca not responding" alerts every 2 minutes and running restart.sh unnecessarily.

## Symptoms

- Watchdog log shows continuous failures: `FAILURE DETECTED: Orca not responding on port 4000` every 2 minutes for 2+ hours
- restart.sh runs but finds `orca-4001 already online` and exits cleanly
- No actual service disruption — Orca is healthy on port 4001

## Root Cause

The watchdog's `get_active_port()` function reads `deploy-state.json` via a `node -e` command:

```bash
node -e "
  var fs=require('fs');
  try { console.log(JSON.parse(fs.readFileSync('$STATE_FILE','utf8')).activePort||4000) }
  catch(e) { console.log(4000) }
"
```

Suspected: the `node -e` command fails silently (possibly due to PATH differences in the scheduled task environment) and the function falls through to the default `4000`. The restart.sh script invoked by the watchdog uses a different `json_field` helper that works correctly (reading via stdin pipe), which is why restart.sh sees the correct port.

Alternative theory: `deploy-state.json` is briefly absent or malformed during a deploy window, and the watchdog caches the stale 4000 port for its check.

## Impact

- Noisy watchdog logs
- restart.sh invoked every 2 minutes unnecessarily
- Inngest functions re-registered every 2 minutes (restart.sh calls PUT /api/inngest)
- No actual service impact

## Fix

1. Make `get_active_port()` use the same `json_field` pipe pattern as restart.sh
2. Add a fallback: if the primary port doesn't respond, try the other port before declaring failure
3. Log the port being checked so the mismatch is immediately visible

## Timeline

| Time (UTC) | Event |
|------------|-------|
| 2026-03-19 00:15-02:25 | Continuous false alarms every 2 minutes |
| 2026-03-19 02:30 | Identified during crash investigation |
