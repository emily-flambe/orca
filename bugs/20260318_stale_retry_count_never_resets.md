# Bug Report: staleSessionRetryCount never resets on task progress

**Date:** 2026-03-18
**Severity:** High
**Status:** Investigating
**Fixed in:** TBD

## Summary

`staleSessionRetryCount` accumulates over a task's entire lifetime and is never reset when the task makes progress (completes a phase, transitions states). This causes tasks with successful work history to be permanently failed by the stuck-task reconciler.

## Symptoms

- 20 tasks permanently failed with `retryCount: 0`, `staleSessionRetryCount: 4`
- 8 of these had their last invocations as `completed` — no actual failure occurred
- Tasks with 10+ successful invocations and $30+ of compute still killed
- All failed tasks are of `taskType: linear`, suggesting the issue is systemic rather than task-specific

## Root Cause

`src/inngest/workflows/reconcile-stuck-tasks.ts:103-108`:

```typescript
const newStaleCount = incrementStaleSessionRetryCount(db, linearIssueId);
const maxRetries = config.maxRetries;
const totalAttempts = retryCount + newStaleCount;
const targetStatus = totalAttempts > maxRetries ? "failed" : "ready";
```

`incrementStaleSessionRetryCount` in `src/db/queries.ts` only increments — there is no corresponding reset function called on successful phase transitions. The counter grows monotonically.

A task gets stale-detected when:
- It's in `running` with no active session handle for >2 min (happens on every Orca restart)
- It's in `in_review`, `changes_requested`, `awaiting_ci`, or `deploying` for >30 min (happens when Inngest is slow or steps fail silently)

With `maxRetries=3`, just 4 stale detections across the entire task lifetime = permanent failure, regardless of how much successful work was done.

## Impact

- 20 tasks permanently failed (100% of current failures)
- ~$200+ of compute wasted across successful invocations that were abandoned
- Tasks with open PRs and passing reviews left orphaned
- The problem worsens with Orca instability — more restarts = faster stale accumulation

## Fix

Reset `staleSessionRetryCount` to 0 when a task transitions to a new phase in the task lifecycle workflow. The right place is `updateTaskStatus()` or the workflow steps that advance phase.

## Prevention

- Add a test: task with staleSessionRetryCount=3 that completes a phase should have count reset to 0
- Consider separate limits for stale retries and genuine implementation failures
- Consider not counting the first stranded detection after a restart

## Timeline

| Time (UTC) | Event |
|------------|-------|
| Various | staleSessionRetryCount accumulated across days of operation |
| 2026-03-19 02:00 | Discovered during /orca-status check |
