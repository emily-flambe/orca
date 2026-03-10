# Testing

## Before Committing

Always run these checks — CI will catch failures, but catching them locally is faster:

```bash
npx tsc --noEmit          # Type check
npm run lint              # ESLint
npm run format:check      # Prettier (run `npm run format` to auto-fix)
npm test                  # Backend vitest
cd web && npm test        # Frontend vitest
```

## Test Structure

- **Backend tests:** `test/*.test.ts` — 18+ test files covering scheduler, DB, API, Linear integration, deploy, CI gate, cleanup, worktree, prompt injection, etc.
- **Frontend tests:** `web/src/components/__tests__/*.test.tsx` — component tests with @testing-library/react
- **E2E tests:** Playwright (`npm run test:e2e`) — Chromium only

## CI Pipeline (`.github/workflows/ci.yml`)

Three parallel jobs:
1. **test**: tsc, eslint, prettier, vitest
2. **frontend**: web vitest, web build, bundle size guard (500 KB)
3. **e2e**: playwright

All three must pass for PR merge.
