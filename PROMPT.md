# Orca — Agent Prompt

You are working on **Orca**, an AI agent scheduler that dispatches Claude Code CLI sessions against Linear issues. Read this file completely before making any changes.

## Architecture Overview

```
Linear Issues ──webhook/poll──> Orca DB (SQLite) ──scheduler──> Claude Code CLI sessions
                                     |                                   |
                                     v                                   v
                              Hono HTTP server                     Git worktrees
                            (REST API + SSE + dashboard)        (isolated per session)
```

**Backend** (`src/`): TypeScript, Node.js ESM, Hono, better-sqlite3 + Drizzle ORM, Commander.js CLI.
**Frontend** (`web/`): React 19, Vite, Tailwind CSS. Separate `package.json`. Talks to backend via REST + SSE.

## Critical Conventions

### ESM — All imports use `.js` extension
```typescript
// CORRECT
import { getTask } from "../db/queries.js";
import type { OrcaConfig } from "../config/index.js";

// WRONG — will fail at runtime
import { getTask } from "../db/queries";
```

### Type-only imports
Use `import type` for anything that's only used as a type annotation. TypeScript enforces this with `isolatedModules`.

### No default exports in backend
All backend modules use named exports. The frontend uses default exports for React components (standard React convention).

## Module Map

| Module | File | Purpose |
|---|---|---|
| Config | `src/config/index.ts` | Loads `.env`, validates, returns `OrcaConfig` |
| DB | `src/db/index.ts` | Creates SQLite connection, runs CREATE TABLE |
| Schema | `src/db/schema.ts` | Drizzle ORM table definitions |
| Queries | `src/db/queries.ts` | All typed DB query functions |
| Scheduler | `src/scheduler/index.ts` | Tick loop: timeout check → budget check → dispatch |
| Runner | `src/runner/index.ts` | Spawns `claude -p` with `--output-format stream-json` |
| Worktree | `src/worktree/index.ts` | `createWorktree` / `removeWorktree` |
| Linear Client | `src/linear/client.ts` | GraphQL API wrapper (raw fetch, no SDK) |
| Linear Sync | `src/linear/sync.ts` | `fullSync`, `processWebhookEvent`, conflict resolution |
| Dep Graph | `src/linear/graph.ts` | In-memory `blockedBy`/`blocks` Maps, priority inheritance |
| Webhook | `src/linear/webhook.ts` | Hono POST route with HMAC-SHA256 verification |
| Poller | `src/linear/poller.ts` | 30s fallback when tunnel is down |
| Tunnel | `src/tunnel/index.ts` | Spawns `cloudflared tunnel run`, health monitoring |
| Events | `src/events.ts` | Shared `EventEmitter` singleton for SSE |
| API | `src/api/routes.ts` | REST endpoints + SSE stream (Hono sub-app) |
| CLI | `src/cli/index.ts` | Commander.js: `add`, `prompt`, `start`, `status` |

## Database Schema

Three tables, all in SQLite with Drizzle ORM:

**tasks** — Primary key: `linear_issue_id` (text)
- `agent_prompt`, `repo_path`, `orca_status` (ready/dispatched/running/done/failed), `priority` (0-4), `retry_count`, `created_at`, `updated_at`

**invocations** — Auto-increment `id`, FK to `tasks.linear_issue_id`
- `started_at`, `ended_at`, `status` (running/completed/failed/timed_out), `session_id`, `branch_name`, `worktree_path`, `cost_usd`, `num_turns`, `output_summary`, `log_path`

**budget_events** — Auto-increment `id`, FK to `invocations.id`
- `cost_usd`, `recorded_at`

## Scheduler Flow

Each tick (every `ORCA_SCHEDULER_INTERVAL_SEC` seconds):
1. Check for timed-out invocations → kill session, mark failed, attempt retry
2. Count active sessions → skip if at `ORCA_CONCURRENCY_CAP`
3. Check budget in rolling window → skip if exhausted
4. Get ready tasks → filter out empty prompts → filter out blocked tasks (dependency graph)
5. Sort by effective priority (inherits from transitive dependents) → dispatch first

Dispatch: mark dispatched → insert invocation → create worktree → spawn claude CLI → mark running → attach completion handler.

Completion: update invocation → insert budget event → emit SSE events → mark done/failed → retry if applicable → write back to Linear.

## API Endpoints

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/tasks` | All tasks, sorted by priority then createdAt |
| `GET` | `/api/tasks/:id` | Task + invocation history |
| `PUT` | `/api/tasks/:id/prompt` | Update agent prompt. Body: `{ "prompt": "..." }` |
| `POST` | `/api/tasks/:id/dispatch` | Manual dispatch (bypasses scheduler) |
| `GET` | `/api/status` | Active sessions, queued count, budget info |
| `GET` | `/api/events` | SSE stream (task:updated, invocation:started/completed, status:updated) |
| `POST` | `/api/webhooks/linear` | Linear webhook (HMAC-SHA256 verified) |

## Commands

```bash
# Development
npm run dev start          # Run scheduler with tsx (no build needed)
cd web && npm run dev      # Dashboard dev server with HMR (port 5173)
npm test                   # Run all 58 tests
npm run test:watch         # Watch mode

# Production
npm run build              # Build backend with tsup → dist/
cd web && npm run build    # Build frontend with Vite → web/dist/
node dist/cli/index.js start  # Run production (serves dashboard from web/dist/)
```

## Testing Patterns

Tests use **Vitest** and live in `test/`. Pattern for API/DB tests:

```typescript
import { createDb } from "../src/db/index.js";
import { insertTask } from "../src/db/queries.js";

// In-memory SQLite for isolation
const db = createDb(":memory:");

// Insert test data
insertTask(db, {
  linearIssueId: "TEST-1",
  agentPrompt: "Fix the bug",
  repoPath: "/tmp/repo",
  orcaStatus: "ready",
  priority: 2,
  retryCount: 0,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
});
```

For API route tests, use `createApiRoutes(deps)` and call `app.request(url, init)` — no real HTTP server needed.

## Adding a New Feature — Checklist

1. Read existing code in the relevant module before writing
2. Follow ESM conventions (`.js` imports, `import type`)
3. Add queries to `src/db/queries.ts` (not inline SQL)
4. If it needs a new endpoint, add to `src/api/routes.ts`
5. If it changes scheduler behavior, update `src/scheduler/index.ts`
6. Emit events via `src/events.ts` for anything the dashboard should reflect
7. Write tests in `test/` using in-memory SQLite
8. Run `npx tsc --noEmit` to verify types, then `npm test` to verify behavior
9. Run `cd web && npx tsc --noEmit` if frontend was changed

## Windows-Specific Notes

- `better-sqlite3` requires native build tools (Visual Studio C++ workload or windows-build-tools)
- `cloudflared` must be installed separately and available on PATH
- Git worktree paths use backslashes — the worktree module uses `path.join` which handles this
- If `npm install` fails on `better-sqlite3`, try: `npm install --build-from-source`
- The `claude` CLI must be installed and authenticated before `orca start` will work

## What NOT to Do

- Don't use CommonJS (`require`). This is an ESM project.
- Don't add inline SQL. All queries go through Drizzle in `src/db/queries.ts`.
- Don't import from `src/` in `web/` or vice versa. They are separate projects.
- Don't modify the database schema without updating both `src/db/schema.ts` AND the CREATE TABLE statements in `src/db/index.ts`.
- Don't add dependencies without checking if Hono or Node.js builtins already cover the need.
