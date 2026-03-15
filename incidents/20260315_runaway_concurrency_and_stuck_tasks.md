# Incident Report: Runaway Concurrency + Stuck Tasks After Idempotency Fix

**Date:** 2026-03-15
**Severity:** SEV-2 (major degradation)
**Duration:** ~2 hours (runaway sessions), ongoing (stuck tasks until second fix deployed)
**Status:** Resolved
**Fixed in:** 794e46e (partial), 257f24f (full)

## Summary

Orca spawned 26 concurrent Claude sessions despite a concurrency cap of 6, then a fix introducing Inngest `idempotency` inadvertently blocked all task re-dispatch for 24 hours, leaving 7 tasks stuck with no active workflow.

## Detection

User observed 26 running tasks in the Orca UI when the limit was 6. After the first fix deployed, user observed 7 queued tasks and 0 active — nothing was being dispatched.

## Impact

- 26 concurrent sessions spawned (cap: 6)
- $57.91 budget consumed in the 4h window (normally ~$15-20 per window)
- 30 invocations failed as "orphaned by crash/restart" from 15 restarts
- 7 tasks stuck in `changes_requested` (5) and `in_review` (2) after idempotency fix
- Affected tasks: EMI-310, EMI-311, EMI-312, EMI-314, EMI-315, EMI-316, EMI-321

## Root Cause

**Phase 1 — Runaway concurrency:**

Multiple sources emit `task/ready` events without deduplication:
1. Startup re-emit fires for all `ready` tasks on every restart
2. Linear webhooks fire independently
3. API routes allow manual status changes

With 15 restarts in the incident window, each restart re-emitted events for all ready tasks. Inngest's `concurrency` config queues excess events rather than rejecting them. As workflow runs completed and the queue drained, sessions piled up. The runner had no process-level guard — `spawnSession()` executed unconditionally regardless of how many sessions were already active.

**Phase 2 — Stuck tasks (self-inflicted by first fix):**

The first fix added `idempotency: "event.data.linearIssueId"` to prevent duplicate runs. However, Inngest's `idempotency` is sugar for `rateLimit` with a **24-hour window** — it blocks ALL re-runs for the same key value within that period, not just concurrent ones. This silently dropped every `task/ready` event for tasks that had already had a workflow run.

Additionally:
- Startup re-emit only covered `ready` tasks, ignoring `changes_requested` and `in_review`
- The retry path returned without re-emitting `task/ready`, so retryable failures never re-entered the dispatch queue
- Review/fix failure paths exited the workflow without re-emitting, stranding tasks

## Timeline

| Time (UTC) | Event |
|------------|-------|
| 03:11 | First restart of crash loop (15 restarts between 03:11-04:09) |
| 03:11-04:09 | Each restart re-emits task/ready, Inngest queues pile up |
| ~04:30 | 26 concurrent sessions observed |
| 05:21 | Root cause identified: no dedup on events, no process-level session cap |
| 05:23 | First fix deployed: `idempotency` key + `assertSessionCapacity()` |
| 05:24 | Runaway sessions resolved, orphans cleaned up |
| ~05:30 | 7 tasks stuck: queued in UI but 0 active, nothing dispatching |
| 05:45 | Root cause of stuck tasks identified: `idempotency` blocks re-runs for 24h |
| 00:03 | Second fix deployed: replaced idempotency with per-task concurrency, expanded startup re-emit, added retry re-emit |

## Mitigation Applied

1. Deployed `assertSessionCapacity()` to hard-block session spawning beyond cap
2. Restarted Orca to clear stale invocations via orphan detection

## Resolution

**Commit 794e46e (partial):**
- Added `assertSessionCapacity()` guard before all three `spawnSession()` calls
- Added `idempotency` key (later found to be wrong approach)

**Commit 257f24f (full):**
- Replaced `idempotency` with per-task `concurrency: [{ limit: 1, key: "event.data.linearIssueId" }]` — allows one workflow per task at a time but permits new runs after completion
- Expanded startup re-emit to cover `ready`, `changes_requested`, and `in_review`
- Added `task/ready` re-emit on retry path so retryable failures re-enter the queue

## Lessons Learned

### What went well
- Process-level `assertSessionCapacity()` guard is a good safety net independent of Inngest's queue semantics
- Orphan detection on startup correctly cleaned up stale invocations

### What went wrong
- Inngest's `idempotency` semantics were misunderstood — assumed "one at a time" but actual behavior is "one per 24 hours"
- First fix was deployed without verifying stuck task re-dispatch still worked
- No integration test covering the full restart → re-emit → dispatch cycle
- 15 restarts in 1 hour suggest an underlying stability issue that wasn't investigated

### Action items

| Action | Owner | Ticket | Status |
|--------|-------|--------|--------|
| Investigate root cause of 15 restarts (crash loop) | emily | — | Open |
| Add integration test for restart re-emit covering all dispatchable statuses | orca | — | Open |
| Add alerting when active sessions exceed concurrency cap | orca | — | Open |
| Audit all workflow exit paths to ensure tasks never strand without re-emit | orca | — | Open |
