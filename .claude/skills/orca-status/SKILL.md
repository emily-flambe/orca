---
name: orca-status
description: Report on Orca's recent status — running sessions, task breakdown, cost/token spend, success rate, recent errors, and activity. Use when the user asks "how is orca doing", "orca status", or "what has orca been up to".
---

Generate a status report for the running Orca instance. If Orca is down, restart it automatically.

## Step 1 — Determine the API base URL

Read `deploy-state.json` in the orca repo root to find `activePort`. Also try the alternate port (if active is 4000, try 4001 and vice versa). Default to 4000 if the file doesn't exist.

## Step 2 — Health check and auto-restart

Run `curl -sf http://localhost:<activePort>/api/status` via Bash. If it fails, also try the alternate port.

**If neither port responds, Orca is down. Restart it automatically:**

1. Check system boot time: `systeminfo | findstr "Boot Time"` — include in the report so the user knows if a reboot caused the outage
2. Tell the user: "Orca is down. Restarting via deploy script..."
3. Run: `bash /c/Users/emily/Documents/Github/orca/scripts/deploy.sh`
3. Wait for the deploy script to complete (it does its own health checks)
4. Re-read `deploy-state.json` to get the new active port
5. Verify with `curl -sf http://localhost:<newPort>/api/status`
6. If it still fails after deploy, report the failure and stop

After a restart, note in the report that Orca was restarted as part of this status check.

## Step 3 — Fetch data

Use `curl -s` via Bash to call these endpoints **in parallel**:

| Endpoint | What it returns |
|----------|-----------------|
| `GET /api/status` | Running sessions, budget spend, scheduler state, uptime |
| `GET /api/metrics` | Invocation stats (by status), avg duration/cost/tokens, success rate, daily stats, recent errors |
| `GET /api/tasks` | All tasks with current statuses |
| `GET /api/invocations/running` | Currently active sessions |

## Step 4 — Format the report

Present a concise, scannable status report with these sections:

### Health
- Is Orca up? (did the API respond)
- Active sessions: count and what tasks they're working on
- Scheduler state: running/paused/draining
- Uptime

### Task Breakdown
- Group tasks by `orcaStatus` and show counts (e.g., "done: 12, running: 1, ready: 3, failed: 2")
- If any tasks are `failed`, list them with their Linear issue IDs
- If any tasks are `running` or `dispatched`, list them

### Spend (Rolling Window)
- Budget spend (cost USD) vs cap
- Token spend vs cap
- Window duration

### Performance (from metrics)
- Success rate (12h)
- Avg session duration
- Avg cost per session
- Total cost all-time

### Recent Activity
- Last 5 completed or failed invocations from the metrics `recentActivity` array
- Show: task ID, phase, status, cost, duration (computed from startedAt/endedAt)

### Recent Errors
- If any errors exist in `recentErrors`, list the last 3 with: task ID, phase, output summary (truncated to 100 chars), when it happened

## Formatting Rules

- Use a markdown table for the task breakdown
- Keep the report under 60 lines
- Round costs to 2 decimal places, durations to the nearest minute
- Use relative times where possible ("2 hours ago", "yesterday")
- If any API call fails, note it and report what you can from the calls that succeeded
- If Orca was restarted, add a "Restarted" line at the top of the Health section

## Fallback — Direct DB Query

If the API is unresponsive and the deploy script also fails, fall back to querying the SQLite database directly using `node -e` with `better-sqlite3` (installed in the orca repo). This gives read-only access to tasks, invocations, and budget_events.

**Important:** The live DB may not have all schema columns (e.g., `input_tokens`/`output_tokens` on `invocations`). Always run `PRAGMA table_info(<table>)` before querying to check available columns.
