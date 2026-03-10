# Scheduler Internals

The scheduler is the core of orca (`src/scheduler/index.ts`, ~1800 lines). Understanding it is critical for any backend change.

## Tick Loop (every 10s)

Each tick runs these steps in order:
1. **Timeout check** — kill sessions past `ORCA_SESSION_TIMEOUT_MIN` (45min default)
2. **Deploy monitoring** — poll GitHub Actions for `deploying` tasks
3. **CI gate** — poll PR checks for `awaiting_ci` tasks, merge on success
4. **Cleanup** — stale branches, worktrees, orphaned PRs (throttled to every N minutes)
5. **Concurrency check** — skip dispatch if at `ORCA_CONCURRENCY_CAP`
6. **Budget check** — skip if rolling cost exceeds `ORCA_BUDGET_MAX_COST_USD` in window
7. **Query dispatchable tasks** — status in (`ready`, `in_review`, `changes_requested`)
8. **Filter** — skip parents, blocked tasks, empty prompts, rate-limited, already running
9. **Sort** — review/fix before implement, then priority, then created_at
10. **Dispatch top task**

## Gate 2 (Post-Implementation Verification)

After an implement phase completes successfully, Gate 2 determines what happened:

1. Search for PR by branch name: `gh pr list --head <orca-branch> --repo <expected-repo>`
2. If not found, extract PR URL from agent's output summary and validate repo matches
3. If still not found, check if worktree has no changes vs origin/main (work already on main)
4. Based on result: transition to `in_review` (PR found), `done` (no changes needed), or `failed` (retry)

**Known issue:** If the agent creates a PR on a different branch name or in a different repo than expected, Gate 2 can misclassify the result. See EMI-220, EMI-221, EMI-222.

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
