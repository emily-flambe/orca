## Context

Orca is a greenfield TypeScript project. There is no existing code — only a PDD at `docs/plans/2026-02-27-orca-design.md`. Phase 1 builds the scheduler engine without Linear integration or a web UI. Tasks are added via CLI and dispatched to `claude` CLI sessions running in isolated git worktrees.

The target runtime is an always-on Windows machine with Node.js, `claude` CLI (authenticated with a Pro/Max subscription), and `git` installed.

## Goals / Non-Goals

**Goals:**
- A working scheduler that spawns and manages concurrent CC sessions
- Git worktree isolation so concurrent sessions don't conflict
- Stream-json parsing for structured session monitoring
- Cost tracking and budget enforcement
- Retry logic with configurable limits
- CLI for task management and scheduler control

**Non-Goals:**
- Linear integration (Phase 2)
- Web UI (Phase 3)
- Human-in-the-loop / AskUserQuestion handling (designed out)
- Priority inheritance from dependency graphs (requires Linear)
- Webhook endpoints or tunnel setup

## Decisions

### 1. Project structure: monorepo with `src/` flat modules

Single package, no workspaces. Modules organized as flat directories under `src/`:

```
src/
  cli/          # CLI entry points (add, start, status)
  scheduler/    # Core dispatch loop
  runner/       # Process spawning and stream parsing
  worktree/     # Git worktree lifecycle
  db/           # SQLite schema, migrations, queries
  config/       # Env loading and validation
```

**Why:** Simplest structure for a single-purpose app. No need for monorepo overhead when there's one deployable artifact.

### 2. Database: better-sqlite3 with Drizzle ORM

Use `better-sqlite3` for the SQLite driver (synchronous, fast, no native compilation issues on Windows) with `drizzle-orm` for type-safe queries and schema management.

**Why over raw SQL:** Type safety catches schema drift at compile time. Drizzle is lightweight and doesn't require a code generator step.

**Why over Prisma:** Prisma requires a generation step and has heavier runtime. Drizzle is closer to the metal.

### 3. CLI framework: Commander.js

Use `commander` for the CLI. Three commands:

- `orca add --prompt "..." --repo /path/to/repo` — insert a task
- `orca start` — run the scheduler (foreground process)
- `orca status` — show current state (active sessions, queued tasks, budget)

**Why:** Lightweight, well-known, no magic. `yargs` is an alternative but Commander's chainable API is cleaner for 3 commands.

### 4. Process spawning: Node.js `child_process.spawn`

Spawn `claude` as a child process using `child_process.spawn` with `--output-format stream-json`. Read stdout line-by-line using a readline interface.

**Why not exec:** `exec` buffers all output. `spawn` streams, which is necessary for real-time monitoring and log tee-ing.

### 5. Scheduler loop: setInterval with async tick

The scheduler runs a tick function on a configurable interval (default 10s). Each tick:
1. Checks for open concurrency slots
2. Checks budget
3. Picks the highest-priority ready task
4. Dispatches it

The tick is async and guards against overlapping ticks with a simple mutex flag.

**Why not cron/node-cron:** Overkill for a single interval. setInterval is simpler and in-process.

### 6. Priority: simple numeric sort (Phase 1)

In Phase 1 without Linear, tasks have a `priority` column (integer, 0-4, matching Linear's scale). The scheduler sorts ascending (lower = more urgent). No dependency graph or priority inheritance — that comes with Linear in Phase 2.

### 7. Log storage: NDJSON files per invocation

Each invocation's stream-json output is tee'd to a file at `logs/<invocation-id>.ndjson`. The `invocations` table stores the path. Logs are append-only and can be replayed for debugging.

**Why files over DB:** Stream-json output can be large. SQLite blob storage works but makes the DB file grow unboundedly. Files are simpler to inspect and rotate.

### 8. TypeScript build: tsx for development, tsup for production

Use `tsx` for development (no build step, fast iteration). Use `tsup` to bundle for production/distribution.

**Why:** `tsx` runs TypeScript directly via esbuild. `tsup` produces a single bundled JS file for clean deployment.

## Risks / Trade-offs

- **[Risk] `claude` CLI behavior in `-p` mode may change between versions** → Pin to a known-good version in docs. Parse stream-json defensively.
- **[Risk] `better-sqlite3` native addon compilation on Windows** → Well-supported on Windows, but if issues arise, fallback to `sql.js` (pure JS SQLite).
- **[Risk] Git worktree creation fails if branch already exists** → Check for existing branch/worktree before creating. Reuse or clean up stale worktrees.
- **[Trade-off] No web UI means no real-time session visibility** → Console logging of session events is the Phase 1 substitute. Logs are stored for post-hoc review.
- **[Trade-off] No Linear means manual task entry via CLI** → Acceptable for Phase 1. The CLI is the minimum viable input mechanism.
