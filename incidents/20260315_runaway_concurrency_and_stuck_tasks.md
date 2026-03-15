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

**Phase 3 — Echo prevention and concurrency enforcement (commits 52e302d, 14b61f8, ab00b2c, 846eac4):**

Three additional bugs discovered after the initial fix:

1. **Echo prevention single-slot overwrite**: `expectedChanges` map stored one entry per task. Rapid state transitions (dispatched → in_review) overwrote the previous echo registration. Unrecognized echoes passed through `resolveConflict` which killed running sessions ("interrupted by Linear state change"). Fix: changed to array-based storage with independent TTLs per entry, extended TTL from 10s to 30s.

2. **TOCTOU race in `assertSessionCapacity()`**: Used only in-memory `activeHandles.size` which reset to 0 on every deploy. Multiple Inngest step callbacks on a fresh process all saw 0 and spawned beyond the cap. Fix: now uses `Math.max(DB running count, activeHandles.size, pendingSessionCount)` where DB count survives deploys and pendingSessionCount is a synchronous counter incremented before spawn.

3. **Phantom invocations**: `insertInvocation(status: "running")` was called BEFORE `assertSessionCapacity()`. When the check threw, the "running" invocation stayed in the DB permanently, inflating the count. Fix: moved capacity check before the insert.

**Phase 4 — Retry-echo kill loop (commit f8598c6):**

EMI-321 was killed 8+ times in 30 minutes by "interrupted by Linear state change" echo storms. Root cause: the retry path wrote "Todo" (unstarted) to Linear, then immediately re-dispatched which wrote "In Progress". Linear queued both webhooks, but the "Todo" webhook arrived after the 30s echo TTL expired. `resolveConflict` saw "unstarted" on a running task and killed the session. Cycle repeated endlessly.

Fix:
1. Increased echo TTL from 30s to 90s to survive Linear webhook delivery lag
2. Removed the "retry" (Todo) write-back before immediate re-dispatch — the intermediate state serves no purpose and creates the race condition

**Phase 5 — Stale cross-deploy echoes + dispatched state gap (commits ed32b7d, 778f438):**

After deploying Phase 4's fix, stale "Todo" webhooks from the OLD instance's pre-fix retry write-backs arrived minutes later on the NEW instance, which had no echo records for them. The 2-min recency guard (ed32b7d) protected "running" and "in_review" tasks, but missed the brief "dispatched" window between claim and session spawn. Stale "Todo" webhooks arriving during this window reset the task to "ready", triggering new workflow claims and spawning duplicate sessions. EMI-321 hit 6 concurrent sessions (filling the entire concurrency cap) for the same task.

Fix (778f438): Extended the stale-echo guard to also protect "dispatched" state. Any task in "running", "in_review", or "dispatched" that was updated within the last 2 minutes will ignore "Todo" webhooks as stale echoes.

## Lessons Learned

### What went well
- Process-level `assertSessionCapacity()` guard is a good safety net independent of Inngest's queue semantics
- Orphan detection on startup correctly cleaned up stale invocations
- Multi-layered capacity check (DB + in-memory + pending counter) is resilient to different failure modes

### What went wrong
- Inngest's `idempotency` semantics were misunderstood — assumed "one at a time" but actual behavior is "one per 24 hours"
- First fix was deployed without verifying stuck task re-dispatch still worked
- No integration test covering the full restart → re-emit → dispatch cycle
- 15 restarts in 1 hour suggest an underlying stability issue that wasn't investigated
- In-memory-only concurrency guards don't survive blue/green deploys — DB state is the only reliable source
- Inngest dev server's concurrency enforcement is unreliable — process-level guards are essential
- Write-back echo prevention with single-slot storage caused cascading session kills under rapid state transitions

### Action items

| Action | Owner | Ticket | Status |
|--------|-------|--------|--------|
| Investigate root cause of 15 restarts (crash loop) | emily | — | Open |
| Add integration test for restart re-emit covering all dispatchable statuses | orca | — | Open |
| Add alerting when active sessions exceed concurrency cap | orca | — | Open |
| Audit all workflow exit paths to ensure tasks never strand without re-emit | orca | — | Open |
