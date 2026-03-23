# E2E Testing

## Current Approach

The Playwright E2E tests (`e2e/dashboard.spec.ts`) start the Vite dev server but **not the backend**. All API responses are mocked via `page.route()` with static data.

This means the E2E suite verifies UI rendering and behavior in isolation, but cannot catch:

- Frontend/backend JSON contract mismatches (e.g., a renamed field)
- API endpoint regressions
- SSE stream format changes
- Authentication/authorization errors from the real server

## Known Limitation

The mocked E2E tests passed even if the backend were completely broken or if the API response shape changed incompatibly. This is a gap in test coverage.

## Follow-up Plan: Contract Testing

To catch frontend/backend contract mismatches without requiring a full integration environment, the recommended approach is **API contract testing**:

1. **Define API response schemas** using Zod (already used in the backend) and export them as a shared contract.
2. **Validate mock data against schemas** in E2E `beforeEach` hooks — if the mock doesn't match the schema, the test fails early.
3. **Validate real responses against schemas** in a dedicated integration test that starts the actual backend.

This gives confidence that mocks stay in sync with the real API without requiring a live backend in every E2E run.

### Longer-term: Integration E2E

For full contract assurance, add an integration E2E job to CI that:
1. Starts the backend (`npm run dev` or the built binary)
2. Starts the Vite dev server
3. Runs Playwright without mocks against `http://localhost:<port>`

This is tracked as a follow-up task.
