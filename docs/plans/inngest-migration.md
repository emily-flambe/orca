# Inngest Migration Plan

**Status:** In Progress
**Created:** 2026-03-13
**Linear Milestone:** Inngest Migration (Orca project)

## Overview

Replace orca's hand-rolled 2,948-line scheduler (`src/scheduler/index.ts`) with Inngest, an open-source durable workflow engine. The scheduler currently has 7 independent retry mechanisms, 6+ in-memory Maps lost on restart, and scattered state transitions — making it structurally unreliable.

Inngest provides durable step functions, built-in retries/timeouts/concurrency, and crash recovery. Self-hosted with SQLite (matching our current stack).

## Architecture Decisions

### Session Handling: `step.waitForEvent()` Pattern

Claude sessions run 10-45 minutes. Instead of blocking an Inngest step:

```
step.run("start-session") → spawns Claude process, returns invocation ID
step.waitForEvent("await-result") → waits for "session/completed" event (up to 1h)
```

The runner emits an Inngest event when sessions complete. This decouples workflow execution from process lifetime.

### Replacing the 10-Second Tick Loop

| Current tick step | Inngest replacement |
|---|---|
| Timeout check | `step.waitForEvent()` timeout parameter |
| Deploy monitoring | Separate workflow with `step.sleep("30s")` poll loop |
| CI gate polling | Separate workflow triggered by `task/awaiting-ci` event |
| DLL cooldown | Keep as application-level state (Windows-specific) |
| Cleanup | Inngest cron function (every 5 min) |
| Concurrency check | Inngest `concurrency` config |
| Budget check | Pre-dispatch step in workflow |
| Task dispatch | Event-driven: `task/ready` event triggers lifecycle workflow |

### Cron Granularity

Inngest cron uses minute-level granularity. The 10-second tick becomes unnecessary since dispatch is event-driven. Polling workflows (CI, deploy) use `step.sleep()` loops internally.

### State Querying

Inngest self-hosted has no API for "what step is workflow X on?" We maintain our own state in the existing SQLite DB (tasks/invocations tables). Inngest handles orchestration; our DB remains the source of truth for UI/API queries.

## Phase Plan

### Phase 1: Foundation

1. **EMI-286: Install Inngest SDK + client module** — `npm install inngest`, create typed client + event definitions
2. **EMI-287: Set up Inngest server** — `inngest start` as a process, SQLite persistence
3. **EMI-288: Inngest serve endpoint** — Add `/api/inngest` route to Hono API (blocked by EMI-286)

**Dependencies:** None. Can start immediately.

### Phase 2: Extract Domain Logic

Extract business logic from the monolithic scheduler into standalone, testable functions. Each extraction is independent. All blocked by EMI-286.

4. **EMI-289: Extract session spawning** — dispatch logic → `src/inngest/activities/spawn-session.ts` (~490 lines)
5. **EMI-290: Extract Gate 2** — PR verification → `src/inngest/activities/verify-pr.ts` (~350 lines)
6. **EMI-291: Extract review parsing** — review result → `src/inngest/activities/parse-review.ts` (~155 lines)
7. **EMI-292: Extract CI/merge** — CI polling + merge → `src/inngest/activities/ci-merge.ts` (~440 lines)
8. **EMI-293: Extract deploy monitoring** — deploy poll → `src/inngest/activities/deploy-monitor.ts` (~135 lines)

### Phase 3: Build Inngest Workflows

9. **EMI-294: Runner event emitter** — Modify runner to emit `session/completed` events (blocked by EMI-286)
10. **EMI-295: Task lifecycle workflow** — Main workflow: implement → Gate 2 → review → fix → CI (blocked by EMI-289,290,291,294)
11. **EMI-296: CI gate workflow** — Triggered by `task/awaiting-ci`, polls and merges (blocked by EMI-292)
12. **EMI-297: Deploy monitoring workflow** — Triggered by `task/deploying` (blocked by EMI-293)
13. **EMI-298: Cleanup cron workflow** — Replaces cleanup tick (blocked by EMI-286)

### Phase 4: Integration & Wiring

14. **EMI-299: Wire Linear webhooks to Inngest events** (blocked by EMI-295)
15. **EMI-300: Update API routes** for Inngest-based task management (blocked by EMI-295)
16. **EMI-301: Migrate budget/concurrency** to Inngest config (blocked by EMI-295)

### Phase 5: Validation & Cutover

17. **EMI-302: Integration tests** for Inngest workflows (blocked by EMI-295,296,297)
18. **EMI-303: Cutover** — Remove old scheduler, Inngest sole orchestrator (blocked by EMI-302)

## Key Risks

1. **Windows Inngest server stability** — inngest-cli had historical Windows issues (fixed, but verify)
2. **Long-running steps** — 45-min Claude sessions need `waitForEvent` pattern, not blocking steps
3. **Migration window** — Orca must remain functional throughout migration
4. **State migration** — In-flight tasks during cutover need handling
5. **DLL cooldown** — Windows-specific, no Inngest equivalent — must keep as app-level logic

## Inngest Server Setup

```bash
# Self-hosted production mode (single process, SQLite)
inngest start --event-key "orca-event-key" --signing-key "orca-signing-key"
# Runs on port 8288 (API/UI), 8289 (Connect gateway)
# SQLite at ./.inngest/main.db

# SDK env vars
INNGEST_EVENT_KEY=orca-event-key
INNGEST_SIGNING_KEY=orca-signing-key
INNGEST_BASE_URL=http://localhost:8288
INNGEST_DEV=0
```

## Progress Tracking

Check this file + Linear milestone "Inngest Migration" for current status. Each phase updates this section.

- [x] Phase 1: Foundation (EMI-286 merged, EMI-287 merged, EMI-288 merged)
- [x] Phase 2: Extract Domain Logic (EMI-289-294 done, PR #318 merged)
- [x] Phase 3: Build Inngest Workflows (EMI-295 merged, EMI-296-298 merged via #322)
- [x] Phase 4: Integration & Wiring (EMI-299 #326, EMI-300+301 #329 merged)
- [x] Phase 5: Cutover (EMI-303 #333 merged — ORCA_USE_INNGEST toggle)
- [ ] Phase 5b: Integration tests (EMI-302) + production verification

### Orca-managed worktrees
Orca is actively working on migration tickets in parallel. Check `git worktree list` for active work.
