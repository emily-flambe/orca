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
| `ORCA_DEFAULT_CWD` | — | Fallback repo path when a project's Linear description has no `repo:` line |

## Scheduler Tuning

| Variable | Default | Description |
|----------|---------|-------------|
| `ORCA_CONCURRENCY_CAP` | 1 | Max concurrent Claude sessions |
| `ORCA_AGENT_CONCURRENCY_CAP` | 12 | Max concurrent agent task sessions |
| `ORCA_SESSION_TIMEOUT_MIN` | 45 | Hard timeout per session (minutes) |
| `ORCA_MAX_RETRIES` | 3 | Retry attempts before permanent failure |
| `ORCA_BUDGET_WINDOW_HOURS` | 4 | Rolling token budget window (hours) |
| `ORCA_BUDGET_MAX_TOKENS` | 1000000000 | Max tokens per budget window before tasks are re-queued |
| `ORCA_MAX_REVIEW_CYCLES` | 10 | Max review-fix loops before leaving for human intervention |

## Models

| Variable | Default | Description |
|----------|---------|-------------|
| `ORCA_MODEL` | sonnet | Model for implement and fix phases |
| `ORCA_REVIEW_MODEL` | haiku | Model for review phase |

## Claude Code

| Variable | Default | Description |
|----------|---------|-------------|
| `ORCA_CLAUDE_PATH` | claude | Path to the `claude` CLI binary |
| `ORCA_DEFAULT_MAX_TURNS` | 50 | Default max turns per agent session |
| `ORCA_REVIEW_MAX_TURNS` | 30 | Max turns for review agent sessions |
| `ORCA_DISALLOWED_TOOLS` | — | Comma-separated list of blocked Claude tools |
| `ORCA_IMPLEMENT_SYSTEM_PROMPT` | (built-in) | Override system prompt for implement sessions |
| `ORCA_REVIEW_SYSTEM_PROMPT` | (built-in) | Override system prompt for review sessions |
| `ORCA_FIX_SYSTEM_PROMPT` | (built-in) | Override system prompt for fix sessions |

## Inngest

| Variable | Default | Description |
|----------|---------|-------------|
| `INNGEST_EVENT_KEY` | — | Event key for Inngest server authentication |
| `INNGEST_SIGNING_KEY` | — | Signing key for request verification |
| `INNGEST_BASE_URL` | `http://localhost:8288` | URL of the self-hosted Inngest server |

## Deploy

| Variable | Default | Description |
|----------|---------|-------------|
| `ORCA_DEPLOY_STRATEGY` | none | `none` or `github_actions` |
| `ORCA_DEPLOY_TIMEOUT_MIN` | 30 | Deploy monitoring timeout before marking failed (minutes) |
| `ORCA_DEPLOY_MAX_POLL_ATTEMPTS` | 60 | Max GitHub Actions poll attempts during deploy monitoring |
| `ORCA_CI_MAX_POLL_ATTEMPTS` | 240 | Max CI poll attempts during the CI gate (awaiting_ci) |
| `CLOUDFLARE_TUNNEL_ID` | — | Required for blue/green deploy script |
| `CLOUDFLARE_ACCOUNT_ID` | — | Required for blue/green deploy script |
| `CLOUDFLARE_API_TOKEN` | — | Required for blue/green deploy script |

## Tunnel

| Variable | Default | Description |
|----------|---------|-------------|
| `ORCA_TUNNEL_TOKEN` | — | Cloudflare tunnel token (dashboard-managed; alternative to local config files) |
| `ORCA_CLOUDFLARED_PATH` | cloudflared | Path to the `cloudflared` binary |
| `ORCA_EXTERNAL_TUNNEL` | false | Skip spawning cloudflared; treat tunnel as always connected (use when cloudflared runs as a system service) |

## Server & Storage

| Variable | Default | Description |
|----------|---------|-------------|
| `ORCA_PORT` | 3000 | Local HTTP server port |
| `ORCA_DB_PATH` | ./orca.db | Path to the SQLite database file |
| `ORCA_LOG_PATH` | ./orca.log | Path to the Orca log file |
| `LOG_LEVEL` | info | Log verbosity: `debug`, `info`, `warn`, or `error` |

## Alerts & Monitoring

| Variable | Default | Description |
|----------|---------|-------------|
| `ORCA_ALERT_WEBHOOK_URL` | — | Webhook URL for permanent failure alerts (Slack/Discord compatible) |
| `ORCA_GITHUB_WEBHOOK_SECRET` | — | GitHub webhook secret for auto-deploy on push to main (optional) |
