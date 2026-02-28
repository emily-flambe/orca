# Ticket Lifecycle

End-to-end flow from Linear issue creation to merged PR with automated review.

## 1. Issue enters Orca

A Linear issue in a tracked project reaches Orca one of two ways:

- **Webhook (primary):** Linear sends a POST to `/api/webhooks/linear`. Orca verifies the HMAC-SHA256 signature, checks the issue belongs to a tracked project, and calls `processWebhookEvent` → `upsertTask`.
- **Polling (fallback):** When the cloudflared tunnel is down, a poller runs `fullSync` every 30s via the Linear GraphQL API, upserting all issues from tracked projects.

`upsertTask` maps the Linear state name to an Orca status:

| Linear State | Orca Status |
|---|---|
| Todo | `ready` |
| In Progress | `running` |
| In Review | `in_review` |
| Done | `done` |
| Canceled | `failed` |
| Backlog | *(skipped)* |

The agent prompt is built from `{title}\n\n{description}`. If the issue has no description, the prompt is just the title.

**Result:** A row exists in the `tasks` table with `orca_status = 'ready'`.

## 2. Scheduler picks up the task

The scheduler ticks every 10s (`ORCA_SCHEDULER_INTERVAL_SEC`). Each tick:

1. **Concurrency check** — if active sessions >= `ORCA_CONCURRENCY_CAP` (default 3), skip.
2. **Budget check** — if rolling cost in the last `ORCA_BUDGET_WINDOW_HOURS` (4h) >= `ORCA_BUDGET_MAX_COST_USD` ($1000), skip.
3. **Get dispatchable tasks** — query all tasks with `orca_status` in (`ready`, `in_review`, `changes_requested`).
4. **Filter** — exclude tasks with empty `agent_prompt`, and tasks blocked by the dependency graph (for `ready` tasks only; `in_review` and `changes_requested` skip dependency checks).
5. **Sort** — prioritize review/fix phases over new implementations, then by effective priority (ascending), tiebreak by `created_at`.
6. **Dispatch the top task** with the appropriate phase.

## 3. Dispatch (Implementation Phase)

For tasks in `ready` status, dispatch with phase `"implement"`:

1. Set task status to `dispatched`.
2. **Write-back to Linear:** move issue to **"In Progress"** (fire-and-forget).
3. Insert an `invocations` row with status `running` and `phase = 'implement'`.
4. **Create git worktree:**
   - `git fetch origin` in the base repo.
   - Create branch `orca/<taskId>-inv-<invocationId>` from `origin/main`.
   - Create worktree as sibling directory: `<repoDir>-<taskId>`.
   - Copy `.env*` files from the base repo.
   - Run `npm install` if `package.json` exists.
5. **Spawn Claude Code CLI** with `ORCA_APPEND_SYSTEM_PROMPT`.
6. Set task status to `running`.
7. Store the session handle and attach a completion callback.

**Result:** A Claude Code agent is working in an isolated worktree. Linear shows "In Progress".

## 4. Implementation completes

### 4a. Success

1. Update invocation: status `completed`, record cost/turns/summary.
2. **Verify PR exists** via `gh pr list --head <branch>`.
3. If no PR → treat as failure (triggers retry).
4. If PR exists → store `prBranchName` on task, set status to `in_review`.
5. **Write-back to Linear:** move issue to **"In Review"**.
6. Remove the git worktree.

**Result:** A PR exists on GitHub. Linear shows "In Review". Task enters review phase.

### 4b. Failure

1. Update invocation: status `failed`, record details.
2. Set task to `failed`.
3. Remove the git worktree.
4. **Retry logic** (see section 8).

## 5. Dispatch (Review Phase)

For tasks in `in_review` status, dispatch with phase `"review"`:

1. Set task status to `dispatched`.
2. **No write-back** (already "In Review" in Linear).
3. Insert an `invocations` row with `phase = 'review'`.
4. **Create git worktree** based on the PR branch (`origin/<prBranchName>`).
5. **Spawn Claude Code CLI** with `ORCA_REVIEW_SYSTEM_PROMPT`.
6. Set task status to `running`.

The review agent:
1. Reads the full diff: `git diff origin/main...HEAD`
2. Reviews for correctness, bugs, and security issues
3. Runs tests if available
4. Decides: approve and merge, or request changes

## 6. Review completes

### 6a. Approved

The review agent outputs `REVIEW_RESULT:APPROVED` and merges the PR.

1. Set task to `done`.
2. **Write-back to Linear:** move issue to **"Done"**.
3. Remove the git worktree.

**Result:** PR is merged. Linear shows "Done". Task is complete.

### 6b. Changes requested

The review agent outputs `REVIEW_RESULT:CHANGES_REQUESTED`.

1. Check `reviewCycleCount < ORCA_MAX_REVIEW_CYCLES` (default 3).
2. If under limit: increment cycle count, set task to `changes_requested`.
3. **Write-back to Linear:** move issue to **"In Progress"**.
4. Remove the git worktree.

**Result:** Task enters fix phase.

### 6c. Review cycles exhausted

If `reviewCycleCount >= ORCA_MAX_REVIEW_CYCLES`:

1. Leave task as `in_review` for human intervention.
2. Log a warning.

### 6d. No review marker

If the review agent doesn't output a `REVIEW_RESULT:*` marker:

1. Leave task as `in_review` (will be re-dispatched for another review attempt).

## 7. Dispatch (Fix Phase)

For tasks in `changes_requested` status, dispatch with phase `"implement"` on the existing PR branch:

1. Set task status to `dispatched`.
2. **Write-back to Linear:** move issue to **"In Progress"**.
3. Insert an `invocations` row with `phase = 'implement'`.
4. **Create git worktree** based on the PR branch (`origin/<prBranchName>`).
5. **Spawn Claude Code CLI** with `ORCA_FIX_SYSTEM_PROMPT`.
6. Set task status to `running`.

The fix agent reads review comments and makes corrections on the existing branch.

When the fix completes successfully, the task returns to `in_review` (step 4a) and the review cycle repeats.

## 8. Retry logic

If `retry_count < ORCA_MAX_RETRIES` (default 3):

1. Increment retry count, set task back to `ready`.
2. **Write-back to Linear:** move issue back to **"Todo"**.
3. The scheduler will pick it up again on a future tick (fresh worktree from `origin/main`).

If retries exhausted:

1. Task stays `failed`.
2. **Write-back to Linear:** move issue to **"Canceled"**.

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
              │   In Progress ◄──────────── running [implement]           │
              │                                  │                        │
              │                          agent completes                  │
              │                            /          \                   │
              │                        success      failure              │
              │                       (PR exists)      │                  │
              │                          │           retry?               │
              │                          ▼                                │
              │                      in_review ◄─────────────────── PR exists
              │                          │
              │                  write-back "In Review"
              │                          │
              │                          ▼
              │                  dispatched [review]
              │                          │
              │                          ▼
              │                  running [review]
              │                    /           \
              │                approved    changes requested
              │                  │              │
              │                  ▼              ▼
              │   Done ◄─── done         changes_requested
              │              │                  │
              │      write-back "Done"   write-back "In Progress"
              │        PR merged                │
              │                                 ▼
              │                         dispatched [fix]
              │                                 │
              │                                 ▼
              │                         running [implement/fix]
              │                                 │
              └──── In Progress ◄───── write-back "In Progress"
                                                │
                                         agent completes
                                                │
                                         back to in_review ───►
```

## Linear state transitions (automated)

```
Todo → In Progress (implement dispatched)
     → In Review (implementation done, PR exists)
     → In Progress (changes requested, fix dispatched)
     → In Review (fix done)
     → Done (reviewer approved + merged)
```

## Key files

| File | Role |
|---|---|
| `src/linear/webhook.ts` | HMAC verification, webhook HTTP endpoint |
| `src/linear/sync.ts` | State mapping, upsert, write-back, conflict resolution |
| `src/linear/poller.ts` | Fallback polling when tunnel is down |
| `src/linear/client.ts` | GraphQL API client, WorkflowStateMap |
| `src/scheduler/index.ts` | Multi-phase dispatch loop, session lifecycle, retry logic |
| `src/runner/index.ts` | Spawns/kills Claude CLI child processes |
| `src/worktree/index.ts` | Git worktree create/remove (supports baseRef for review/fix) |
| `src/github/index.ts` | PR verification via `gh` CLI |
| `src/config/index.ts` | Env var loading |

## Configuration

| Env Var | Default | Description |
|---|---|---|
| `ORCA_REVIEW_SYSTEM_PROMPT` | (built-in) | System prompt for review agents |
| `ORCA_FIX_SYSTEM_PROMPT` | (built-in) | System prompt for fix agents |
| `ORCA_MAX_REVIEW_CYCLES` | 3 | Max review-fix cycles before human intervention |
| `ORCA_REVIEW_MAX_TURNS` | 30 | Max turns for review agent sessions |

## Known gaps

- **Deploy is manual.** After a PR is merged, someone must run `scripts/deploy.sh` or manually rebuild + restart.
- **Review agent must output marker.** If the review agent fails to output `REVIEW_RESULT:APPROVED` or `REVIEW_RESULT:CHANGES_REQUESTED`, the review will be retried.
