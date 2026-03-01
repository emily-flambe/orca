# Orca — Project Instructions

## Deploying Changes

After committing and pushing changes to main, **always restart Orca yourself**. Never ask the user to do it.

### How to restart

```bash
# Kill existing Orca process
wmic process where "name='node.exe' and CommandLine like '%orca%start%'" get ProcessId 2>/dev/null \
  | grep -oE '[0-9]+' \
  | while read -r pid; do taskkill //PID "$pid" //F 2>/dev/null || true; done

sleep 2

# Start Orca in background
cd /c/Users/emily/Documents/Github/orca
npx tsx src/cli/index.ts start &
disown
```

Or use `scripts/deploy.sh` if you also need to pull and rebuild.

### When to restart

- After any backend change (`src/**/*.ts`)
- After rebuilding the frontend (`web/dist/` changed)
- After modifying `.env` or config
