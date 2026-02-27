## Why

Orca's scheduler engine works but requires manual task entry via CLI. Phase 2 connects it to Linear so issues flow in automatically, status updates flow back, and the dependency graph drives dispatch ordering. This turns Orca from a manual tool into an autonomous dispatch system tied to existing project management.

## What Changes

- New Linear GraphQL API client for fetching issues, workflow states, and dependencies
- Webhook endpoint (Hono route) for real-time issue sync from Linear, verified via HMAC-SHA256
- Cloudflared tunnel management for exposing the webhook endpoint to the internet
- Polling fallback that activates when the tunnel is down, deactivates when it recovers
- Bidirectional status sync: Linear state changes map to Orca statuses and vice versa
- Conflict resolution where Linear always wins — including killing running sessions if Linear state contradicts Orca
- Write-back loop prevention via expected-change tracking with TTL
- In-memory dependency graph built from Linear relations/inverseRelations
- Dependency-aware dispatch filtering (skip tasks with unresolved blockers)
- Transitive priority inheritance from the dependency graph
- New `orca prompt` CLI command for setting agent prompts on Linear issues
- Scheduler skips tasks with empty agent prompts (tasks created from Linear sync start promptless)
- Extended shutdown handling to kill the tunnel process

## Capabilities

### New Capabilities

- `linear-client`: GraphQL API wrapper — authentication, issue fetching, workflow state caching, issue state mutation, rate limit monitoring
- `linear-sync`: Full sync on startup, incremental sync via webhooks, polling fallback, conflict resolution, write-back loop prevention
- `linear-webhook`: Hono endpoint for receiving Linear webhook events, HMAC-SHA256 signature verification
- `dependency-graph`: In-memory graph from Linear relations, dispatch filtering for blocked tasks, transitive priority inheritance computation
- `tunnel-manager`: Cloudflared tunnel lifecycle management, health monitoring, startup/shutdown

### Modified Capabilities

- `config`: New required variables (`ORCA_LINEAR_API_KEY`, `ORCA_LINEAR_WEBHOOK_SECRET`, `ORCA_LINEAR_PROJECT_IDS`, `ORCA_TUNNEL_HOSTNAME`) and optional variable (`ORCA_LINEAR_READY_STATE_TYPE`)
- `scheduler`: Tick function now filters blocked tasks and sorts by effective priority instead of stored priority; dispatch and completion handlers now write back to Linear
- `cli`: New `orca prompt` command; extended `orca start` to initialize Linear client, run full sync, start Hono server, spawn tunnel
- `task-management`: Tasks can now be created from Linear sync with empty prompts; scheduler skips promptless tasks

## Impact

- **New dependencies:** `hono` already installed; may need a GraphQL request library or use raw `fetch`
- **Config:** 5 new environment variables, 4 required — existing `.env` files need updating
- **Database:** No schema changes; tasks table already has `linear_issue_id` as PK and `agent_prompt` field
- **Scheduler:** Tick function signature unchanged but internal logic adds dependency filtering and priority inheritance
- **External systems:** Requires Linear API key, webhook configuration, and cloudflared installed on the host machine
- **Network:** Outbound HTTPS to `api.linear.app`; inbound via cloudflared tunnel for webhooks
