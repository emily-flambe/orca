# Orca

AI agent scheduler that pulls tasks from Linear, dispatches them as Claude Code CLI sessions in isolated git worktrees, manages a multi-phase lifecycle (implement → review → fix → merge → deploy), and serves a real-time web dashboard.

## Tech Stack

- **Backend:** Node.js 22+, TypeScript (ESM, ES2022), Hono, SQLite (better-sqlite3 + drizzle-orm), Commander CLI
- **Frontend:** React 19, Vite, Tailwind CSS 3
- **Testing:** Vitest (backend + frontend), Playwright (E2E), @testing-library/react
- **CI:** GitHub Actions — tsc, eslint, prettier, vitest, playwright
- **Platform:** Windows (primary), macOS (supported). Extensive Windows-specific handling throughout (EPERM retry, taskkill, .cmd shim resolution, DLL_INIT cooldown).

## Commands

```bash
npm run dev              # Dev server (tsx)
npm run build            # Build backend (tsup)
npm test                 # Backend tests (vitest)
npm run lint             # ESLint
npm run format           # Prettier write
npm run format:check     # Prettier check (CI runs this)
npm run test:e2e         # Playwright E2E
cd web && npm test       # Frontend tests
cd web && npm run build  # Build frontend (vite)
```

## Architecture

| Directory | Role |
|-----------|------|
| `src/cli/` | Entry point. Commander CLI: `start`, `add`, `status` |
| `src/scheduler/` | Types + alert utilities (legacy scheduler removed — see `src/inngest/`) |
| `src/inngest/` | Inngest durable workflows: task lifecycle, CI merge, deploy monitor, cleanup cron |
| `src/runner/` | Spawns/kills Claude Code CLI. NDJSON stream parsing, rate limit detection |
| `src/session-handles.ts` | In-memory session handle registry for active Claude processes |
| `src/db/` | Schema (`tasks`, `invocations`, `budget_events`), queries, inline sentinel migrations |
| `src/api/` | Hono routes: tasks CRUD, invocation logs, SSE, metrics, deploy drain/unpause |
| `src/linear/` | GraphQL client, HMAC webhook, full sync, state write-back, conflict resolution, polling fallback |
| `src/github/` | `gh` CLI wrapper: PR find/merge/close, CI status, workflow runs |
| `src/worktree/` | Git worktree create/remove (Windows-aware) |
| `src/cleanup/` | Stale `orca/*` branch, orphaned worktree/PR cleanup |
| `src/config/` | Env var loading + built-in system prompts (implement, review, fix) |
| `src/tunnel/` | Cloudflared tunnel management |
| `src/mcp-server/` | Orca-state MCP server — exposes task metadata, invocation history to agents |
| `web/` | React dashboard (Vite + Tailwind) |

## Task Lifecycle

Full state machine with diagrams: `docs/ticket-lifecycle.md`

```
backlog → ready → running [implement]
  → in_review → running [review]
    → approved → awaiting_ci → merge → deploying → done
    → changes_requested → running [fix] → back to in_review
  → failed (retries up to ORCA_MAX_RETRIES, then permanent failure)
```

Orchestrated by Inngest durable workflows (replaced the legacy 10s tick-loop scheduler):

- **task-lifecycle**: `task/ready` event triggers implement → Gate 2 → review → fix loop
- **ci-gate-merge**: `task/awaiting-ci` event triggers CI polling + merge
- **deploy-monitor**: `task/deploying` event triggers deploy status polling
- **cleanup cron**: runs every 5 min (stale branches, worktrees, orphaned PRs)

**Gate 2** (post-implement): verifies PR via `gh pr list --head <branch>`, URL extraction fallback, then worktree diff. No PR = failure + retry.

**Review**: separate agent (haiku) reads diff, verifies requirements, runs tests. Must output `REVIEW_RESULT:APPROVED` or `REVIEW_RESULT:CHANGES_REQUESTED`.

**CI gate**: polls `mergeStateStatus`. Merges via GitHub API when `CLEAN`.

**Self-deploy**: when task repo matches orca's `process.cwd()`, spawns `scripts/deploy.sh` detached.

## Conventions

- **Imports:** ESM with `.js` extensions
- **Naming:** camelCase functions, PascalCase types, UPPER_SNAKE_CASE constants
- **Logging:** `console.log/warn` with module tags: `[orca/scheduler]`, `[orca/sync]`, `[orca/runner]`
- **DB queries:** Synchronous (better-sqlite3), named functions in `src/db/queries.ts`
- **Migrations:** Sentinel-based in `src/db/index.ts` (check column via PRAGMA, then ALTER TABLE)
- **Error handling:** Try/catch with context. Fire-and-forget for non-critical async (Linear comments)
- **File org:** One module per directory with `index.ts`, types co-located

## Web Dashboard

The Orca dashboard is a React SPA served at the root. It has multiple pages accessible via the sidebar navigation:

| Route | Page |
|-------|------|
| `/` | Dashboard — active sessions, task overview |
| `/metrics` | Metrics — cost, tokens, throughput |
| `/tasks` | Tasks — full task list with status |
| `/cron` | Cron — scheduled jobs (shell commands and Claude prompts on cron schedules) |
| `/logs` | Logs — invocation logs |
| `/settings` | Settings — configuration |

**The `/cron` page shows Orca's built-in cron schedules** — these are Orca-managed crons (NOT Inngest crons, NOT OS-level crons). They persist across restarts and are visible/editable in the dashboard UI.

When investigating dashboard features, **use Playwright to screenshot `http://localhost:<active-port>/` pages** rather than grepping source code. The active port is in `deploy-state.json`. External URL requires Cloudflare Access auth that Playwright can't pass — always use localhost.

## Git Discipline (MANDATORY)

**Commit and push after every logical unit of work. Do not accumulate uncommitted changes.**

- After finishing a feature, fix, refactor, or test update: `git add`, `git commit`, `git push`.
- After fixing lint/format/type errors: commit and push immediately.
- Before ending a session or switching tasks: verify everything is committed and pushed.
- Never leave work uncommitted. If `git status` shows modified files, commit them.
- Push to the working branch (or main if instructed). Do not leave commits unpushed.
- Run verification (`tsc`, `lint`, `format:check`, `test`) before committing — but still commit even if there's a pre-existing flaky test. Do not let perfect be the enemy of committed.

**The rule: code that isn't pushed doesn't exist.** If you wrote it, stage it, commit it, push it.

## Deploying

After pushing to main, **always deploy via the single script**. Never start orca manually.

```bash
bash /c/Users/emily/Documents/Github/orca/scripts/deploy.sh
```

Blue/green zero-downtime: new instance on standby port → health check → switch Cloudflare tunnel → drain old → kill old. Port alternates 4000/4001 (`deploy-state.json`).

Deploy after: backend changes (`src/**/*.ts`), frontend rebuild (`web/dist/`), `.env`/config changes.

### Post-Deploy Verification (MANDATORY)

After deploying any scheduler/workflow/Inngest changes, you MUST verify the system is actually working — not just that tests passed. "Tests green + deployed" is NOT done.

1. Wait 2 minutes for the new instance to stabilize
2. Check `deploy-state.json` to confirm the deploy timestamp updated
3. Query the Orca DB: are tasks moving through statuses? Are running task counts ≤ `ORCA_CONCURRENCY_CAP`?
4. Query Inngest (`curl localhost:8288/v0/gql`) for recent `task-lifecycle` runs — check for FAILED runs, not just COMPLETED
5. If any ready tasks exist with no active Inngest workflow, the dispatch pipeline is broken — investigate before declaring success

**Do not declare victory until a task has demonstrably moved through at least one lifecycle transition after deploy.**

## Inngest Workflow Invariants

These rules exist because violations have caused production outages:

### Never throw in claim steps (retries: 0)

All Orca Inngest functions use `retries: 0`. A thrown error in any step permanently kills the workflow — the task is orphaned. Always catch errors in claim steps and return `{ claimed: false, reason: "..." }` so the workflow exits gracefully and the reconciler can re-dispatch.

### DB changes must emit corresponding Inngest events

Never update `orca_status` in the DB without emitting the matching Inngest event. The DB and Inngest event queue must stay in sync:

| DB status change | Required Inngest event |
|-----------------|----------------------|
| → `ready` | `task/ready` |
| → `awaiting_ci` | `task/awaiting-ci` |
| → `deploying` | `task/deploying` |

If you reset a task to `ready` via direct DB query (debugging, manual fix, etc.), you MUST also emit `task/ready` or the task will sit orphaned until the reconciler's 5-minute re-dispatch cycle picks it up.

### Tests pass ≠ system works

Unit tests with mocked Inngest steps cannot catch workflow-level failures (e.g., "step throws → workflow dies → task orphaned forever"). For scheduler/workflow changes:

- Unit tests verify individual step logic
- Integration verification (post-deploy) verifies the workflow chain actually executes
- Both are required. Shipping with only unit tests has caused repeated outages.

## MCP Integration

Orca adopts MCP for **agent-facing integrations only** — scheduler-side integrations (`src/linear/`, `src/github/`) remain hardcoded TypeScript. Full decision: `docs/mcp-architecture.md`, ADR: `docs/adr/EMI-349-mcp-extension-mechanism.md`.

- **Runner**: generates an MCP config JSON at spawn time, passes `--mcp-config <path> --strict-mcp-config` to each Claude session
- **Orca-state MCP server** (`src/mcp-server/`): stdio server exposing task metadata, invocation history, and parent issue context to agents
- **Adding new MCP servers**: add entries to the `mcpServers` config in the runner's session options — no scheduler code changes needed

## Creating Linear Issues

Reference `docs/linear_issue_templates.md` and apply the appropriate template (Feature, Bug Fix, Refactor, Planning, Discovery). Fill all sections with real content.

## Linear ↔ Repo Mapping

Each Linear project description must contain a `repo:` line:
```
repo: C:\Users\emily\Documents\Github\orca
```
Scheduler uses this to create worktrees in the correct repo. Falls back to `ORCA_DEFAULT_CWD`.
