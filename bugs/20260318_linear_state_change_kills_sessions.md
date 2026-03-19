# Bug Report: Linear state change interruptions are the #1 invocation killer

**Date:** 2026-03-18
**Severity:** High
**Status:** Open
**Fixed in:** TBD

## Summary

"Interrupted by Linear state change" accounts for 43% of all failed invocations (154 of 361), making it the single largest failure mode. It's unclear how many of these are user-initiated vs echo-back from Orca's own status writes.

## Symptoms

- 154 invocations failed with `interrupted by Linear state change`
- Affects tasks across all phases (implement, review, fix)
- Some tasks (EMI-332, EMI-345, EMI-348) completed multiple successful review cycles before being killed by a single Linear state change
- EMI-332: 13 completed invocations, ~$36 spent, then killed by a state change on the 14th

## Root Cause

Orca writes status changes back to Linear and registers expected changes to prevent echo-back (with a 10s window per `src/linear/sync.ts`). Potential failure modes:

1. **Echo window too short**: If the Linear webhook arrives >10s after the write, it's treated as an external change and kills the session
2. **Multiple rapid state changes**: Orca writes status A, then immediately B — the webhook for A arrives after B was written, but A is no longer in the expected set
3. **User-initiated changes**: Users moving tickets in Linear while Orca is actively working on them
4. **Webhook batching**: Linear may batch or delay webhook delivery, causing echoes to arrive outside the prevention window

Without distinguishing user-initiated from echo-back interruptions, the true ratio is unknown.

## Impact

- 154 wasted invocations across all failed tasks
- Contributes to staleSessionRetryCount accumulation (each interrupted session may leave the task stranded, triggering the reconciler)
- Significant compute waste on tasks that were making progress

## Fix

Investigation needed:
1. Add logging to distinguish echo-back vs user-initiated state changes (log the expected change set at time of webhook receipt)
2. Consider increasing the echo prevention window from 10s to 30-60s
3. Consider comparing the Linear user ID on the webhook event — if it's the Orca API key's user, it's definitely an echo
4. For user-initiated changes, consider a grace period before killing the session

## Prevention

- Log the expected change set and the incoming webhook change for post-hoc analysis
- Add metrics: echo-back vs user-initiated interruption rate

## Timeline

| Time (UTC) | Event |
|------------|-------|
| Ongoing | 154 invocations killed by Linear state changes across operational history |
| 2026-03-19 02:00 | Pattern identified during systematic failure analysis |
