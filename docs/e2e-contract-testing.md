# E2E Testing Limitations and Contract Testing Plan

## Current Limitation: Mocked API Responses

The E2E test suite (`e2e/dashboard.spec.ts`) starts the Vite dev server but does **not** start the backend server. All API responses are mocked with static data using Playwright's `page.route()`:

- `/api/tasks` — static mock task list
- `/api/status` — static mock scheduler status
- `/api/metrics` — static mock metrics data
- `/api/invocations/running` — empty array
- `/api/events` — immediate keepalive SSE stream

**Consequence:** E2E tests cannot catch frontend/backend contract mismatches. If a backend response field is renamed, removed, or its type changes, the E2E tests still pass because they never talk to the real backend.

## Why This Is a Problem

Frontend components consume API response shapes directly. When those shapes diverge from what the backend actually returns:

- The dashboard silently renders `undefined` for missing fields
- New backend fields are never shown in the UI until someone notices
- Refactors that rename fields break production but pass CI

The current setup makes it impossible to detect these mismatches in CI.

## Follow-up Plan: Contract Testing

### Option A: Integration E2E (Start real backend)

Start the Orca backend in test mode alongside Vite in E2E tests:

- Launch the Hono server against a test SQLite DB (no Linear/Inngest)
- Seed fixture tasks and invocations before each test
- Remove `page.route()` mocks and point Playwright at real API responses
- Verify UI renders data from actual backend responses

Requires: test mode flag in server startup, fixture seeding helpers, CI service coordination between Vite and the backend process.

### Option B: API Contract Tests (Shared TypeScript types)

Extract API response shapes as TypeScript types shared between frontend and backend:

- Define canonical response types in a shared module (e.g., `src/api/types.ts`)
- Import those types in both the Hono route handlers and the React components
- Add type-level tests that assert the backend response objects satisfy the shared types
- TypeScript compiler enforces the contract at build time

Requires: shared type module, consistent import paths, incremental adoption across all endpoints.

### Option C (Recommended near-term): Backend tests that verify response shapes match frontend mocks

Add `test/api-contracts.test.ts` backend tests that verify every API endpoint returns the exact shape the frontend mocks expect:

- For each mocked route in `e2e/dashboard.spec.ts`, write a Hono test that calls the real handler
- Assert every field present in the E2E mock also exists in the real response with the correct type
- These run in the existing Vitest suite with no extra infrastructure

This is the lowest-friction path: no new packages, no process coordination, integrates into `npm test`.

## Current Mitigation

`test/api-contracts.test.ts` already exists as a partial implementation of Option C. It covers the following endpoints with response shape assertions:

- `GET /api/tasks` — array of task objects with required fields
- `GET /api/tasks/:id` — task detail with invocations array
- `GET /api/invocations/running` — array with `agentPrompt` field
- `GET /api/invocations/:id/logs` — `{ lines: any[] }` shape
- `POST /api/invocations/:id/abort` — `{ ok: true }` on success
- `POST /api/tasks/:id/status` — `{ ok: true }` on success
- `POST /api/tasks/:id/retry` — `{ ok: true }` on success
- `POST /api/sync` — `{ synced: number }` shape
- `GET /api/status` — all required dashboard fields with correct types
- `POST /api/config` — `{ ok: true, concurrencyCap, model, reviewModel }` shape
- `GET /api/metrics` — full metrics object with all nested fields
- `GET /api/logs` — `{ lines, total, sizeBytes }` shape
- `GET /api/projects` — array of `{ id, name }` objects
- `POST /api/tasks` — `{ identifier, id }` on success
- `GET /api/invocations/:id/logs/stream` — SSE stream with correct content-type
- `GET /api/events` — SSE stream with correct content-type
