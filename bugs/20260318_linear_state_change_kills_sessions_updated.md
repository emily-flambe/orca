# Bug Report: Linear state change interruptions — root cause analysis

**Date:** 2026-03-18 (updated from initial report)
**Severity:** Medium (downgraded from High — most interruptions are either user-initiated or from a resolved pathological case)
**Status:** Investigating
**Fixed in:** TBD

## Summary

154 invocations failed with "interrupted by Linear state change". Investigation reveals three distinct causes, not one:

## Cause Breakdown

### 1. March 15 echo loop — 94 interruptions (61%)

**Tasks:** EMI-310, EMI-311, EMI-312, EMI-313, EMI-314, EMI-315, EMI-316
**Window:** 2026-03-15 06:12-08:33 UTC (~2 hours)
**Root cause:** After 10+ rapid restarts on March 15, the in-memory `expectedChanges` echo prevention map was cleared. The 60-second startup grace period ended, and stale webhooks from before the restart flooded in and were treated as user-initiated changes. Each kill triggered a re-dispatch, which generated a new write-back to Linear, which generated a new webhook, creating a tight feedback loop. EMI-314 alone was interrupted 52 times, most with 0-minute duration.

**Status:** Resolved naturally — these tasks eventually completed or were canceled. The restart instability that triggered the loop was a March 15 issue.

### 2. User-initiated batch operations — ~40 interruptions (26%)

**Evidence from conflict resolution logs:**
- 2026-03-17 23:28 — 4 tasks canceled in 2 seconds
- 2026-03-18 09:05-09:06 — 9 tasks canceled in 8 seconds ("Linear Canceled")
- 2026-03-18 09:21-09:30 — 5 tasks moved to Todo, 5 more canceled
- 2026-03-18 20:29 — 2 tasks canceled

These are batch ticket management in the Linear UI (multi-select → change state). Orca correctly honored these changes. Not a bug.

### 3. Miscellaneous — ~20 interruptions (13%)

Spread across March 15-16 during the early instability period. Likely a mix of echo failures and user actions.

## The Actual Bug: Startup Grace Period Too Short

After a restart, the `expectedChanges` map is empty. The 60-second startup grace period (`STARTUP_GRACE_MS` in `src/linear/sync.ts:114`) is insufficient when:
- Linear has queued webhooks from before the restart
- Multiple rapid restarts keep clearing the map
- The dispatch-interrupt-dispatch feedback loop runs faster than the grace period

**Fix:** Increase `STARTUP_GRACE_MS` from 60s to 120s. Additionally, add a fullSync after startup grace ends to reconcile Orca state with Linear before processing individual webhooks. This ensures any state changes that happened during the restart window are caught.

## Impact (revised)

- The March 15 echo loop wasted significant compute but is no longer active
- User-initiated interruptions are correct behavior — no fix needed
- The stale retry reset fix (already deployed) prevents interrupted tasks from accumulating permanent death counters
- Remaining risk: future restart storms could trigger the echo loop again

## Prevention

1. Increase `STARTUP_GRACE_MS` to 120s
2. Add dispatch cooldown: don't re-dispatch a task within 30s of it being interrupted
3. The deploy drain wait (already deployed) reduces restart frequency, which reduces the echo loop trigger

## Timeline

| Time (UTC) | Event |
|------------|-------|
| 2026-03-15 06:12-08:33 | Echo loop: 94 interruptions across EMI-310-316 |
| 2026-03-17-18 | User-initiated batch cancellations |
| 2026-03-19 03:00 | Root cause analysis completed |
