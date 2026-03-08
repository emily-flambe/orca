# Contributing to Orca

Orca is a Claude Code orchestrator that runs agents against Linear issues. This guide covers setup, testing, and submitting changes.

## Prerequisites

- Node.js 20+
- [Claude Code](https://docs.anthropic.com/claude-code) CLI installed and authenticated
- A Linear account with API access (for integration testing)
- [cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/) (for tunnel features)

## Local Setup

```bash
git clone https://github.com/your-org/orca.git
cd orca
npm install
cp .env.example .env
```

Edit `.env` and fill in at minimum `ORCA_LINEAR_API_KEY` and `ORCA_LINEAR_PROJECT_IDS`. See `.env.example` for all options and their defaults.

## Running in Dev Mode

```bash
npm run dev
```

This runs the CLI via `tsx` without compiling. The server starts on port 3000 by default.

## Running Tests

```bash
npm test
```

Tests use [Vitest](https://vitest.dev/). Test files live in `test/`.

## Building

```bash
npm run build
```

Compiles TypeScript via `tsup`. Must succeed with no errors before submitting a PR.

## Database Migrations

If you change the schema:

```bash
npm run db:generate   # generate migration files
npm run db:migrate    # apply migrations to local orca.db
```

## Project Structure

```
src/
  api/          HTTP server (Hono), webhook handlers
  cli/          Entry point and CLI commands
  config/       Env-var config loading
  db/           Drizzle ORM schema and queries
  git/          Git and worktree operations
  github/       GitHub API client
  linear/       Linear API client and webhook parsing
  runner/       Claude Code session execution
  scheduler/    Dispatch loop and concurrency control
  tunnel/       cloudflared tunnel management
  worktree/     Git worktree lifecycle
web/
  src/          React frontend (Vite + Tailwind)
test/           Vitest test files
```

## Code Style

- TypeScript strict mode is enforced — no `any`, no implicit returns
- Follow the naming and structure conventions of existing modules
- Prefer editing existing files over creating new abstractions
- Keep changes minimal and focused on the task

## Submitting a PR

1. Fork and create a branch from `main`
2. Make your changes
3. Run `npm test` — all tests must pass
4. Run `npm run build` — must compile cleanly
5. Open a PR with a clear description of what changed and why

PRs that fail type-checking or tests will not be merged. Describe the motivation for your change, not just what files you touched.
