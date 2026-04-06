# Environment Variables

All config is in `.env` (see `.env.example`). Key variables:

## Required

| Variable | Description |
|----------|-------------|
| `ORCA_LINEAR_API_KEY` | Linear API key (`lin_api_...`) |
| `ORCA_LINEAR_WEBHOOK_SECRET` | HMAC-SHA256 webhook signing secret |
| `ORCA_LINEAR_PROJECT_IDS` | JSON array of Linear project UUIDs |
| `ORCA_TUNNEL_HOSTNAME` | Cloudflared tunnel public hostname |

## Paths & Server

| Variable | Default | Description |
|----------|---------|-------------|
| `ORCA_DEFAULT_CWD` | — | Fallback repo path when a project's Linear description has no `repo:` line |
| `ORCA_PORT` | `3000` | HTTP server port |
| `ORCA_DB_PATH` | `./orca.db` | Path to SQLite database file |
| `ORCA_LOG_PATH` | `./orca.log` | Path to the Orca log file |
| `LOG_LEVEL` | `info` | Log verbosity: `debug`, `info`, `warn`, `error` |

## Scheduler Tuning

| Variable | Default | Description |
|----------|---------|-------------|
| `ORCA_CONCURRENCY_CAP` | `1` | Max concurrent Claude sessions |
| `ORCA_AGENT_CONCURRENCY_CAP` | `12` | Max concurrent agent task sessions |
| `ORCA_SESSION_TIMEOUT_MIN` | `45` | Hard timeout per session (minutes) |
| `ORCA_MAX_RETRIES` | `3` | Retry attempts before permanent failure |

## Models

| Variable | Default | Description |
|----------|---------|-------------|
| `ORCA_MODEL` | `sonnet` | Model for implement and fix phases (alias: `ORCA_IMPLEMENT_MODEL`) |

## Claude Code Agent

| Variable | Default | Description |
|----------|---------|-------------|
| `ORCA_CLAUDE_PATH` | `claude` | Path to claude CLI binary |
| `ORCA_DEFAULT_MAX_TURNS` | `50` | Default max turns per session |
| `ORCA_IMPLEMENT_SYSTEM_PROMPT` | (built-in) | System prompt for implementation agents |
| `ORCA_FIX_SYSTEM_PROMPT` | (built-in) | System prompt for fix agents |
| `ORCA_DISALLOWED_TOOLS` | — | Comma-separated list of tools to block in agent sessions |

## Inngest

| Variable | Default | Description |
|----------|---------|-------------|
| `INNGEST_EVENT_KEY` | — | Event key for Inngest server authentication |
| `INNGEST_SIGNING_KEY` | — | Signing key for request verification |
| `INNGEST_BASE_URL` | `http://localhost:8288` | URL of the self-hosted Inngest server |

## MCP

| Variable | Default | Description |
|----------|---------|-------------|
| `GITHUB_MCP_PAT` | — | GitHub PAT for the official GitHub MCP server. When set, agents get structured PR/issue/Actions tools via `https://api.githubcopilot.com/mcp/`. Fine-grained PAT with repo + pr scopes. |

## Logging

| Variable | Default | Description |
|----------|---------|-------------|
| `LOG_LEVEL` | `info` | Minimum log level: `debug`, `info`, `warn`, `error` |
| `LOG_FORMAT` | `text` | Output format: `text` (human-readable) or `json` (structured JSON for log aggregation) |

## Tunnel

| Variable | Default | Description |
|----------|---------|-------------|
| `ORCA_TUNNEL_TOKEN` | — | Dashboard-managed tunnel token; when set, cloudflared uses this instead of local config files |
| `ORCA_CLOUDFLARED_PATH` | `cloudflared` | Path to cloudflared binary |
| `ORCA_EXTERNAL_TUNNEL` | `false` | Skip spawning cloudflared and treat tunnel as always connected |

## Alerts

| Variable | Default | Description |
|----------|---------|-------------|
| `ORCA_ALERT_WEBHOOK_URL` | — | Webhook URL for permanent failure alerts (Slack/Discord compatible) |

## Deploy

| Variable | Default | Description |
|----------|---------|-------------|
| `ORCA_DEPLOY_STRATEGY` | `none` | `none` (mark done immediately after merge) or `github_actions` (poll CI) |
| `ORCA_DEPLOY_MAX_POLL_ATTEMPTS` | `60` | Max attempts when polling GitHub Actions for deploy status |
| `ORCA_CI_MAX_POLL_ATTEMPTS` | `240` | Max attempts when polling CI checks before merge |
| `CLOUDFLARE_TUNNEL_ID` | — | Required for blue/green deploy script |
| `CLOUDFLARE_ACCOUNT_ID` | — | Required for blue/green deploy script |
| `CLOUDFLARE_API_TOKEN` | — | Required for blue/green deploy script |
