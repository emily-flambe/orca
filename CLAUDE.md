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
| `web/` | React dashboard (Vite + Tailwind) |

## Task Lifecycle

Full state machine with diagrams: `docs/ticket-lifecycle.md`

```
backlog → ready → dispatched → running [implement]
  → in_review → dispatched → running [review]
    → approved → awaiting_ci → merge → deploying → done
    → changes_requested → dispatched → running [fix] → back to in_review
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

## Deploying

After pushing to main, **always deploy via the single script**. Never start orca manually.

```bash
bash /c/Users/emily/Documents/Github/orca/scripts/deploy.sh
```

Blue/green zero-downtime: new instance on standby port → health check → switch Cloudflare tunnel → drain old → kill old. Port alternates 4000/4001 (`deploy-state.json`).

Deploy after: backend changes (`src/**/*.ts`), frontend rebuild (`web/dist/`), `.env`/config changes.

## Creating Linear Issues

Reference `docs/linear_issue_templates.md` and apply the appropriate template (Feature, Bug Fix, Refactor, Planning, Discovery). Fill all sections with real content.

## Linear ↔ Repo Mapping

Each Linear project description must contain a `repo:` line:
```
repo: C:\Users\emily\Documents\Github\orca
```
Scheduler uses this to create worktrees in the correct repo. Falls back to `ORCA_DEFAULT_CWD`.
