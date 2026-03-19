# Bug Report: Crash/restart orphans burn stale retries without progress check

**Date:** 2026-03-18
**Severity:** Medium
**Status:** Open
**Fixed in:** TBD

## Summary

When Orca restarts, all running sessions are orphaned. The stuck-task reconciler detects these as stranded and increments `staleSessionRetryCount` for each one. With 9 restarts on 2026-03-18, tasks in intermediate states accumulated stale counts rapidly, leading to permanent failure even for tasks that were working correctly before the restart.

## Symptoms

- 152 invocations failed with `orphaned by crash/restart` (42% of all failures)
- 9 Orca restarts on 2026-03-18
- Tasks like EMI-25 (17 invocations, multiple completed review cycles) permanently failed after accumulating stale counts across restarts
- EMI-27: 9 invocations, 5 orphaned by crash/restart, despite completing an implement phase

## Root Cause

The reconciler in `reconcile-stuck-tasks.ts` treats post-restart orphans identically to genuinely stuck tasks:

1. Orca restarts → all session handles lost
2. Next reconciliation (within 5 min) finds tasks in `running` with no handle
3. After 2-min grace period, increments `staleSessionRetryCount`
4. Task reset to `ready` and re-dispatched

This is correct behavior for recovery, but the stale count increment is punitive. The task didn't fail — Orca did. Yet the task pays the price.

With `maxRetries=3`, a task only survives 3 restarts before permanent failure. On a day with 9 restarts, any task active for more than a few hours is likely to be killed.

## Impact

- Estimated 4-6 tasks permanently failed primarily due to restart orphaning
- Compounds with other stale-detection triggers (slow transitions, Linear interruptions)
- Makes Orca instability self-reinforcing: more restarts → more failed tasks → less throughput

## Fix

1. Primary: Reset `staleSessionRetryCount` on phase progress (addresses root cause — see companion bug report)
2. Secondary: After a restart, skip the first reconciliation cycle or mark it as "restart recovery" so it doesn't increment stale count
3. Tertiary: Consider a separate, higher cap for restart-orphan retries vs genuine strandedness

## Prevention

- Reduce restart frequency (investigate why 9 restarts occurred)
- Add restart-aware reconciliation logic

## Timeline

| Time (UTC) | Event |
|------------|-------|
| 2026-03-18 16:45 | Orca deployed (1 of 9 restarts) |
| Throughout day | Tasks orphaned and stale counts incremented across restarts |
| 2026-03-19 02:00 | Pattern identified during failure analysis |
