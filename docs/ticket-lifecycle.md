# Ticket Lifecycle

End-to-end flow from Linear issue creation to merged PR.

## 1. Issue enters Orca

A Linear issue in a tracked project reaches Orca one of two ways:

- **Webhook (primary):** Linear sends a POST to `/api/webhooks/linear`. Orca verifies the HMAC-SHA256 signature, checks the issue belongs to a tracked project, and calls `processWebhookEvent` → `upsertTask`.
- **Polling (fallback):** When the cloudflared tunnel is down, a poller runs `fullSync` every 30s via the Linear GraphQL API, upserting all issues from tracked projects.

`upsertTask` maps the Linear state name to an Orca status:

| Linear State | Orca Status |
|---|---|
| Todo | `ready` |
| In Progress | `running` |
| In Review | `done` |
| Done | `done` |
| Canceled | `failed` |
| Backlog | *(skipped)* |

The agent prompt is built from `{title}\n\n{description}`. If the issue has no description, the prompt is just the title.

**Result:** A row exists in the `tasks` table with `orca_status = 'ready'`.

## 2. Scheduler picks up the task

The scheduler ticks every 10s (`ORCA_SCHEDULER_INTERVAL_SEC`). Each tick:

1. **Concurrency check** — if active sessions >= `ORCA_CONCURRENCY_CAP` (default 3), skip.
2. **Budget check** — if rolling cost in the last `ORCA_BUDGET_WINDOW_HOURS` (4h) >= `ORCA_BUDGET_MAX_COST_USD` ($1000), skip.
3. **Get ready tasks** — query all tasks with `orca_status = 'ready'`.
4. **Filter** — exclude tasks with empty `agent_prompt`, and tasks blocked by the dependency graph (Linear "blocks" relations).
5. **Sort** — by effective priority (ascending, inheriting urgency from downstream blocked tasks), tiebreak by `created_at`.
6. **Dispatch the top task.**

## 3. Dispatch

`dispatch()` in `src/scheduler/index.ts`:

1. Set task status to `dispatched`.
2. **Write-back to Linear:** move issue to **"In Progress"** (fire-and-forget).
3. Insert an `invocations` row with status `running`.
4. **Create git worktree:**
   - `git fetch origin` in the base repo.
   - Create branch `orca/<taskId>-inv-<invocationId>` from `origin/main`.
   - Create worktree as sibling directory: `<repoDir>-<taskId>`.
   - Copy `.env*` files from the base repo.
   - Run `npm install` if `package.json` exists.
5. **Spawn Claude Code CLI:**
   ```
   claude -p "<prompt>" \
     --output-format stream-json \
     --verbose \
     --max-turns <ORCA_DEFAULT_MAX_TURNS> \
     --dangerously-skip-permissions \
     --append-system-prompt "<ORCA_APPEND_SYSTEM_PROMPT>"
   ```
   The CWD is the worktree directory.
6. Set task status to `running`.
7. Store the session handle and attach a completion callback.

**Result:** A Claude Code agent is working in an isolated worktree. Linear shows "In Progress".

## 4. Agent executes

The agent runs autonomously with `--dangerously-skip-permissions`. It reads the prompt (issue title + description) and does the work.

If `ORCA_APPEND_SYSTEM_PROMPT` is configured (recommended), the agent is instructed to:

1. Commit all changes on the worktree branch.
2. Push the branch: `git push -u origin HEAD`.
3. Open a PR: `gh pr create --fill`.
4. **Not merge** — leave for human review.

All stdout (stream-json) is tee'd to `logs/<invocationId>.ndjson`.

### Timeout

If the session exceeds `ORCA_SESSION_TIMEOUT_MIN` (default 45 min), the scheduler kills it (SIGTERM, then SIGKILL after 5s). The invocation is marked `timed_out` and retry logic runs.

## 5. Session completes

`onSessionComplete()` fires when the Claude process exits.

### 5a. Success (`result.subtype === "success"`)

1. Update invocation: status `completed`, record cost/turns/summary.
2. Insert budget event if cost > 0.
3. Set task to `done`.
4. **Write-back to Linear:** move issue to **"In Review"** (not "Done" — PR still needs human review).
5. Remove the git worktree.

**Result:** A PR exists on GitHub. Linear shows "In Review". Orca considers the task done.

### 5b. Failure (`result.subtype !== "success"`)

1. Update invocation: status `failed`, record details.
2. Insert budget event if cost > 0.
3. Set task to `failed`.
4. Remove the git worktree.
5. **Retry logic** (see below).

## 6. Retry logic

If `retry_count < ORCA_MAX_RETRIES` (default 3):

1. Increment retry count, set task back to `ready`.
2. **Write-back to Linear:** move issue back to **"Todo"**.
3. The scheduler will pick it up again on a future tick (fresh worktree from `origin/main`).

If retries exhausted:

1. Task stays `failed`.
2. **Write-back to Linear:** move issue to **"Canceled"**.

## 7. Human review

This part is manual:

1. **Review the PR** on GitHub that the agent opened.
2. **Merge or request changes.** If changes needed, move the Linear issue back to "Todo" — Orca will detect the state change via webhook and reset the task to `ready` for re-dispatch.
3. **After merging:** run `scripts/deploy.sh` to pull, rebuild the frontend, and restart Orca. Or do it manually.
4. **Move the Linear issue to "Done"** (manual). Orca does not do this automatically because the deploy step is human-controlled.

## State diagram

```
                    Linear                              Orca                              GitHub
                    ──────                              ────                              ──────

              ┌──── Todo ◄──────────────────── write-back "Todo" ◄──── retry
              │       │                                                   │
              │       │ webhook/sync                                      │
              │       ▼                                                   │
              │   ready ──── scheduler ────► dispatched                   │
              │                                  │                        │
              │                          write-back "In Progress"         │
              │                                  │                        │
              │                                  ▼                        │
              │   In Progress ◄──────────── running                      │
              │                                  │                        │
              │                          agent completes                  │
              │                            /          \                   │
              │                        success      failure              │
              │                          │              │                 │
              │                          ▼              ▼                 │
              │                        done          failed ─────► retry?
              │                          │              │
              │                  write-back         if exhausted:
              │                  "In Review"        write-back "Canceled"
              │                          │
              │                          ▼
              │   In Review ◄──────── (PR open) ──────────────────► PR exists
              │                                                        │
              │                                                   human merges
              │                                                        │
              └──────────────────────────────────────────────────► human moves
                                                                  to "Done"
```

## Key files

| File | Role |
|---|---|
| `src/linear/webhook.ts` | HMAC verification, webhook HTTP endpoint |
| `src/linear/sync.ts` | State mapping, upsert, write-back, conflict resolution |
| `src/linear/poller.ts` | Fallback polling when tunnel is down |
| `src/linear/client.ts` | GraphQL API client, WorkflowStateMap |
| `src/scheduler/index.ts` | Dispatch loop, session lifecycle, retry logic |
| `src/runner/index.ts` | Spawns/kills Claude CLI child processes |
| `src/worktree/index.ts` | Git worktree create/remove |
| `src/config/index.ts` | Env var loading |

## Known gaps

- **No verification that the agent actually opened a PR.** The `ORCA_APPEND_SYSTEM_PROMPT` instructs it to, but if it doesn't (e.g. nothing to commit, or `gh` isn't authenticated), Orca still marks the task as done.
- **Deploy is manual.** After merging a PR, someone must run `scripts/deploy.sh` or manually rebuild + restart.
- **"Done" is manual.** Orca writes "In Review" on success, but the final move to "Done" in Linear is a human step after merge/deploy.
- **No conflict resolution for "In Review".** If someone manually moves an issue to "In Review" while it's running, `mapLinearStateToOrcaStatus` maps it to `done`, which could prematurely mark the task as done in Orca.
