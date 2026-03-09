# Orca — Project Instructions

## Creating Linear Issues

When creating Linear issues via MCP, always reference `docs/linear_issue_templates.md` and apply the appropriate template structure based on issue type (Feature Implementation, Bug Fix, Refactor, Feature Planning, or Discovery). Fill in all sections with real content — never leave placeholder text in the final issue.

## Deploying Changes

After committing and pushing changes to main, **always deploy using the single deploy script**. Never ask the user to do it.

### How to deploy

```bash
bash /c/Users/emily/Documents/Github/orca/scripts/deploy.sh
```

This script uses blue/green deployment: starts a new instance on a standby port, health checks it, switches the Cloudflare tunnel, drains the old instance, then kills it. Zero downtime. Port alternates between 4000/4001 across deploys (tracked in `deploy-state.json`).

**Do NOT start Orca manually** — always use `scripts/deploy.sh` to ensure consistent behavior.

### When to deploy

- After any backend change (`src/**/*.ts`)
- After rebuilding the frontend (`web/dist/` changed)
- After modifying `.env` or config
