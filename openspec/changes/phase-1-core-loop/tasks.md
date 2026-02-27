## 1. Project Setup

- [ ] 1.1 Initialize Node.js project with `package.json`, TypeScript config, and `.gitignore`
- [ ] 1.2 Install dependencies: `hono`, `better-sqlite3`, `drizzle-orm`, `drizzle-kit`, `commander`, `dotenv`, `tsx`, `tsup`, `@types/better-sqlite3`, `typescript`
- [ ] 1.3 Create `src/` directory structure: `cli/`, `scheduler/`, `runner/`, `worktree/`, `db/`, `config/`
- [ ] 1.4 Create `.env.example` with all config variables and defaults documented

## 2. Configuration

- [ ] 2.1 Implement `src/config/index.ts` — load `.env`, validate required vars (`ORCA_DEFAULT_CWD`), apply defaults, type-validate all values
- [ ] 2.2 Export typed config object with all `ORCA_*` variables

## 3. Database

- [ ] 3.1 Define Drizzle schema in `src/db/schema.ts` — `tasks`, `invocations`, `budget_events` tables
- [ ] 3.2 Implement `src/db/index.ts` — create SQLite connection, run migrations, export db instance
- [ ] 3.3 Implement `src/db/queries.ts` — typed query functions: insert/update task, insert/update invocation, insert budget event, get ready tasks sorted by priority, count active sessions, sum cost in budget window

## 4. Worktree Manager

- [ ] 4.1 Implement `src/worktree/index.ts` — `createWorktree(repoPath, taskId, invocationId)`: fetch origin, create branch, create worktree, copy .env files, run npm install if applicable
- [ ] 4.2 Implement `removeWorktree(worktreePath)` — run `git worktree remove`
- [ ] 4.3 Implement `resetWorktree(worktreePath)` — reset to origin/main for retry scenarios
- [ ] 4.4 Handle edge cases: existing worktree, existing branch, missing repo path

## 5. Session Runner

- [ ] 5.1 Implement `src/runner/index.ts` — `spawnSession(invocationId, prompt, worktreePath, config)`: spawn `claude` process with correct flags, return a session handle
- [ ] 5.2 Implement stream-json line parser: extract init message (session_id), assistant messages, result messages (subtype, cost, turns)
- [ ] 5.3 Implement log tee: write every stdout line to `logs/<invocation-id>.ndjson`
- [ ] 5.4 Implement process exit handler: update invocation record with ended_at, status, cost, turns
- [ ] 5.5 Implement `killSession(sessionHandle)` — SIGTERM then SIGKILL after 5s

## 6. Scheduler

- [ ] 6.1 Implement `src/scheduler/index.ts` — scheduler loop with `setInterval`, tick function, mutex guard against overlapping ticks
- [ ] 6.2 Implement tick logic: count active sessions, check budget, pick highest-priority ready task, dispatch
- [ ] 6.3 Implement dispatch flow: create invocation record → create worktree → spawn session → update task status
- [ ] 6.4 Implement timeout check: scan running invocations, kill any exceeding `ORCA_SESSION_TIMEOUT_MIN`
- [ ] 6.5 Implement retry logic: on failure, check retry_count vs max_retries, reset to ready or leave as failed
- [ ] 6.6 Implement session completion handler: update invocation + task status, record budget event, trigger worktree cleanup, log outcome

## 7. CLI

- [ ] 7.1 Implement `src/cli/index.ts` — Commander.js program with `orca` as the binary name
- [ ] 7.2 Implement `orca add` command — `--prompt`, `--repo`, `--priority`, `--id` flags, inserts task into DB
- [ ] 7.3 Implement `orca start` command — initializes DB, starts scheduler loop, logs to console
- [ ] 7.4 Implement `orca status` command — queries DB, displays active sessions, queue, budget, failures
- [ ] 7.5 Add `bin` entry in `package.json` pointing to CLI entry point

## 8. Graceful Shutdown

- [ ] 8.1 Implement SIGTERM/SIGINT handler in `orca start`: stop scheduler loop, kill all running child processes, mark invocations as interrupted, exit cleanly
- [ ] 8.2 Ensure log files are flushed before exit

## 9. Integration Testing

- [ ] 9.1 Write test that adds a task via CLI and verifies it appears in the DB
- [ ] 9.2 Write test that starts the scheduler with a mock `claude` command (a script that outputs stream-json), verifies dispatch → running → done lifecycle
- [ ] 9.3 Write test that verifies timeout enforcement kills the process and marks invocation as timed_out
- [ ] 9.4 Write test that verifies retry logic resets task to ready and increments retry_count
- [ ] 9.5 Write test that verifies budget enforcement blocks dispatch when cost exceeds limit
