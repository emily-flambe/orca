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
| Canceled | *(deleted from DB)* |
| Backlog | `backlog` |

The agent prompt is built from `{title}\n\n{description}`. If the issue is a child of a parent issue, the prompt is prefixed with the parent's title and description under a `## Parent Issue` header.

**Parent/child detection:** The GraphQL query fetches `parent` and `children` fields. Issues with children get `is_parent = 1` in the DB. Child issues store their parent's identifier in `parent_identifier`.

**Result:** A row exists in the `tasks` table with `orca_status = 'ready'`.

## 1b. Parent/child issue handling

When a Linear issue has sub-issues:

- **Parent issue** (`is_parent = 1`): Tracked in the DB but **never dispatched**. Its status is derived from its children.
- **Child issue** (`parent_identifier` set): Dispatched normally. Its agent prompt includes parent context under a `## Parent Issue` header.

**Parent status rollup** (`evaluateParentStatuses`):
- Runs after `fullSync`, after webhook processing of child tasks, and after task completion/deploy success.
- If any child is in an active state (`dispatched`, `running`, `in_review`, `changes_requested`, `deploying`) and the parent is `ready` → parent transitions to `running`, Linear write-back to "In Progress".
- If all children are `done` and the parent is not `done` → parent transitions to `done`, Linear write-back to "Done".

| Scenario | Behavior |
|---|---|
| Parent with no children | `is_parent = 0`, dispatched normally |
| Last child removed from parent | Next `fullSync` sets `is_parent = 0`, parent becomes dispatchable |
| Parent manually set to "Todo" in Linear | Conflict resolution resets to `ready`, but `is_parent = 1` prevents dispatch. Next child activity re-triggers "In Progress". |

## 2. Scheduler picks up the task

The scheduler ticks every 10s (`ORCA_SCHEDULER_INTERVAL_SEC`). Each tick:

1. **Timeout check** — kill timed-out invocations, mark failed, attempt retry.
2. **Deploy check** — poll GitHub Actions for tasks in `deploying` status (throttled by `ORCA_DEPLOY_POLL_INTERVAL_SEC`).
3. **Cleanup** — periodically (every `ORCA_CLEANUP_INTERVAL_MIN`) remove stale `orca/*` branches and orphaned worktrees. Branches are protected if they have running invocations, active tasks, open PRs, or are younger than `ORCA_CLEANUP_BRANCH_MAX_AGE_MIN`. Worktrees preserved for session resume are also protected.
4. **Concurrency check** — if active sessions >= `ORCA_CONCURRENCY_CAP` (default 3), skip.
5. **Budget check** — if rolling cost in the last `ORCA_BUDGET_WINDOW_HOURS` (4h) >= `ORCA_BUDGET_MAX_COST_USD` ($1000), skip.
6. **Get dispatchable tasks** — query all tasks with `orca_status` in (`ready`, `in_review`, `changes_requested`).
7. **Filter** — exclude tasks with empty `agent_prompt`, parent issues (`is_parent = 1`), tasks with running invocations, and tasks blocked by the dependency graph (for `ready` tasks only; `in_review` and `changes_requested` skip dependency checks).
8. **Sort** — prioritize review/fix phases over new implementations, then by effective priority (ascending), tiebreak by `created_at`.
9. **Dispatch the top task** with the appropriate phase.

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

1. Remove the git worktree.
2. Look up the PR number and merge commit SHA.
3. If `ORCA_DEPLOY_STRATEGY=none` (default): set task to `done`, write-back **"Done"** to Linear. Task is complete.
4. If `ORCA_DEPLOY_STRATEGY=github_actions`: store `mergeCommitSha`, `prNumber`, `deployStartedAt` on the task, set status to `deploying`. Linear stays at "In Review" (no write-back).

**Result (none):** PR is merged. Linear shows "Done". Task is complete.
**Result (github_actions):** PR is merged. Task enters deploy monitoring phase.

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

## 6e. Deploy monitoring (`ORCA_DEPLOY_STRATEGY=github_actions`)

When a task is in `deploying` status, the scheduler polls GitHub Actions on each tick:

1. **Throttle** — skip if last poll was less than `ORCA_DEPLOY_POLL_INTERVAL_SEC` (default 30s) ago.
2. **Timeout** — if `deployStartedAt` + `ORCA_DEPLOY_TIMEOUT_MIN` (default 30min) exceeded → mark `failed`, write-back **"Canceled"** to Linear.
3. **No SHA** — if no `mergeCommitSha` (defensive) → mark `done` with warning.
4. **Poll** `gh run list --commit <sha>`:
   - All runs succeeded → set task to `done`, write-back **"Done"** to Linear.
   - Any run failed → set task to `failed`, write-back **"Canceled"** to Linear. No retry — code is already merged, the deploy pipeline needs manual attention.
   - Runs still pending/in progress → skip, poll again next interval.

`deploying` tasks do NOT consume a concurrency slot (no Claude session is running).

On Orca restart, `deploying` tasks resume polling automatically — they have `mergeCommitSha` stored in the database.

**Linear conflict resolution for `deploying`:**
- Linear "In Review" → no-op (expected state, already there)
- Linear "Todo" → reset to `ready` (user reset)
- Linear "Done" → set to `done` (human override, skip monitoring)
- Linear "Canceled" → set to `failed`

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
              │                  │              ▼
              │                  │        changes_requested
              │                  │              │
              │                  │       write-back "In Progress"
              │                  │              │
              │                  ▼              │
              │            PR merged            │
              │             /       \           │
              │    strategy=none  strategy=github_actions
              │         │              │        │
              │         ▼              ▼        │
              │   Done ◄─ done    deploying     │
              │          │         (polls CI)   │
              │   write-back       /      \     │
              │    "Done"     success   failure  │
              │                 │          │    │
              │                 ▼          ▼    │
              │               done       failed │
              │                │                │
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
     → Done (reviewer approved + merged, strategy=none)
     → deploying (reviewer approved + merged, strategy=github_actions)
     → Done (deploy CI passes)
     → Canceled (deploy CI fails or times out)
```

## 9. Resume on max turns

When `ORCA_RESUME_ON_MAX_TURNS` is `true` (default) and a fresh implementation session hits `error_max_turns`:

1. The worktree is **preserved** (not removed).
2. The task enters `failed` → retry logic sets it back to `ready`.
3. On the next dispatch, the scheduler detects a previous max-turns invocation with a preserved worktree.
4. Instead of creating a fresh worktree, it **reuses the existing one** and passes `--resume` with the previous session ID.
5. The continuation prompt tells the agent: "You hit the maximum turn limit. Continue where you left off."

Resume only applies to fresh implement phases — fix sessions (implement on `changes_requested`) are not resumed.

## 10. Resource cleanup

A periodic cleanup runs every `ORCA_CLEANUP_INTERVAL_MIN` (default 10min) during the scheduler tick:

- **Stale branches**: Local `orca/*` branches older than `ORCA_CLEANUP_BRANCH_MAX_AGE_MIN` (default 60min) with no running invocations, no active tasks, and no open PRs are deleted.
- **Orphaned worktrees**: Registered and unregistered worktree directories matching the `<repo>-<taskId>` pattern are removed if not actively in use or preserved for resume.
- **Safety**: Worktrees and branches used by running invocations, active tasks, or open PRs are never touched.

## 11. Self-deploy

When a task's `repoPath` matches the Orca project's own `process.cwd()` and the task's deploy succeeds, Orca spawns `scripts/deploy.sh` as a detached process and lets it pull, rebuild, and restart Orca with the new code.

## 12. Linear comments

Orca posts comments to Linear issues at key lifecycle events (fire-and-forget):

- **Dispatch**: "Dispatched for implementation/review/fix (invocation #N)"
- **Resume**: "Resuming session (invocation #N, session ...)"
- **Implement success**: "Implementation complete — PR #N opened on branch ..."
- **Review approved**: "Review approved — PR #N merged"
- **Changes requested**: "Review requested changes (cycle N/M)"
- **Retry**: "Invocation failed — retrying (attempt N/M): ..."
- **Permanent failure**: "Task failed permanently after N retries: ..."
- **Deploy started/success/failure**: deploy lifecycle updates
- **Task complete**: "Task complete"

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
| `src/github/index.ts` | PR verification, merge commit SHA, workflow run status via `gh` CLI |
| `src/cleanup/index.ts` | Stale branch + orphaned worktree cleanup |
| `src/git.ts` | Safe git command wrapper |
| `src/config/index.ts` | Env var loading |

## Configuration

| Env Var | Default | Description |
|---|---|---|
| `ORCA_REVIEW_SYSTEM_PROMPT` | (built-in) | System prompt for review agents |
| `ORCA_FIX_SYSTEM_PROMPT` | (built-in) | System prompt for fix agents |
| `ORCA_MAX_REVIEW_CYCLES` | 3 | Max review-fix cycles before human intervention |
| `ORCA_REVIEW_MAX_TURNS` | 30 | Max turns for review agent sessions |
| `ORCA_DEPLOY_STRATEGY` | `none` | `"none"` (skip deploy monitoring) or `"github_actions"` (poll CI) |
| `ORCA_DEPLOY_POLL_INTERVAL_SEC` | 30 | How often to poll GitHub Actions |
| `ORCA_DEPLOY_TIMEOUT_MIN` | 30 | Timeout before marking deploy as failed |
| `ORCA_CLEANUP_INTERVAL_MIN` | 10 | How often the cleanup loop runs (minutes) |
| `ORCA_CLEANUP_BRANCH_MAX_AGE_MIN` | 60 | Min age before stale `orca/*` branches are deleted (minutes) |
| `ORCA_RESUME_ON_MAX_TURNS` | true | Resume sessions that hit max turns (preserves worktree) |
| `ORCA_IMPLEMENT_SYSTEM_PROMPT` | (built-in) | System prompt for implementation agents (replaces `ORCA_APPEND_SYSTEM_PROMPT`) |
| `ORCA_CLOUDFLARED_PATH` | cloudflared | Path to cloudflared binary |

## Known gaps

- **Deploy failure is permanent.** If CI fails after merge, the task is marked failed with no retry — the code is already merged and the deploy pipeline needs manual attention.
- **Review agent must output marker.** If the review agent fails to output `REVIEW_RESULT:APPROVED` or `REVIEW_RESULT:CHANGES_REQUESTED`, the review will be retried.
