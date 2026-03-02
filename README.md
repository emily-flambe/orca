# Orca

AI agent scheduler that dispatches and manages Claude Code CLI sessions. Pulls tasks from Linear, manages concurrency, enforces budgets, and provides a real-time web dashboard.

Orca syncs issues from Linear projects into a local SQLite database, then dispatches them as Claude Code CLI sessions in isolated git worktrees. Each session runs with `--dangerously-skip-permissions` and streams JSON output. Orca handles concurrency limits, cost budgets, timeouts, retries, and dependency ordering.

## Prerequisites

- **Node.js** >= 20
- **Claude Code CLI** (`claude`) installed and authenticated
- **Git** (for worktree management)
- **Linear** account with API key and a project to sync
- **cloudflared** (for webhook tunnel — optional if using polling fallback). See [Cloudflared Tunnel Setup](docs/cloudflared-setup.md).

## Setup

```bash
git clone <repo-url> orca
cd orca
npm install
cd web && npm install && cd ..
cp .env.example .env
# Edit .env with your values
```

## Configuration

Copy `.env.example` to `.env`. Required variables:

| Variable | Description |
|---|---|
| `ORCA_LINEAR_API_KEY` | Linear API key (`lin_api_...`) |
| `ORCA_LINEAR_WEBHOOK_SECRET` | Webhook signing secret for HMAC verification |
| `ORCA_LINEAR_PROJECT_IDS` | JSON array of Linear project UUIDs, e.g. `["uuid-1"]` |
| `ORCA_TUNNEL_HOSTNAME` | Cloudflared tunnel hostname (e.g. `orca.example.com`) |

Notable optional variables (see `.env.example` for full list):

| Variable | Default | Description |
|---|---|---|
| `ORCA_CONCURRENCY_CAP` | `3` | Max concurrent Claude Code sessions |
| `ORCA_SESSION_TIMEOUT_MIN` | `45` | Hard timeout per session (minutes) |
| `ORCA_BUDGET_MAX_COST_USD` | `1000.00` | Max cost per rolling budget window |
| `ORCA_MAX_RETRIES` | `3` | Max retries before permanent failure |
| `ORCA_PORT` | `3000` | HTTP server port |
| `ORCA_DB_PATH` | `./orca.db` | Path to SQLite database file |

## Usage

### Development

```bash
# Backend (scheduler + API server)
npm run dev -- start

# Frontend (separate terminal, with HMR)
cd web && npm run dev
```

The dashboard dev server runs on http://localhost:5173 and proxies `/api/*` to the backend on port 3000.

### Production

```bash
npm run build
cd web && npm run build && cd ..
node dist/cli/index.js start
```

The dashboard is served at http://localhost:3000 (or `ORCA_PORT`).

## Linear Integration

> Need the webhook tunnel? Follow the [Cloudflared Tunnel Setup](docs/cloudflared-setup.md) guide first.

1. Create a Linear API key at Settings > API > Personal API keys
2. Create a webhook at Settings > API > Webhooks pointing to `https://<ORCA_TUNNEL_HOSTNAME>/api/webhooks/linear`
3. Copy the webhook signing secret to `ORCA_LINEAR_WEBHOOK_SECRET`
4. Set `ORCA_LINEAR_PROJECT_IDS` to the UUIDs of projects you want to sync

Orca syncs issues on startup and stays updated via webhooks. If the tunnel goes down, it falls back to polling every 30 seconds.

## Testing

```bash
npm test
```

## License

MIT
