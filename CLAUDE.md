# Orca — Project Instructions

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
