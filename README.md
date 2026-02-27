# Orca

AI agent scheduler that dispatches and manages Claude Code CLI sessions. Pulls tasks from Linear, manages concurrency, enforces budgets, and provides a real-time web dashboard.

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
- **Git** (for worktree management)
- **Linear** account with API key and a project to sync
- **cloudflared** (for webhook tunnel — optional if using polling fallback)

### Windows Notes

- `better-sqlite3` requires native compilation. Ensure you have [Windows Build Tools](https://github.com/nicedoc/windows-build-tools) or Visual Studio C++ workload installed.
- `cloudflared` must be [installed separately](https://developers.cloudflare.com/cloudflare-one/connections/connect-apps/install-and-setup/installation/).
- Git worktrees work on Windows, but ensure long path support is enabled: `git config --system core.longpaths true`

## Setup

```bash
# Clone and install backend dependencies
git clone <repo-url> orca
cd orca
npm install

# Install frontend dependencies
cd web
npm install
cd ..

# Configure environment
cp .env.example .env
# Edit .env with your values (see Configuration below)
```

## Configuration

Copy `.env.example` to `.env` and fill in the required values:

### Required

| Variable | Description |
|---|---|
| `ORCA_DEFAULT_CWD` | Default working directory for sessions (must exist) |
| `ORCA_LINEAR_API_KEY` | Linear API key (`lin_api_...`) |
| `ORCA_LINEAR_WEBHOOK_SECRET` | Webhook signing secret for HMAC verification |
| `ORCA_LINEAR_PROJECT_IDS` | JSON array of Linear project UUIDs, e.g. `["uuid-1"]` |
| `ORCA_TUNNEL_HOSTNAME` | Cloudflared tunnel hostname (e.g. `orca.example.com`) |

### Optional (defaults shown)

| Variable | Default | Description |
|---|---|---|
| `ORCA_CONCURRENCY_CAP` | `3` | Max concurrent Claude Code sessions |
| `ORCA_SESSION_TIMEOUT_MIN` | `45` | Hard timeout per session (minutes) |
| `ORCA_MAX_RETRIES` | `3` | Max retries before permanent failure |
| `ORCA_BUDGET_WINDOW_HOURS` | `4` | Rolling budget window (hours) |
| `ORCA_BUDGET_MAX_COST_USD` | `10.00` | Max cost per budget window (USD) |
| `ORCA_SCHEDULER_INTERVAL_SEC` | `10` | Scheduler tick interval (seconds) |
| `ORCA_CLAUDE_PATH` | `claude` | Path to Claude CLI binary |
| `ORCA_DEFAULT_MAX_TURNS` | `20` | Max agentic turns per session |
| `ORCA_APPEND_SYSTEM_PROMPT` | `""` | Text appended to every session's system prompt |
| `ORCA_DISALLOWED_TOOLS` | `""` | Comma-separated list of blocked tools |
| `ORCA_PORT` | `3000` | HTTP server port |
| `ORCA_DB_PATH` | `./orca.db` | Path to SQLite database file |
| `ORCA_LINEAR_READY_STATE_TYPE` | `unstarted` | Linear state type that signals readiness |

## Usage

### Running in Development

```bash
# Start the scheduler + API server (backend only, uses tsx)
npm run dev start

# In a separate terminal, start the dashboard dev server (with HMR)
cd web
npm run dev
```

The dashboard dev server runs on http://localhost:5173 and proxies `/api/*` to the backend on port 3000.

### Running in Production

```bash
# Build the backend
npm run build

# Build the frontend
cd web && npm run build && cd ..

# Start (serves dashboard from web/dist/)
node dist/cli/index.js start
```

The dashboard is served at http://localhost:3000 (or whatever `ORCA_PORT` is set to).

### CLI Commands

```bash
# Start the scheduler, API server, tunnel, and dashboard
orca start

# Add a task manually (bypasses Linear)
orca add --prompt "Fix the login bug" --repo /path/to/repo --priority 2

# Set/update an agent prompt for a Linear issue
orca prompt PROJ-123 "Implement the feature described in the issue"

# Check scheduler status
orca status
```

### Dashboard

The web dashboard (http://localhost:3000) provides:

- **Orchestrator bar** — budget gauge, active session count, queued task count
- **Task list** — filterable by status, sortable by priority/status/date
- **Task detail** — edit agent prompts, manually dispatch tasks, view invocation history

### Linear Integration

1. Create a Linear API key at Settings > API > Personal API keys
2. Create a webhook at Settings > API > Webhooks pointing to `https://<ORCA_TUNNEL_HOSTNAME>/api/webhooks/linear`
3. Copy the webhook signing secret to `ORCA_LINEAR_WEBHOOK_SECRET`
4. Set `ORCA_LINEAR_PROJECT_IDS` to the UUIDs of projects you want to sync

Orca syncs issues on startup and keeps them updated via webhooks. If the tunnel goes down, it falls back to polling every 30 seconds.

## Testing

```bash
npm test            # Run all 58 tests
npm run test:watch  # Watch mode
```

## Project Structure

```
src/
  cli/index.ts          # Commander.js CLI (add, prompt, start, status)
  config/index.ts       # Environment config loader
  db/                   # SQLite schema, queries, connection (Drizzle ORM)
  scheduler/index.ts    # Dispatch loop, timeout/retry/budget logic
  runner/index.ts       # Claude CLI session spawner + stream parser
  worktree/index.ts     # Git worktree lifecycle
  linear/               # Linear API client, sync, webhook, dependency graph, poller
  tunnel/index.ts       # Cloudflared tunnel manager
  api/routes.ts         # REST API + SSE endpoints (Hono)
  events.ts             # EventEmitter-based event bus
web/
  src/                  # React + Tailwind dashboard SPA
  vite.config.ts        # Vite config with API proxy
test/
  integration.test.ts   # Core scheduler tests
  linear-integration.test.ts  # Linear integration tests
  api.test.ts           # REST API endpoint tests
```

## License

MIT
