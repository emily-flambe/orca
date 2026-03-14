# Inngest Workflow Architecture

Orca's orchestration is handled by Inngest durable workflows (`src/inngest/`). The legacy 10s tick-loop scheduler has been removed. Only types and alert utilities remain in `src/scheduler/`.

## Event-Driven Dispatch

Tasks are dispatched via Inngest events, not polling:

- `task/ready` → triggers **task-lifecycle** workflow (implement → Gate 2 → review → fix loop)
- `task/awaiting-ci` → triggers **ci-gate-merge** workflow (poll PR checks, merge on success)
- `task/deploying` → triggers **deploy-monitor** workflow (poll GitHub Actions)
- `session/completed` / `session/failed` → picked up by `step.waitForEvent()` in task-lifecycle

Events are defined in `src/inngest/events.ts`. All four workflows are registered in `src/inngest/functions.ts`.

## Workflow Chain

```
task/ready → task-lifecycle
  ├── step: budget check
  ├── step: spawn session (implement)
  ├── waitForEvent: session/completed or session/failed
  ├── step: Gate 2 (verify PR)
  ├── step: spawn session (review)
  ├── waitForEvent: session/completed or session/failed
  ├── step: parse review result
  ├── (if changes_requested) loop back to fix → review
  └── emit task/awaiting-ci → ci-gate-merge
        ├── step: poll mergeStateStatus
        ├── step: merge PR
        └── (if deploy) emit task/deploying → deploy-monitor
```

## Cleanup Cron

`cleanupCronWorkflow` runs every 5 minutes via Inngest cron. Handles stale `orca/*` branches, orphaned worktrees, and abandoned PRs.

## Dependency Injection

Business logic needs access to DB, runner, Linear client, etc. These are injected at startup:

1. `setSchedulerDeps(deps)` in `src/inngest/deps.ts` stores a `SchedulerDeps` object
2. Workflow steps call `getSchedulerDeps()` to access shared dependencies
3. Types defined in `src/scheduler/types.ts`

## Session Bridge Pattern

Claude sessions run 10-45 minutes. Inngest steps must not block that long.

1. `step.run("start-session")` spawns the Claude process, returns immediately
2. `monitorSession()` (fire-and-forget in `src/inngest/activities/session-bridge.ts`) watches the process
3. When the session ends, `monitorSession` calls `inngest.send()` with `session/completed` or `session/failed`
4. The workflow picks up the result via `step.waitForEvent()` with a timeout

## Concurrency & Budget

- **Concurrency**: Inngest's built-in `concurrency` config enforces `ORCA_CONCURRENCY_CAP`
- **Budget**: First step in task-lifecycle checks rolling cost against `ORCA_BUDGET_MAX_COST_USD`

## Gate 2 (Post-Implementation Verification)

After an implement phase completes successfully, Gate 2 determines what happened:

1. Search for PR by branch name: `gh pr list --head <orca-branch> --repo <expected-repo>`
2. If not found, extract PR URL from agent's output summary and validate repo matches
3. If still not found, check if worktree has no changes vs origin/main (work already on main)
4. Based on result: transition to `in_review` (PR found), `done` (no changes needed), or `failed` (retry)

## Agent Spawning

- Spawns `claude` CLI via `child_process.spawn` with `--output-format stream-json --verbose --dangerously-skip-permissions`
- On Windows, resolves `.cmd` shim to direct `node cli.js` invocation (avoids DEP0190)
- Each session runs in an isolated git worktree (`<repo>-<taskId>`)
- Always blocks `EnterPlanMode` and `AskUserQuestion` tools
- Three model configs: implement (sonnet), review (haiku), fix (sonnet)
- Logs to `logs/<invocationId>.ndjson`
- Supports `--resume` for max-turns continuation

## Retry Logic

- Failed tasks retry up to `ORCA_MAX_RETRIES` (3) by resetting to `ready`
- Max-turns failures preserve the worktree for `--resume` on next dispatch
- Exhausted retries → permanent `failed`, Linear write-back to "Canceled"

## Linear Write-back

Orca writes status changes back to Linear with echo prevention (registers expected changes, ignores webhook echoes within 10s). Conflict resolution handles user-initiated Linear state changes (Todo resets, Done overrides, Canceled kills sessions).
