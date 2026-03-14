# Orca

AI agent scheduler that dispatches and manages Claude Code CLI sessions. Pulls tasks from Linear, manages concurrency, enforces budgets, and provides a real-time web dashboard.

<img width="2924" height="1556" alt="image" src="https://github.com/user-attachments/assets/bf1ab14f-83ee-4d4b-b03a-dcc5bf8eb07a" />

To me, she's beautiful... Rubenesque.

## How It Works

Orca syncs issues from Linear projects into a local SQLite database, then dispatches them as Claude Code CLI sessions in isolated git worktrees. Each session runs with `--dangerously-skip-permissions` and streams JSON output. Orca handles concurrency limits, cost budgets, timeouts, retries, and dependency ordering.

```
Linear Issues  ──sync──>  Orca DB  ──scheduler──>  Claude Code Sessions
     ^                       |                            |
     |                       v                            v
  write-back            Dashboard                    Git Worktrees
```

## Prerequisites

- **Node.js** >= 20
- **Claude Code CLI** (`claude`) installed and authenticated
- **Git** with long path support enabled (`git config --system core.longpaths true` on Windows)
- **Linear** account with API key and a project to sync
- **cloudflared** for the webhook tunnel — see [Cloudflared Tunnel Setup](docs/cloudflared-setup.md)

## Setup

```bash
git clone <repo-url> orca && cd orca
npm install
cd web && npm install && cd ..
cp .env.example .env
# Edit .env with your values
```

## Configuration

Copy `.env.example` to `.env` and fill in the required values.

### Required

| Variable | Description |
|---|---|
| `ORCA_LINEAR_API_KEY` | Linear API key (`lin_api_...`) |
| `ORCA_LINEAR_WEBHOOK_SECRET` | Webhook signing secret for HMAC verification |
| `ORCA_LINEAR_PROJECT_IDS` | JSON array of Linear project UUIDs, e.g. `["uuid-1"]` |
| `ORCA_TUNNEL_HOSTNAME` | Cloudflared tunnel hostname (e.g. `orca.example.com`) |

### Optional (defaults shown)

| Variable | Default | Description |
|---|---|---|
| `ORCA_DEFAULT_CWD` | *(none)* | Fallback working directory when a project's Linear description has no `repo:` line |
| `ORCA_CONCURRENCY_CAP` | `1` | Max concurrent Claude Code sessions |
| `ORCA_SESSION_TIMEOUT_MIN` | `45` | Hard timeout per session (minutes) |
| `ORCA_MAX_RETRIES` | `3` | Max retries before permanent failure |
| `ORCA_BUDGET_WINDOW_HOURS` | `4` | Rolling budget window (hours) |
| `ORCA_BUDGET_MAX_COST_USD` | `100.00` | Max cost per budget window (USD) |
| `ORCA_SCHEDULER_INTERVAL_SEC` | `10` | Scheduler tick interval (seconds) |
| `ORCA_CLAUDE_PATH` | `claude` | Path to Claude CLI binary |
| `ORCA_CLOUDFLARED_PATH` | `cloudflared` | Path to cloudflared binary |
| `ORCA_DEFAULT_MAX_TURNS` | `50` | Max agentic turns per session |
| `ORCA_IMPLEMENT_SYSTEM_PROMPT` | *(built-in)* | System prompt for implementation agents |
| `ORCA_REVIEW_SYSTEM_PROMPT` | *(built-in)* | System prompt for review agents |
| `ORCA_FIX_SYSTEM_PROMPT` | *(built-in)* | System prompt for fix agents |
| `ORCA_IMPLEMENT_MODEL` | `sonnet` | Model for implementation agents |
| `ORCA_REVIEW_MODEL` | `haiku` | Model for review agents |
| `ORCA_FIX_MODEL` | `sonnet` | Model for fix agents |
| `ORCA_MAX_REVIEW_CYCLES` | `3` | Max review-fix cycles before human intervention |
| `ORCA_REVIEW_MAX_TURNS` | `30` | Max turns for review agent sessions |
| `ORCA_RESUME_ON_MAX_TURNS` | `true` | Resume sessions that hit max turns |
| `ORCA_DISALLOWED_TOOLS` | `""` | Comma-separated list of blocked tools |
| `ORCA_DEPLOY_STRATEGY` | `none` | `"none"` or `"github_actions"` (poll CI after merge) |
| `ORCA_DEPLOY_POLL_INTERVAL_SEC` | `30` | How often to poll GitHub Actions (seconds) |
| `ORCA_DEPLOY_TIMEOUT_MIN` | `30` | Timeout before marking deploy as failed (minutes) |
| `ORCA_CLEANUP_INTERVAL_MIN` | `10` | How often the cleanup loop runs (minutes) |
| `ORCA_CLEANUP_BRANCH_MAX_AGE_MIN` | `60` | Min age before stale `orca/*` branches are deleted (minutes) |
| `ORCA_PORT` | `3000` | HTTP server port |
| `ORCA_DB_PATH` | `./orca.db` | Path to SQLite database file |
| `ORCA_LOG_PATH` | `./orca.log` | Path to log file |
| `ORCA_LOG_MAX_SIZE_MB` | `10` | Max log file size before rotation (MB) |
| `ORCA_TUNNEL_TOKEN` | `""` | Dashboard-managed tunnel token (skips local config) |
| `ORCA_LINEAR_READY_STATE_TYPE` | `unstarted` | Linear state type that signals readiness |
| `ORCA_TASK_FILTER_LABEL` | *(none)* | Only dispatch issues with this Linear label. Useful for multi-instance setups (e.g. `orca-prod`). Fails open if the label doesn't exist. |
| `ORCA_STATE_MAP` | *(none)* | JSON object mapping Linear state names to Orca internal states. Keys are Linear state names; values are one of: `backlog`, `ready`, `running`, `in_review`, `done`, `skip`. Example: `{"Shipped":"done","Won't Fix":"skip"}` |

## macOS Setup

Orca runs on macOS without modification. Platform-specific notes:

- **No long path config needed** — skip the `git config core.longpaths` step (Windows-only)
- **Claude CLI**: if installed via `npm install -g @anthropic-ai/claude-code`, the binary is on your PATH as `claude`. If the default doesn't resolve, set `ORCA_CLAUDE_PATH` to the absolute path (find it with `which claude`)
- **cloudflared**: install via Homebrew — `brew install cloudflared`. The binary lands at `/opt/homebrew/bin/cloudflared` on Apple Silicon or `/usr/local/bin/cloudflared` on Intel. Set `ORCA_CLOUDFLARED_PATH` if it's not on your PATH
- **Repo paths**: use Unix-style paths in `.env` and Linear project descriptions (e.g. `ORCA_DEFAULT_CWD=/Users/you/repos/my-project`, `repo: /Users/you/repos/my-project`)
- **Windows-specific workarounds** in the scheduler (EPERM retries, `.cmd` shim resolution, DLL_INIT cooldown, `taskkill`) do not apply and are bypassed automatically

## Usage

### Development

```bash
# Backend (scheduler + API server)
npm run dev -- start

# Frontend dev server with HMR (separate terminal)
cd web && npm run dev
```

The frontend dev server runs on http://localhost:5173 and proxies `/api/*` to the backend on port 3000.

### Production

```bash
npm run build
cd web && npm run build && cd ..
node dist/cli/index.js start
```

### Linear Integration

> Set up the webhook tunnel first: [Cloudflared Tunnel Setup](docs/cloudflared-setup.md)

1. Create a Linear API key at Settings > API > Personal API keys
2. Create a webhook at Settings > API > Webhooks pointing to `https://<ORCA_TUNNEL_HOSTNAME>/api/webhooks/linear`
3. Copy the webhook signing secret to `ORCA_LINEAR_WEBHOOK_SECRET`
4. Set `ORCA_LINEAR_PROJECT_IDS` to the UUIDs of projects you want to sync

Orca syncs issues on startup and keeps them updated via webhooks. If the tunnel goes down, it falls back to polling every 30 seconds.

## Testing

```bash
npm test
```

## License

MIT
