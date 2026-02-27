## Context

Orca Phase 1 established the core scheduler engine: SQLite-backed task queue, concurrent session spawning, git worktree isolation, stream-json parsing, budget enforcement, and retry logic. Tasks are added manually via `orca add` CLI.

Phase 2 connects Orca to Linear as the task source. The target runtime remains a single always-on machine with Node.js, `claude` CLI, `git`, and now `cloudflared` installed.

The Linear API is GraphQL at `https://api.linear.app/graphql` with rate limits of 5,000 requests/hr and 250k complexity points/hr.

## Goals / Non-Goals

**Goals:**
- Automatic task sync from Linear projects into Orca's queue
- Real-time webhook-based sync with polling fallback
- Bidirectional status mapping (Linear ↔ Orca)
- Conflict resolution where Linear always wins (including killing running sessions)
- Dependency-aware dispatch filtering from Linear's blocking relations
- Transitive priority inheritance from the dependency graph
- CLI command for setting agent prompts on synced issues

**Non-Goals:**
- Web UI (Phase 3)
- Creating or modifying Linear issues from Orca
- Multi-team or cross-project dependency resolution
- Custom webhook registration via Linear API (manual setup in Linear admin)
- PR creation or GitHub integration

## Decisions

### 1. GraphQL client: raw fetch, no SDK

Use `fetch` directly with typed response interfaces rather than the `@linear/sdk` package.

**Why:** The SDK adds ~2MB of dependencies and abstracts the pagination model. Orca only needs 3 queries (issues, workflow states, issue update). Raw fetch with a thin wrapper is simpler and gives full control over pagination and error handling.

### 2. Webhook verification: HMAC-SHA256

Linear signs webhook payloads with HMAC-SHA256 using a webhook secret. Orca verifies every incoming request before processing.

**Why:** Standard practice for webhook security. Prevents spoofed payloads from triggering state changes or session kills.

### 3. Tunnel: spawn cloudflared as child process

Orca spawns `cloudflared tunnel run` as a managed child process during `orca start`. The tunnel config (hostname, credentials) is pre-configured via `cloudflared` CLI setup (one-time manual step).

**Why over manual tunnel management:** Orca can monitor tunnel health and activate polling fallback automatically. The tunnel lifecycle is tied to the scheduler process.

**Alternative considered:** Run cloudflared as a separate system service. Rejected because it decouples tunnel health from Orca's awareness, making fallback detection harder.

### 4. Polling fallback: timer-based with updatedAt filter

When the tunnel is down, poll Linear every 30 seconds for issues updated since last sync. Use the `updatedAt` filter to minimize data transfer.

**Why 30s:** Balances freshness against rate limit consumption (~120 requests/hr, well within the 5,000/hr limit).

### 5. Dependency graph: in-memory adjacency lists

Store the dependency graph as two `Map<string, Set<string>>` structures (blockedBy, blocks). Rebuild from scratch on full sync, update incrementally on webhook events.

**Why in-memory over SQLite:** The graph is derived data from Linear. Keeping it in memory avoids schema complexity and makes transitive queries fast. Rebuilt on restart from the full sync.

### 6. Priority inheritance: computed at dispatch time

Effective priority is computed by walking the `blocks` graph transitively at dispatch time. Not cached — always reflects current graph state.

**Why not cached:** The graph changes with every webhook. Caching would require invalidation logic more complex than just recomputing. With typical project sizes (<1000 issues), the traversal is sub-millisecond.

### 7. Write-back loop prevention: TTL-based expected set

When Orca writes a state change to Linear, it stores the (taskId, expectedStateType) in a Map with a 10-second TTL. Incoming webhooks that match an expected change are treated as echoes and skipped.

**Why 10s TTL:** Linear webhooks typically arrive within 1-3 seconds of a mutation. 10 seconds provides ample buffer while preventing stale entries from accumulating.

### 8. Agent prompt storage: existing tasks table

Agent prompts are already stored in the `tasks.agent_prompt` column. The `orca prompt` command updates this field. Tasks synced from Linear start with an empty prompt and are not dispatched until a prompt is set.

**Why not a separate table:** The data model already supports this. No schema changes needed.

## Risks / Trade-offs

- **[Risk] Cloudflared requires manual one-time setup** → Document the setup steps. Orca validates tunnel health on startup and falls back to polling if misconfigured.
- **[Risk] Linear webhook delivery is not guaranteed** → Polling fallback handles missed webhooks. Full resync on startup catches any drift.
- **[Risk] Write-back loop could still occur if webhook arrives after TTL expires** → 10s TTL is generous. Worst case: Orca processes its own echo as a no-op (state already matches).
- **[Risk] Dependency graph cycles in Linear (A blocks B blocks A)** → Guard the transitive walk with a visited set to prevent infinite loops. Log a warning if a cycle is detected.
- **[Trade-off] Tasks require manual prompt setting via CLI** → Acceptable for Phase 2. Phase 3 UI will provide an agent prompt editor. The CLI is functional but not ergonomic for many tasks.
- **[Trade-off] Single project scope per Orca instance** → Config accepts an array of project IDs, but cross-project dependencies are not resolved. Sufficient for single-team use.
