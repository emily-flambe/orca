## Why

Orca needs a working scheduler engine before anything else can be built. Phase 1 establishes the core loop: accept tasks, spawn Claude Code CLI sessions in isolated git worktrees, monitor their output, handle completion/failure/timeout, and retry on failure. This is the foundation that Linear integration (Phase 2) and the UI (Phase 3) build on top of.

Without this, Orca is just a design document.

## What Changes

- New TypeScript/Node project with Hono backend
- SQLite database with `tasks`, `invocations`, and `budget_events` tables
- CLI interface to add tasks and start the scheduler
- Scheduler loop that maintains a configurable concurrency cap of active CC sessions
- Git worktree creation/cleanup per invocation for session isolation
- Process spawning of `claude -p` with `--output-format stream-json`
- Stream parser that captures session IDs, completion status, cost, and turn count
- Hard timeout enforcement that kills sessions exceeding max duration
- Retry logic with configurable max retries
- Cost-based budget tracking over a rolling 4-hour window
- Graceful shutdown (SIGTERM → kill children → mark invocations as interrupted)
- `.env`-based configuration

## Capabilities

### New Capabilities

- `task-management`: SQLite-backed task storage with status lifecycle (ready → dispatched → running → done / failed), agent prompts, repo paths, and retry tracking
- `scheduler`: Concurrency-capped dispatch loop that picks highest-priority unblocked tasks, respects cost budgets, enforces timeouts, and handles retries
- `session-runner`: Spawns `claude` CLI processes in git worktrees, parses stream-json output, captures session metadata (ID, cost, turns), and manages process lifecycle
- `worktree-manager`: Creates per-invocation git worktrees as sibling directories, cleans up on success, preserves on failure for debugging
- `cli`: Command-line interface for adding tasks (`orca add`), starting the scheduler (`orca start`), and viewing status (`orca status`)
- `config`: Environment-based configuration for scheduler, Claude Code, and budget settings

### Modified Capabilities

(none — greenfield project)

## Impact

- **New project structure**: TypeScript with Hono, SQLite (better-sqlite3 or drizzle), and a CLI entry point
- **System dependencies**: Requires `claude` CLI installed and authenticated, `git` available on PATH
- **File system**: Creates git worktrees as sibling directories to configured repos, stores SQLite database and invocation logs locally
