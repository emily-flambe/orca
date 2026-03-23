# Environment Variables

All config is in `.env` (see `.env.example`). Key variables:

## Required

| Variable | Description |
|----------|-------------|
| `ORCA_LINEAR_API_KEY` | Linear API key (`lin_api_...`) |
| `ORCA_LINEAR_WEBHOOK_SECRET` | HMAC-SHA256 webhook signing secret |
| `ORCA_LINEAR_PROJECT_IDS` | JSON array of Linear project UUIDs |
| `ORCA_TUNNEL_HOSTNAME` | Cloudflared tunnel public hostname |

## Optional / Fallback

| Variable | Default | Description |
|----------|---------|-------------|
| `ORCA_DEFAULT_CWD` | — | Fallback working directory when a project's Linear description has no `repo:` line |
| `ORCA_TUNNEL_TOKEN` | — | Dashboard-managed Cloudflare tunnel token; when set, cloudflared uses token auth instead of local config files |
| `ORCA_LINEAR_READY_STATE_TYPE` | `unstarted` | Linear state type that signals readiness for dispatch |
| `ORCA_TASK_FILTER_LABEL` | — | Only sync Linear issues that carry this label. Useful for multi-instance setups (e.g. one Orca per environment). When unset, all issues in configured projects are synced. |
| `ORCA_STATE_MAP` | — | JSON object mapping Linear state names to Orca internal statuses. Overrides the default type-based mapping. Valid statuses: `backlog`, `ready`, `running`, `in_review`, `done`, `skip`. Example: `{"QA Review":"in_review"}` |

## Scheduler Tuning

| Variable | Default | Description |
|----------|---------|-------------|
| `ORCA_CONCURRENCY_CAP` | 1 | Max concurrent Claude sessions |
| `ORCA_SESSION_TIMEOUT_MIN` | 45 | Hard timeout per session (minutes) |
| `ORCA_MAX_RETRIES` | 3 | Retry attempts before permanent failure |
| `ORCA_BUDGET_WINDOW_HOURS` | 4 | Rolling budget window duration (hours) |
| `ORCA_BUDGET_MAX_TOKENS` | 1000000000 | Max cumulative tokens per budget window |

## Agent (Claude Code)

| Variable | Default | Description |
|----------|---------|-------------|
| `ORCA_CLAUDE_PATH` | `claude` | Path to the `claude` CLI binary |
| `ORCA_MODEL` | `sonnet` | Model for implement phase (alias: `ORCA_IMPLEMENT_MODEL`) |
| `ORCA_REVIEW_MODEL` | `haiku` | Model for review phase |
| `ORCA_DEFAULT_MAX_TURNS` | 50 | Default max turns per session |
| `ORCA_REVIEW_MAX_TURNS` | 30 | Max turns for review agent sessions |
| `ORCA_MAX_REVIEW_CYCLES` | 10 | Max review-fix cycles before leaving for human intervention |
| `ORCA_DISALLOWED_TOOLS` | — | Comma-separated list of blocked Claude tools |
| `ORCA_RESUME_ON_MAX_TURNS` | `true` | Resume implement sessions that hit max turns (preserves worktree, passes `--resume`) |
| `ORCA_RESUME_ON_FIX` | `true` | Resume fix sessions from the prior session |
| `ORCA_MAX_WORKTREE_RETRIES` | 3 | Max retries when creating a git worktree fails |
| `ORCA_EXTRA_INSTALL_DIRS` | — | Comma-separated subdirectories to run `npm install` in after worktree creation (instead of root) |
| `ORCA_IMPLEMENT_SYSTEM_PROMPT` | built-in | System prompt for implementation agents |
| `ORCA_REVIEW_SYSTEM_PROMPT` | built-in | System prompt for review agents |
| `ORCA_FIX_SYSTEM_PROMPT` | built-in | System prompt for fix agents |

## Deploy Monitoring

| Variable | Default | Description |
|----------|---------|-------------|
| `ORCA_DEPLOY_STRATEGY` | `none` | `none` (mark done immediately after merge) or `github_actions` (poll CI) |
| `ORCA_DEPLOY_TIMEOUT_MIN` | 30 | Timeout before marking a deploy as failed (minutes) |
| `ORCA_DEPLOY_POLL_INTERVAL_SEC` | 30 | How often to poll GitHub Actions for deploy status (seconds) |
| `ORCA_DEPLOY_MAX_POLL_ATTEMPTS` | 60 | Max deploy poll attempts before timeout |
| `ORCA_CI_MAX_POLL_ATTEMPTS` | 240 | Max CI poll attempts before giving up on merge gate |

## Cleanup

| Variable | Default | Description |
|----------|---------|-------------|
| `ORCA_CLEANUP_INTERVAL_MIN` | 10 | How often the cleanup loop runs (minutes) |
| `ORCA_CLEANUP_BRANCH_MAX_AGE_MIN` | 60 | Min age before stale `orca/*` branches are deleted (minutes) |
| `ORCA_INVOCATION_LOG_RETENTION_HOURS` | 168 | Log retention for completed/failed invocations (hours) |
| `ORCA_CRON_RETENTION_DAYS` | 7 | Cron job execution record retention (days) |

## Storage & Logging

| Variable | Default | Description |
|----------|---------|-------------|
| `ORCA_PORT` | 3000 | Local server port |
| `ORCA_DB_PATH` | `./orca.db` | Path to SQLite database file |
| `ORCA_LOG_PATH` | `./orca.log` | Path to the Orca log file |
| `ORCA_LOG_MAX_SIZE_MB` | 10 | Max log file size before rotation (MB) |
| `LOG_LEVEL` | `info` | Log verbosity: `debug`, `info`, `warn`, `error` |

## Inngest

| Variable | Default | Description |
|----------|---------|-------------|
| `INNGEST_EVENT_KEY` | — | Event key for Inngest server authentication |
| `INNGEST_SIGNING_KEY` | — | Signing key for request verification |
| `INNGEST_BASE_URL` | `http://localhost:8288` | URL of the self-hosted Inngest server |

## Tunnel & Integrations

| Variable | Default | Description |
|----------|---------|-------------|
| `ORCA_CLOUDFLARED_PATH` | `cloudflared` | Path to cloudflared binary |
| `ORCA_EXTERNAL_TUNNEL` | `false` | When `true`, Orca skips spawning cloudflared and treats the tunnel as always connected |
| `ORCA_GITHUB_WEBHOOK_SECRET` | — | GitHub webhook secret for auto-deploy on push to main (optional) |
| `ORCA_ALERT_WEBHOOK_URL` | — | Webhook URL for permanent failure alerts (Slack/Discord compatible) |
| `MONITOR_BURN_RATE_ALERT_USD_PER_HOUR` | 20 | Alert threshold in USD/hour for burn rate monitoring |

## Blue/Green Deploy (Cloudflare Tunnel API)

Required for `scripts/deploy.sh` to switch tunnel origin port:

| Variable | Description |
|----------|-------------|
| `CLOUDFLARE_TUNNEL_ID` | Cloudflare tunnel UUID |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare account ID |
| `CLOUDFLARE_API_TOKEN` | Cloudflare API token |
