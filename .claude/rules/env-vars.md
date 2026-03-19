# Environment Variables

All config is in `.env` (see `.env.example`). Key variables:

## Required

| Variable | Description |
|----------|-------------|
| `ORCA_LINEAR_API_KEY` | Linear API key (`lin_api_...`) |
| `ORCA_LINEAR_WEBHOOK_SECRET` | HMAC-SHA256 webhook signing secret |
| `ORCA_LINEAR_PROJECT_IDS` | JSON array of Linear project UUIDs |
| `ORCA_TUNNEL_HOSTNAME` | Cloudflared tunnel hostname |

## Scheduler Tuning

| Variable | Default | Description |
|----------|---------|-------------|
| `ORCA_CONCURRENCY_CAP` | 1 | Max concurrent Claude sessions |
| `ORCA_SESSION_TIMEOUT_MIN` | 45 | Hard timeout per session |
| `ORCA_MAX_RETRIES` | 3 | Retry attempts before permanent failure |
| `ORCA_BUDGET_MAX_COST_USD` | 100 | Rolling budget cap |
| `ORCA_BUDGET_WINDOW_HOURS` | 4 | Rolling budget window |
| `ORCA_MAX_REVIEW_CYCLES` | 10 | Max review-fix loops |
| `ORCA_ZERO_COST_CIRCUIT_BREAKER_THRESHOLD` | 5 | Zero-cost failures threshold before circuit breaker trips |
| `ORCA_ZERO_COST_CIRCUIT_BREAKER_WINDOW_MIN` | 30 | Circuit breaker window duration in minutes |

## Models

| Variable | Default | Description |
|----------|---------|-------------|
| `ORCA_IMPLEMENT_MODEL` | sonnet | Model for implement phase |
| `ORCA_REVIEW_MODEL` | haiku | Model for review phase |
| `ORCA_FIX_MODEL` | sonnet | Model for fix phase |

## Inngest

| Variable | Default | Description |
|----------|---------|-------------|
| `INNGEST_EVENT_KEY` | — | Event key for Inngest server authentication |
| `INNGEST_SIGNING_KEY` | — | Signing key for request verification |
| `INNGEST_BASE_URL` | `http://localhost:8288` | URL of the self-hosted Inngest server |

## Monitor

| Variable | Default | Description |
|----------|---------|-------------|
| `MONITOR_BURN_RATE_ALERT_USD_PER_HOUR` | 20 | Budget burn rate alert threshold in USD/hour |

## Deploy

| Variable | Default | Description |
|----------|---------|-------------|
| `ORCA_DEPLOY_STRATEGY` | none | `none` or `github_actions` |
| `CLOUDFLARE_TUNNEL_ID` | — | Required for blue/green deploy script |
| `CLOUDFLARE_ACCOUNT_ID` | — | Required for blue/green deploy script |
| `CLOUDFLARE_API_TOKEN` | — | Required for blue/green deploy script |
