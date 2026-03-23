# Environment Variables

All config is in `.env` (see `.env.example`). Key variables:

## Required

| Variable | Description |
|----------|-------------|
| `ORCA_LINEAR_API_KEY` | Linear API key (`lin_api_...`) |
| `ORCA_LINEAR_WEBHOOK_SECRET` | HMAC-SHA256 webhook signing secret |
| `ORCA_LINEAR_PROJECT_IDS` | JSON array of Linear project UUIDs |
| `ORCA_TUNNEL_HOSTNAME` | Cloudflared tunnel public hostname (e.g. `orca.example.com`) |

## Server / Storage

| Variable | Default | Description |
|----------|---------|-------------|
| `ORCA_PORT` | `3000` | Local HTTP server port |
| `ORCA_DB_PATH` | `./orca.db` | Path to SQLite database file |
| `ORCA_DEFAULT_CWD` | — | Fallback repo path when a project's Linear description has no `repo:` line |

## Scheduler Tuning

| Variable | Default | Description |
|----------|---------|-------------|
| `ORCA_CONCURRENCY_CAP` | `1` | Max concurrent Claude sessions |
| `ORCA_AGENT_CONCURRENCY_CAP` | `12` | Max concurrent agent task sessions |
| `ORCA_SESSION_TIMEOUT_MIN` | `45` | Hard timeout per session (minutes) |
| `ORCA_MAX_RETRIES` | `3` | Retry attempts before permanent failure |
| `ORCA_MAX_REVIEW_CYCLES` | `10` | Max review-fix loops before human intervention |

## Budget

| Variable | Default | Description |
|----------|---------|-------------|
| `ORCA_BUDGET_WINDOW_HOURS` | `4` | Rolling budget window (hours) |
| `ORCA_BUDGET_MAX_TOKENS` | `1000000000` | Max cumulative tokens per budget window; dispatching halts when exceeded |
| `ORCA_BUDGET_MAX_COST_USD` | `100.00` | Max cumulative cost (USD) per budget window (used by UI/monitoring; not enforced by config) |

## Claude Code Agent

| Variable | Default | Description |
|----------|---------|-------------|
| `ORCA_CLAUDE_PATH` | `claude` | Path to the `claude` CLI binary |
| `ORCA_DEFAULT_MAX_TURNS` | `50` | Default max turns for implement and fix sessions |
| `ORCA_REVIEW_MAX_TURNS` | `30` | Max turns for review sessions |
| `ORCA_DISALLOWED_TOOLS` | *(none)* | Comma-separated list of tools to block in all agent sessions |
| `ORCA_RESUME_ON_MAX_TURNS` | `true` | When `true`, preserve the worktree and resume the session if the agent hits max turns |
| `ORCA_RESUME_ON_FIX` | `true` | When `true`, resume the prior session for fix phases |
| `ORCA_MAX_WORKTREE_RETRIES` | `3` | Max retries when creating a git worktree fails |
| `ORCA_EXTRA_INSTALL_DIRS` | *(none)* | Comma-separated subdirectories to run `npm install` in after worktree creation |

## System Prompts

| Variable | Default | Description |
|----------|---------|-------------|
| `ORCA_IMPLEMENT_SYSTEM_PROMPT` | *(built-in)* | System prompt for implementation agents |
| `ORCA_REVIEW_SYSTEM_PROMPT` | *(built-in)* | System prompt for review agents |
| `ORCA_FIX_SYSTEM_PROMPT` | *(built-in)* | System prompt for fix agents |

## Models

| Variable | Default | Description |
|----------|---------|-------------|
| `ORCA_MODEL` | `sonnet` | Model for implement and fix phases (alias: `ORCA_IMPLEMENT_MODEL`) |
| `ORCA_REVIEW_MODEL` | `haiku` | Model for review phases |

## Deploy Monitoring

| Variable | Default | Description |
|----------|---------|-------------|
| `ORCA_DEPLOY_STRATEGY` | `none` | `none` (mark done immediately after merge) or `github_actions` (poll CI) |
| `ORCA_DEPLOY_MAX_POLL_ATTEMPTS` | `60` | Max polling attempts before marking deploy as timed out |
| `ORCA_CI_MAX_POLL_ATTEMPTS` | `240` | Max polling attempts for CI gate before failing |
| `ORCA_DEPLOY_TIMEOUT_MIN` | `30` | Timeout for deploy monitoring in minutes |
| `ORCA_DEPLOY_POLL_INTERVAL_SEC` | `30` | How often to poll GitHub Actions for deploy status (seconds) |

## Cleanup

| Variable | Default | Description |
|----------|---------|-------------|
| `ORCA_CLEANUP_INTERVAL_MIN` | `10` | How often the cleanup cron runs (minutes) |
| `ORCA_CLEANUP_BRANCH_MAX_AGE_MIN` | `60` | Minimum age before a stale `orca/*` branch is deleted (minutes) |
| `ORCA_INVOCATION_LOG_RETENTION_HOURS` | `168` | Invocation log retention (hours); logs older than this for completed/failed invocations are deleted |
| `ORCA_CRON_RETENTION_DAYS` | `7` | Cron job execution record retention (days) |

## Tunnel / Cloudflare

| Variable | Default | Description |
|----------|---------|-------------|
| `ORCA_TUNNEL_TOKEN` | *(none)* | Dashboard-managed tunnel token; when set, cloudflared uses this instead of local config files |
| `ORCA_CLOUDFLARED_PATH` | `cloudflared` | Path to `cloudflared` binary |
| `ORCA_EXTERNAL_TUNNEL` | `false` | When `true`, skip spawning cloudflared and treat the tunnel as always connected (for externally managed tunnels) |
| `CLOUDFLARE_TUNNEL_ID` | — | Required for blue/green deploy script |
| `CLOUDFLARE_ACCOUNT_ID` | — | Required for blue/green deploy script |
| `CLOUDFLARE_API_TOKEN` | — | Required for blue/green deploy script |

## Linear Integration (optional)

| Variable | Default | Description |
|----------|---------|-------------|
| `ORCA_LINEAR_READY_STATE_TYPE` | `unstarted` | Linear `state.type` that signals readiness for dispatch |
| `ORCA_TASK_FILTER_LABEL` | *(none)* | Only sync/dispatch issues carrying this Linear label. Useful for multi-instance setups (e.g. `orca-prod`). Fails open if the label doesn't exist. |
| `ORCA_STATE_MAP` | *(none)* | JSON object mapping Linear state names to Orca internal statuses. Valid values: `backlog`, `ready`, `running`, `in_review`, `done`, `skip`. Example: `{"QA Review":"in_review","Won't Fix":"skip"}` |

## Inngest

| Variable | Default | Description |
|----------|---------|-------------|
| `INNGEST_EVENT_KEY` | — | Event key for Inngest server authentication |
| `INNGEST_SIGNING_KEY` | — | Signing key for request verification |
| `INNGEST_BASE_URL` | `http://localhost:8288` | URL of the self-hosted Inngest server |

## Monitoring / Alerts

| Variable | Default | Description |
|----------|---------|-------------|
| `ORCA_ALERT_WEBHOOK_URL` | *(none)* | Webhook URL for permanent failure alerts (Slack/Discord compatible) |
| `ORCA_GITHUB_WEBHOOK_SECRET` | *(none)* | GitHub webhook secret for auto-deploy on push to main |
| `MONITOR_BURN_RATE_ALERT_USD_PER_HOUR` | `20` | Burn rate threshold for alerts (USD/hour); fires when budget is spent faster than this rate |

## Logging

| Variable | Default | Description |
|----------|---------|-------------|
| `ORCA_LOG_PATH` | `./orca.log` | Path to the Orca log file |
| `ORCA_LOG_MAX_SIZE_MB` | `10` | Max log file size before rotation (MB) |
| `LOG_LEVEL` | `info` | Log verbosity: `debug`, `info`, `warn`, `error` |
