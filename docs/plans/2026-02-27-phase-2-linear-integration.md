# Phase 2: Linear Integration — Design

## Overview

Connect Orca's scheduler engine to Linear as the task source. Issues flow from Linear into Orca via webhooks (with polling fallback), and Orca writes status updates back. The dependency graph drives dispatch ordering with priority inheritance.

## Linear API Client

`src/linear/client.ts` wraps the Linear GraphQL API at `https://api.linear.app/graphql`.

**Authentication:** `ORCA_LINEAR_API_KEY` sent as `Authorization: <key>` header.

**Core queries:**

- `fetchProjectIssues(projectIds)` — All issues from configured projects. Fields: id, identifier, title, priority, state (id, name, type), relations, inverseRelations. Paginates with `first: 25` to stay under complexity limits.
- `fetchWorkflowStates(teamId)` — Team workflow states (id, name, type). Cached on startup for state type → UUID mapping during write-back.
- `updateIssueState(issueId, stateId)` — Mutates issue workflow state via `issueUpdate`.

**Rate limit safety:** Reads `X-RateLimit-Requests-Remaining` header, logs warnings below 500. All queries use `first: 25`.

**Types:** `LinearIssue` — id, identifier, title, priority, stateType, blockedByIds, blockingIds.

## Webhook Endpoint + Cloudflared Tunnel

### Webhook Server

Hono endpoint at `POST /api/webhooks/linear`. On startup, Orca verifies the webhook exists pointing to `https://<ORCA_TUNNEL_HOSTNAME>/api/webhooks/linear`.

Every incoming webhook is verified via HMAC-SHA256 using `ORCA_LINEAR_WEBHOOK_SECRET`. Invalid signatures → 401.

### Webhook Handler

Parses issue events (create, update, remove):

1. Check if the issue belongs to a configured project — ignore if not.
2. Map new Linear state to Orca status using `state.type`.
3. Compare with Orca's current status.
4. If they conflict, Linear wins — kill sessions if needed, update DB, log resolution.

### Cloudflared Tunnel

`src/tunnel/index.ts` spawns `cloudflared tunnel run` as a child process on `orca start`. Monitors stdout/stderr for connection status. Exposes a health check for the polling fallback.

### Polling Fallback

`src/linear/poller.ts` runs alongside the webhook handler. When tunnel health check fails, poller activates — fetches issues updated since last sync every 30s using `updatedAt` filter. When tunnel recovers, polling stops.

## Dependency Graph + Priority Inheritance

### Graph Storage

`src/linear/graph.ts` maintains an in-memory dependency graph, rebuilt on full sync and updated incrementally by webhooks.

Data structure: `blockedBy: Map<issueId, Set<issueId>>` and `blocks: Map<issueId, Set<issueId>>`.

### Dispatch Filtering

Before selecting a ready task, the scheduler calls `isDispatchable(taskId, graph, db)`. Checks that every blocker in `blockedBy[taskId]` has Orca status "done" (or Linear state.type "completed"). If any blocker is incomplete, the task is skipped.

### Priority Inheritance

At dispatch time, `computeEffectivePriority(taskId, graph, priorities)` walks `blocks` edges transitively. If A blocks B blocks C, and C has priority 1 (urgent), A and B both inherit priority 1. Effective priority = `min(ownPriority, min(transitive blocked priorities))`. Lower = more urgent.

### Scheduler Integration

The Phase 1 `getReadyTasks` query is wrapped with: filter out blocked tasks → recompute effective priorities → re-sort. Replaces the simple priority sort in the tick function.

### Cache Invalidation

Graph rebuilt from scratch on full sync (startup + periodic). Updated incrementally on webhook relation events. Stale graph corrected by next full sync.

## Status Write-back + Conflict Resolution

### Write-back

When Orca transitions a task, it updates the Linear issue using cached workflow state UUIDs:

| Orca transition | Linear state type target |
|---|---|
| ready → dispatched | `started` |
| running → done | `completed` |
| running → failed (permanent) | `canceled` |
| failed → ready (retry) | `unstarted` |

Write-back happens in scheduler dispatch/completion handlers. Failures are logged but don't block Orca's internal state transition.

### Conflict Resolution (Linear Wins)

When a webhook arrives with a state change:

1. **Running → unstarted:** Kill active session, mark invocation "failed" (summary: "interrupted by Linear state change"), reset task to "ready".
2. **Ready → completed:** Set Orca status to "done".
3. **Done → unstarted:** Reset Orca status to "ready" (re-dispatch eligible).
4. **Any → canceled:** Set Orca status to "failed" permanently (skip retry).

Webhook handler imports `activeHandles` and `killSession` from scheduler/runner. Logic encapsulated in `resolveConflict(taskId, linearStateType, db)`.

### Write-back Loop Prevention

When Orca writes a state to Linear, the resulting webhook would trigger conflict resolution. Orca tracks "expected" state changes in a short-lived set (taskId → expectedStateType, TTL 10s). Webhooks matching expected changes are treated as echoes and ignored.

## Config Changes

**New variables:**

| Variable | Default | Required |
|---|---|---|
| `ORCA_LINEAR_API_KEY` | — | yes |
| `ORCA_LINEAR_WEBHOOK_SECRET` | — | yes |
| `ORCA_LINEAR_PROJECT_IDS` | — | yes (JSON array) |
| `ORCA_LINEAR_READY_STATE_TYPE` | `"unstarted"` | no |
| `ORCA_TUNNEL_HOSTNAME` | — | yes |

Added to `OrcaConfig` and validated in `loadConfig()`. JSON array for project IDs parsed and validated. `.env.example` updated.

## CLI Additions

**`orca prompt <issueId> "<text>"`** — Sets or updates the agent prompt for a Linear issue in SQLite. This is how users assign work.

## Modified Startup Flow (`orca start`)

1. Load config, create DB (unchanged)
2. Initialize Linear client, fetch workflow states, cache state type → UUID mapping
3. Full sync — fetch all issues from configured projects, upsert into tasks table, build dependency graph
4. Start Hono server on `ORCA_PORT` (webhook endpoint)
5. Spawn cloudflared tunnel, start polling fallback monitor
6. Start scheduler loop (tick now uses dependency-aware dispatch)
7. Register shutdown handlers (extended to kill tunnel process)

## Task Creation from Linear

When a Linear issue syncs with state.type matching `ORCA_LINEAR_READY_STATE_TYPE`, Orca creates a task record if one doesn't exist. Starts with empty `agent_prompt` — not dispatched until a prompt is set via `orca prompt`. Scheduler skips tasks with empty prompts.

## New Module Structure

```
src/
  linear/
    client.ts      # GraphQL API wrapper
    graph.ts       # Dependency graph + priority inheritance
    poller.ts      # Polling fallback
    sync.ts        # Full sync + webhook event processing
    webhook.ts     # Hono route handler + HMAC verification
  tunnel/
    index.ts       # Cloudflared tunnel lifecycle
```

## Testing Strategy

- Unit tests for dependency graph (transitivity, cycles, priority inheritance)
- Unit tests for conflict resolution (all state combinations)
- Unit tests for write-back loop prevention
- Integration test with mock Linear GraphQL responses
- Integration test for webhook HMAC verification
- Integration test for polling fallback activation/deactivation
