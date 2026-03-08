# Contributing to Orca

Thank you for your interest in contributing to Orca.

## Getting Started

### Prerequisites

- Node.js 20+
- Git
- The `claude` CLI installed and authenticated (`npm install -g @anthropic-ai/claude-code`)
- `cloudflared` installed and available on PATH

### Setup

```bash
git clone https://github.com/emily-cogsdill/orca.git
cd orca
npm install
cp .env.example .env
# Edit .env with your Linear API key and other required values
```

### Running in Development

```bash
# Backend (with hot reload via tsx)
npm run dev start

# Frontend dashboard (port 5173)
cd web && npm install && npm run dev
```

### Running Tests

```bash
npm test
```

All tests use in-memory SQLite — no external services required.

### Building

```bash
npm run build        # Backend → dist/
cd web && npm run build  # Frontend → web/dist/
```

## Project Structure

- `src/` — Backend TypeScript source
- `web/` — React dashboard (separate `package.json`)
- `test/` — Vitest tests
- `docs/` — Architecture and setup docs

See `PROMPT.md` for a detailed module map, schema reference, and conventions.

## Code Conventions

**ESM — all imports use `.js` extension:**
```typescript
// Correct
import { getTask } from "../db/queries.js";

// Wrong — fails at runtime
import { getTask } from "../db/queries";
```

**Type-only imports:**
```typescript
import type { OrcaConfig } from "../config/index.js";
```

**Named exports only** in the backend. Default exports for React components in `web/`.

**No inline SQL.** All queries go through Drizzle ORM in `src/db/queries.ts`.

**No CommonJS.** This is an ESM project throughout.

## Submitting Changes

1. Fork the repo and create a branch: `git checkout -b your-feature`
2. Make your changes and add tests for new behavior
3. Run `npm test` and `npx tsc --noEmit` — both must pass
4. Run `cd web && npx tsc --noEmit` if you changed the frontend
5. Open a pull request with a clear description of what and why

## Reporting Issues

Open a GitHub issue with:
- What you expected to happen
- What actually happened
- Steps to reproduce
- Orca version and OS
