# Orca — Product Design Document

## 1. System Overview

**Orca** is an AI agent scheduler that maximizes Claude Code token utilization by automatically dispatching work from an existing Linear workspace to local CC CLI sessions.

### Architecture

A single local application running on an always-on Windows machine. No cloud deployment.

**Stack:**
- **Backend:** Hono (TypeScript) — serves the API and static frontend
- **Frontend:** React + Vite SPA
- **Database:** SQLite (local file)
- **Scheduler:** In-process timer loop
- **Agent runtime:** Spawns `claude` CLI processes
- **Notifications:** Windows toast notifications for session completion/failure

### Flow

```
Linear workspace (source of truth for issues)
    ↓ API sync (poll)
Orca (local app on always-on Windows machine)
    ├── Hono server → serves UI at localhost:3000
    ├── Scheduler loop → picks tasks, respects token budget
    ├── Process spawner → runs `claude` CLI sessions
    ├── SQLite → tracks Orca-specific state
    └── Notifications → Windows toast on session complete/fail
```

### Scheduling

Spawn up to 3 sessions per hour to saturate the 4-hourly token allowance. The scheduler loop tracks the budget window and queues accordingly.

---

## 2. UI Layout

The UI has two main areas plus a persistent orchestrator bar.

### Task List (left side, default view)

Pulled from Linear via API, filtered to the configured Linear project/team. Each row shows:

- **Issue ID** (e.g. `ORC-12`)
- **Title**
- **Status badge** — maps to Orca's pipeline: Ready → Dispatched → Running → Done / Failed
- **Priority dot** — color-coded, matching Linear's urgency levels

### Task Detail Panel (right side, opens on click)

- **Title + status**
- **Agent Prompt** — Orca-specific text field (not stored in Linear). The prompt injected into the CC session. Stored in SQLite, keyed by Linear issue ID.
- **Dispatch history** — list of past invocations (timestamp, duration, outcome)
- **Latest session status** — running / completed / failed
- **Invoke button** — manually dispatch this task now, bypassing the scheduler

### Orchestrator Bar (persistent, always visible)

- **Cost budget gauge** — $X / $Y used in current 4hr window
- **Active sessions count** (e.g. "2 running")
- **Queued tasks count**

---

## 3. Data Model

Two data sources — Linear (read via API) and SQLite (Orca-specific state).

### From Linear (read-only, never duplicated)

- Issue ID, title, status, priority
- Filtered by project/team

### SQLite Tables

**`tasks`** — Maps Linear issues to Orca dispatch state:
- `linear_issue_id` (PK)
- `agent_prompt` (text — the prompt sent to CC)
- `repo_path` (text — absolute path to the git repo for this task, falls back to `ORCA_DEFAULT_CWD`)
- `orca_status` (enum: ready / dispatched / running / done / failed)
- `retry_count` (int — number of times this task has been retried)
- `created_at`, `updated_at`

**`invocations`** — One row per CC session spawned:
- `id` (PK)
- `linear_issue_id` (FK)
- `started_at`, `ended_at`
- `status` (running / completed / failed / timed_out)
- `session_id` (CC session identifier)
- `branch_name` (text — git branch created for this invocation)
- `worktree_path` (text — absolute path to the worktree directory)
- `cost_usd` (real — total cost from stream-json result message)
- `num_turns` (int — turn count from result message)
- `output_summary` (text — truncated result or error)
- `log_path` (text — path to the full stream-json log file for this invocation)

**`budget_events`** — Cost tracking per session:
- `id` (PK)
- `invocation_id` (FK)
- `cost_usd` (real — from stream-json result message)
- `recorded_at` (timestamp)

Budget is computed dynamically: sum `cost_usd` from `budget_events` in the rolling 4-hour window. No separate budget table needed — it's a query over invocation costs.

---

## 4. Scheduler Logic

The scheduler's job: keep N concurrent CC sessions running at all times, picking the highest-effective-priority unblocked task next.

### Concurrency Model

- Maintain a **concurrency cap** (configurable, default 3)
- When a session finishes or is killed, immediately backfill from the queue
- The scheduler loop runs on a short interval (e.g. every 10 seconds) checking for open slots

### Dispatch Algorithm

Each tick of the scheduler loop:

```
1. Count active sessions (status = running)
2. If active < concurrency_cap AND queue is non-empty:
   a. Fetch all tasks with orca_status = "ready"
   b. Fetch dependency graph from Linear (blockedBy relations)
   c. Filter out any task whose blockers aren't all "done"
   d. Compute effective priority:
      - Start with the task's own Linear priority
      - If this task blocks a higher-priority task, inherit that priority
      - Transitively: if A blocks B blocks C, and C is urgent, A and B are both urgent
   e. Sort by effective priority (urgent > high > medium > low > none),
      then by Linear creation date (oldest first) as tiebreaker
   f. Dispatch the top task:
      - Set orca_status = "dispatched"
      - Create an invocation record
      - Spawn `claude` CLI process with the agent prompt
      - Set orca_status = "running" once the process starts
3. Check running sessions for timeout:
   - If any session has been running longer than max_duration (configurable, default 45 min):
     kill the process, set invocation status = "timed_out", set orca_status = "failed"
```

### Priority Inheritance (detail)

The effective priority of a task is the maximum of:
- Its own Linear priority
- The Linear priority of any task it transitively blocks

Example: `ORC-5` (low) blocks `ORC-3` (urgent). `ORC-5`'s effective priority becomes urgent because completing it unblocks urgent work.

This is computed at dispatch time from the current dependency graph — no cached priority values to go stale.

### Session Lifecycle

Canonical status list (5 statuses):

```
ready → dispatched → running → done
                       ↓
                     failed
```

- **ready**: Task has an agent prompt and no unresolved blockers. Eligible for dispatch.
- **dispatched**: Picked by scheduler, CC process is being spawned.
- **running**: CC session is actively executing.
- **done**: Session completed successfully.
- **failed**: Session errored, timed out, or exhausted retries. The invocation record captures the specific failure reason (error / timed_out / max_turns).

There is no `waiting_input` state. Agent prompts must be self-sufficient — `--dangerously-skip-permissions` is used and Claude won't call `AskUserQuestion` in headless `-p` mode. If a session can't proceed without human input, it should fail and be retried with a better prompt.

### Budget Tracking

Budget is tracked by **cumulative cost**, not session count. The `stream-json` result message includes `total_cost_usd` for each session. Orca sums costs from all invocations in the rolling 4-hour window.

The scheduler checks `sum(cost_usd) < ORCA_BUDGET_MAX_COST_USD` before dispatching. If the budget is exhausted, it waits for the window to roll forward. The concurrency cap is the primary throughput control; the cost budget is a safety net against runaway spending.

### Failure Handling

When a session fails or times out:
- The invocation is marked with the failure reason
- The task's `orca_status` reverts to `ready` (eligible for re-dispatch)
- A configurable `max_retries` (default 3) prevents infinite retry loops — after max retries, status becomes `failed` permanently and requires manual intervention

---

## 5. Linear Integration

Linear is the source of truth for issues. Orca syncs bidirectionally: reads issues and dependencies, writes back status updates.

### Authentication

Linear API key stored in a local `.env` file. The API is GraphQL at `https://api.linear.app/graphql`.

### Sync Strategy: Webhooks via Cloudflared Tunnel

- **On startup:** Full fetch of issues from configured project(s) to populate local cache
- **Ongoing:** Linear webhooks push issue create/update/delete events to Orca's local server
- Orca exposes a webhook endpoint at `localhost:3000/api/webhooks/linear`
- A persistent **cloudflared tunnel** exposes this endpoint to the internet, giving Linear a stable public URL to POST to
- Webhook payloads are verified via HMAC-SHA256 signature using the webhook signing secret
- **Degraded mode:** If the tunnel goes down, Orca falls back to polling Linear every 30 seconds using `updatedAt` filter until the tunnel is restored

### Configuration

```
ORCA_LINEAR_API_KEY=lin_api_...
ORCA_LINEAR_PROJECT_IDS=["project-uuid-1", "project-uuid-2"]
ORCA_LINEAR_READY_STATE=Todo        # Linear state name that signals "ready for dispatch"
```

### Issue Filtering

Only issues belonging to configured `ORCA_LINEAR_PROJECT_IDS` are visible. Fetched with:

```graphql
issues(filter: {
  project: { id: { in: $projectIds } }
}, first: 25) {
  nodes {
    id, identifier, title, priority, priorityLabel
    state { id, name, type }
    relations { nodes { type, relatedIssue { id, identifier } } }
    inverseRelations { nodes { type, issue { id, identifier } } }
  }
}
```

Uses `first: 25` to keep query complexity low (rate limit: 250k complexity points/hr).

### Status Mapping (Linear ↔ Orca)

Orca maps Linear workflow states to its internal pipeline. The mapping is by `state.type` (not name, since names are customizable per team):

| Linear `state.type` | Orca status | Direction |
|---|---|---|
| `backlog` | (ignored) | — |
| `unstarted` (e.g. "Todo") | `ready` | Read: issue becomes eligible for dispatch |
| `started` (e.g. "In Progress") | `running` | Write: Orca sets this when dispatching |
| `completed` (e.g. "Done") | `done` | Write: Orca sets this when session completes |
| `canceled` | `failed` | Write: Orca sets this on permanent failure |

The configurable `ORCA_LINEAR_READY_STATE` lets you specify which state name triggers readiness. Default mapping uses `state.type = "unstarted"`.

### Write-back

When Orca transitions a task, it updates the Linear issue's state:

| Orca transition | Linear update |
|---|---|
| ready → dispatched | Move to "In Progress" (`started` type state) |
| running → done | Move to "Done" (`completed` type state) |
| running → failed (permanent) | Move to "Canceled" (`canceled` type state) |
| failed → ready (retry) | Move back to "Todo" (`unstarted` type state) |

Write-back uses `issueUpdate(id, input: { stateId })`. Orca caches the team's workflow state IDs on startup so it can map state types to UUIDs.

### Conflict Resolution

**Linear wins.** If a Linear webhook arrives with a status change that contradicts Orca's internal state (e.g. you manually move a running issue back to "Todo"), Orca defers to Linear:

- If Orca thinks a task is `running` but Linear says `unstarted`: kill the running session, mark the invocation as interrupted, reset `orca_status` to `ready`.
- If Orca thinks a task is `ready` but Linear says `completed`: set `orca_status` to `done`, skip dispatch.
- If Orca thinks a task is `done` but Linear says `unstarted`: reset `orca_status` to `ready` (re-dispatch eligible).

This keeps Linear as the unambiguous source of truth. Any manual status change in Linear is an intentional override.

### Dependency Graph

To resolve blockers, Orca queries both `relations` and `inverseRelations` on each issue:

- `relations` where `type = "blocks"` → this issue blocks the `relatedIssue`
- `inverseRelations` where `type = "blocks"` → this issue IS blocked by the source `issue`

A task is dispatchable only when ALL of its blockers (from `inverseRelations`) have `state.type = "completed"`.

### Priority Values

Linear priorities are numeric (lower = more urgent):

| Value | Label | Note |
|---|---|---|
| 0 | No priority | Treated as lowest |
| 1 | Urgent | |
| 2 | High | |
| 3 | Normal | UI shows "Medium" |
| 4 | Low | |

Scheduler sorts ascending: priority 1 dispatches before priority 4.

### Rate Limit Safety

- 5,000 requests/hr, 250k complexity points/hr
- Use `first: 25` on all paginated queries
- Cache issue data locally; only re-fetch on webhook events or poll intervals
- Monitor `X-RateLimit-Requests-Remaining` header

---

## 6. Claude Code Integration

Orca spawns `claude` CLI processes to execute tasks. This uses your **Pro/Max subscription allowance** — no API costs.

### Spawning Sessions

Each dispatch spawns a child process via Node.js `child_process.spawn`:

```bash
claude -p "<agent_prompt>" \
  --output-format stream-json \
  --max-turns 20 \
  --cwd /path/to/project
```

Key flags:
- `-p` (print mode) — non-interactive, runs the prompt and exits
- `--output-format stream-json` — emits newline-delimited JSON messages to stdout, giving Orca structured visibility into what the agent is doing
- `--max-turns` — caps session length (configurable per task, default 20)
- `--cwd` — sets the working directory for the agent (the target repo)

### Monitoring Sessions

Orca reads the `stream-json` stdout line by line. Each line is a structured `SDKMessage` with a `type` field:

- `type: "system"`, `subtype: "init"` — session started, contains `session_id` (stored in the invocation record for potential resume)
- `type: "assistant"` — agent is working (tool calls, text output)
- `type: "result"`, `subtype: "success"` — session completed successfully
- `type: "result"`, `subtype: "error_max_turns"` — hit turn limit
- `type: "result"`, `subtype: "error_during_execution"` — session crashed

On `result`, Orca captures `total_cost_usd` and `num_turns` from the message and stores them on the invocation record.

### No Mid-Session Human Input

`--permission-prompt-tool` only handles tool permission prompts, **not** `AskUserQuestion` calls. Programmatic `AskUserQuestion` handling requires the Agent SDK, which uses API billing (not subscription allowance).

Therefore: **agent prompts must be self-sufficient.** Sessions run fully autonomously with `--dangerously-skip-permissions`. If Claude can't complete the task without asking a question, the session should fail. The fix is to write a better, more specific agent prompt and retry.

This is a design constraint, not a limitation — it pushes prompt quality up. The agent prompt in Orca should contain all the context Claude needs: what to do, how to do it, which files to touch, what patterns to follow.

### Working Directory

Each task in Orca can be associated with a target repository path. The agent prompt should include context about what repo to work in, and `--cwd` points the CLI there.

For tasks across multiple repos, the agent prompt itself should instruct the agent which directories to work in (the agent can use `--add-dir` equivalent tools internally).

### Session Persistence & Resume

Orca stores the `session_id` from the init message on each invocation. If a task fails and is retried, Orca can choose to:
- **Fresh start:** Spawn a new session (default for failures)
- **Resume:** Use `-r <session_id>` to continue where it left off (useful for tasks that partially completed)

The retry strategy is configurable per task.

### Tool Permissions

By default, Orca runs sessions with `--dangerously-skip-permissions` to avoid interactive permission prompts blocking headless execution. This is acceptable because:
- The agent is working on your code, on your machine
- Tasks are defined by you in Linear
- The agent prompt controls scope

For more restrictive setups, Orca can pass `--allowedTools` and `--disallowedTools` to limit what the agent can do:

```bash
claude -p "<prompt>" \
  --dangerously-skip-permissions \
  --disallowedTools "Bash(rm -rf *)"
```

### System Prompt / CLAUDE.md

The CLI automatically loads CLAUDE.md from the `--cwd` project directory. Orca can optionally append to the system prompt:

```bash
claude -p "<prompt>" \
  --append-system-prompt "You are working on behalf of Orca orchestrator. Report progress clearly."
```

### Process Lifecycle

```
Orca spawns claude process
    ↓
Reads stream-json from stdout, tees to log file
    ↓ init message → store session_id
    ↓ assistant messages → update UI with progress
    ↓ result message → store outcome, cost, turns
    ↓
Process exits
    ↓
Orca updates invocation record + task status
Orca updates Linear issue state
Scheduler checks for next dispatch
```

---

## 7. Git Worktree Isolation

Every invocation runs in its own git worktree. This is mandatory — without it, concurrent sessions working on the same repo would stomp on each other's changes.

### Worktree Creation

When the scheduler dispatches a task, before spawning the `claude` process:

1. Fetch latest from remote: `git -C <repo_path> fetch origin`
2. Generate a branch name: `orca/<linear_issue_id>-<invocation_id>` (e.g. `orca/ORC-12-inv-7`)
3. Create the worktree as a sibling directory: `git -C <repo_path> worktree add ../<repo_name>-<linear_issue_id> -b <branch_name> origin/main`
4. Copy `.env*` files from the base repo (if they exist)
5. Run `npm install` (or equivalent) if a `package.json` is present
6. Pass the worktree path as `--cwd` to the `claude` CLI

**Naming convention:** For a repo at `/home/user/projects/myapp` and issue `ORC-12`:
- Worktree path: `/home/user/projects/myapp-ORC-12`
- Branch: `orca/ORC-12-inv-7`

If the worktree already exists (retry of the same task), reuse it and reset to `origin/main` before starting.

### Worktree Cleanup

- **On success:** Remove the worktree (`git worktree remove <path>`) immediately. The branch remains in the repo for PR creation or merging.
- **On failure:** Keep the worktree intact for debugging. The user can inspect the state, fix issues manually, or let Orca retry.
- **Manual cleanup:** Orca CLI command `orca cleanup` removes all worktrees for completed/failed tasks older than a configurable age.

### Concurrent Session Safety

With worktree isolation, the concurrency cap is the only limit on parallel sessions per repo. Each session works on independent files in an independent directory — no locking, no conflicts.

If two tasks need to modify the same files, model that as a dependency in Linear (one blocks the other). The scheduler won't dispatch the blocked task until the blocker is done.

---

## 8. Configuration

All configuration lives in a `.env` file in the Orca project root.

### Linear

| Variable | Description | Default |
|---|---|---|
| `ORCA_LINEAR_API_KEY` | Linear API key (`lin_api_...`) | required |
| `ORCA_LINEAR_WEBHOOK_SECRET` | Signing secret for webhook verification | required |
| `ORCA_LINEAR_PROJECT_IDS` | JSON array of Linear project UUIDs to sync | required |
| `ORCA_LINEAR_READY_STATE_TYPE` | Linear `state.type` that signals readiness | `"unstarted"` |

### Scheduler

| Variable | Description | Default |
|---|---|---|
| `ORCA_CONCURRENCY_CAP` | Max concurrent CC sessions | `3` |
| `ORCA_SESSION_TIMEOUT_MIN` | Hard timeout per session (minutes) | `45` |
| `ORCA_MAX_RETRIES` | Max retry attempts before permanent failure | `3` |
| `ORCA_BUDGET_WINDOW_HOURS` | Rolling budget window duration | `4` |
| `ORCA_BUDGET_MAX_COST_USD` | Max cumulative cost per budget window | `10.00` |
| `ORCA_SCHEDULER_INTERVAL_SEC` | How often the scheduler loop ticks | `10` |

### Claude Code

| Variable | Description | Default |
|---|---|---|
| `ORCA_CLAUDE_PATH` | Path to `claude` CLI binary | `"claude"` (on PATH) |
| `ORCA_DEFAULT_MAX_TURNS` | Default max turns per session | `20` |
| `ORCA_DEFAULT_CWD` | Default working directory for sessions | required |
| `ORCA_APPEND_SYSTEM_PROMPT` | Text appended to every session's system prompt | `""` |
| `ORCA_DISALLOWED_TOOLS` | Comma-separated list of blocked tools | `""` |

### Server

| Variable | Description | Default |
|---|---|---|
| `ORCA_PORT` | Local server port | `3000` |
| `ORCA_DB_PATH` | Path to SQLite database file | `./orca.db` |

### Tunnel

| Variable | Description | Default |
|---|---|---|
| `ORCA_TUNNEL_HOSTNAME` | Cloudflared tunnel public hostname | required |

---

## 9. MVP Scope

Build the minimum viable orchestrator in three phases. Each phase is independently useful.

### Phase 1: Core Loop (the engine)

Get the scheduler dispatching CC sessions from a local task queue. No Linear, no UI yet.

- SQLite database with `tasks`, `invocations` tables
- CLI to add tasks manually: `orca add --prompt "Fix the auth bug" --repo /path/to/repo`
- Scheduler loop: concurrency cap, timeout, retry logic
- Git worktree creation/cleanup per invocation
- Spawn `claude -p` with `--output-format stream-json` in the worktree
- Parse stream output, capture session ID, detect completion/failure
- Console logging of session status
- `.env` configuration
- Graceful shutdown: SIGTERM → kill child processes → mark invocations as interrupted

**What this proves:** Orca can spawn and manage CC sessions autonomously.

### Phase 2: Linear Integration

Connect the engine to Linear as the task source.

- Linear API client: fetch issues by project, read priorities, read dependencies
- Webhook endpoint + cloudflared tunnel for real-time sync
- Polling fallback
- Status write-back (dispatched → in progress → done/failed)
- Priority inheritance from dependency graph
- Dependency-aware dispatch filtering
- Agent prompt stored in SQLite, keyed by Linear issue ID
- CLI to set agent prompts: `orca prompt ORC-12 "Fix the login redirect bug"`

**What this proves:** You can manage work in Linear and Orca dispatches it automatically.

### Phase 3: UI + Notifications

The operational dashboard.

- Hono server serving React/Vite SPA at `localhost:3000`
- Task list view (Linear issues: ID, title, status, priority)
- Task detail panel (agent prompt editor, dispatch history, session status, log viewer)
- Orchestrator bar (cost budget gauge, active sessions, queue count)
- Windows desktop notifications on session completion/failure

**What this proves:** Full operational visibility and prompt management.

### Out of Scope (for now)

- Multi-user / auth (single user, local machine)
- PR tracking / GitHub integration
- Cost analytics dashboard
- Multiple concurrent projects with independent budgets
- Agent-to-agent communication
- Custom MCP tools for agent self-service
