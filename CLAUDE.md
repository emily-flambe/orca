# Orca — Project Instructions

## Creating Linear Issues

When creating Linear issues via MCP, always reference `docs/linear_issue_templates.md` and apply the appropriate template structure based on issue type (Feature Implementation, Bug Fix, Refactor, Feature Planning, or Discovery). Fill in all sections with real content — never leave placeholder text in the final issue.

## Deploying Changes

After committing and pushing changes to main, **always deploy using the single deploy script**. Never ask the user to do it.

### How to deploy

```bash
bash /c/Users/emily/Documents/Github/orca/scripts/deploy.sh
```

This script handles everything: pull, install, frontend rebuild, kill old process, start new process with log redirection to `orca.log`.

**Do NOT start Orca manually** — always use `scripts/deploy.sh` to ensure consistent behavior.

### When to deploy

- After any backend change (`src/**/*.ts`)
- After rebuilding the frontend (`web/dist/` changed)
- After modifying `.env` or config
