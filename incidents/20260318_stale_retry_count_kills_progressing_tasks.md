# Incident Report: Stale retry counter permanently kills tasks that are making progress

**Date:** 2026-03-18
**Severity:** SEV-2 (major degradation)
**Duration:** Ongoing (accumulated over multiple days)
**Status:** Investigating
**Fixed in:** TBD

## Summary

20 tasks are permanently failed despite many having completed multiple successful implement→review cycles, because `staleSessionRetryCount` accumulates across the task's entire lifetime and never resets when progress is made.

## Detection

Manual status check (`/orca-status`) revealed 20 failed tasks, all with `retryCount: 0` and `staleSessionRetryCount: 4`. Investigation showed most had extensive successful invocation histories.

## Impact

- 20 tasks permanently failed
- 8 tasks (EMI-325, EMI-346, EMI-340, EMI-328, EMI-323, EMI-339, EMI-44, EMI-245) had fully completed implement→review cycles — their last invocations were all `completed`
- Estimated wasted compute: $200+ across ~170 successful invocations that were thrown away
- EMI-332 alone consumed ~$36 across 13 completed invocations (6+ review rounds) before being killed
- Tasks with viable open PRs were abandoned

## Root Cause

The reconciler in `src/inngest/workflows/reconcile-stuck-tasks.ts:107` computes:

```typescript
const totalAttempts = retryCount + newStaleCount;
const targetStatus = totalAttempts > maxRetries ? "failed" : "ready";
```

`maxRetries` defaults to 3. `staleSessionRetryCount` increments every time the reconciler finds the task stranded (running with no session handle, or idle in `in_review`/`changes_requested` for >30 min). This counter **never resets**, even when the task successfully completes phases.

A task can complete 10 successful invocations, but if it was caught stranded 4 times across those attempts (due to Orca restarts, slow Inngest transitions, or the 30-min idle threshold), it permanently fails.

Contributing factors:
1. **9 Orca restarts on 2026-03-18** — each restart orphans all running sessions, triggering a stale detection for every in-flight task
2. **30-min stranded threshold** is aggressive for review-to-fix transitions, especially when Inngest step execution is slow
3. **Crash/restart churn burns stale retries fast** — 4 restarts across a task's lifetime = permanent death

## Timeline

| Time (UTC) | Event |
|------------|-------|
| Various | Tasks accumulated stale retry counts across multiple days of operation |
| 2026-03-18 16:45 | Orca deployed (1 of 9 restarts today) |
| 2026-03-19 00:05 | Reconciler caught EMI-47, EMI-44, EMI-339, EMI-325 stranded in intermediate states |
| 2026-03-19 00:10 | EMI-47 hit stale count 4, permanently failed |
| 2026-03-19 02:00 | Detected via /orca-status — all 20 tasks at staleSessionRetryCount=4 |

## Mitigation Applied

None yet. Tasks remain failed.

## Resolution

Reset `staleSessionRetryCount` when a task transitions to a new phase (implement→review, review→fix, etc.). This ensures transient strandedness doesn't accumulate into permanent failure for tasks making real progress.

## Lessons Learned

### What went well
- The stuck-task reconciler correctly identifies genuinely stranded tasks
- System events provide good audit trail of reconciliation decisions

### What went wrong
- `staleSessionRetryCount` is a monotonically increasing death timer with no forgiveness for progress
- Same limit (`maxRetries=3`) governs both genuine failures and transient strandedness
- Frequent restarts amplify the problem because every restart orphans all sessions

### Action items

| Action | Owner | Ticket | Status |
|--------|-------|--------|--------|
| Reset staleSessionRetryCount on phase transitions | orca | — | In progress |
| Investigate Linear state change interruptions (43% of all failures) | orca | — | Open |
| Consider separate cap for stale retries vs real retries | orca | — | Open |
| Add restart-aware grace period to reconciler | orca | — | Open |
