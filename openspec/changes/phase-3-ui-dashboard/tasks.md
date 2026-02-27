## 1. Event Bus

- [x] 1.1 Create `src/events.ts` with a shared EventEmitter instance and typed event helpers (`emitTaskUpdated`, `emitInvocationStarted`, `emitInvocationCompleted`, `emitStatusUpdated`)
- [x] 1.2 Hook the event bus into the scheduler: emit `task:updated` on dispatch, `invocation:started` on session spawn, `invocation:completed` on session finish, `status:updated` on budget/count changes

## 2. REST API

- [x] 2.1 Create `src/api/routes.ts` exporting a Hono sub-app with all API endpoints
- [x] 2.2 Implement `GET /api/tasks` — return all tasks ordered by priority then createdAt
- [x] 2.3 Implement `GET /api/tasks/:id` — return task with invocation history, 404 if not found
- [x] 2.4 Implement `PUT /api/tasks/:id/prompt` — update agent prompt, validate body, 404 if not found
- [x] 2.5 Implement `POST /api/tasks/:id/dispatch` — manual dispatch bypassing scheduler, validate preconditions (exists, has prompt, not running)
- [x] 2.6 Implement `GET /api/status` — return active sessions, queued count, budget info
- [x] 2.7 Add `getInvocationsForTask` query to `src/db/queries.ts`

## 3. SSE Endpoint

- [x] 3.1 Implement `GET /api/events` SSE endpoint in `src/api/routes.ts` — subscribe to event bus, stream events, clean up on disconnect

## 4. Static File Serving

- [x] 4.1 Add Hono static file middleware serving `web/dist/` and SPA fallback (non-API routes return `index.html`)

## 5. CLI Integration

- [x] 5.1 Update `orca start` in `src/cli/index.ts` to mount API routes, pass event bus and dispatch dependencies to the API sub-app

## 6. Frontend Setup

- [x] 6.1 Initialize `web/` directory: `package.json`, `vite.config.ts`, `tailwind.config.ts`, `index.html`, `tsconfig.json`
- [x] 6.2 Configure Vite dev proxy to forward `/api/*` to `http://localhost:3000`
- [x] 6.3 Create `web/src/types.ts` with shared TypeScript types (Task, Invocation, Status)

## 7. Frontend Hooks

- [x] 7.1 Create `web/src/hooks/useApi.ts` — fetch wrapper for REST API calls
- [x] 7.2 Create `web/src/hooks/useSSE.ts` — EventSource hook that listens for events and calls update callbacks

## 8. Frontend Components

- [x] 8.1 Create `web/src/App.tsx` — main layout with OrchestratorBar on top and TaskList/TaskDetail side by side
- [x] 8.2 Create `web/src/components/OrchestratorBar.tsx` — budget gauge, active session count with pulsing dot, queued count
- [x] 8.3 Create `web/src/components/TaskList.tsx` — task rows with priority dot, issue ID, title, status badge; status filter and sort controls; row selection
- [x] 8.4 Create `web/src/components/TaskDetail.tsx` — header with issue ID/title/status, editable prompt textarea with Save button, Dispatch Now button (disabled when running or no prompt), invocation history table

## 9. API Tests

- [x] 9.1 Write tests for `GET /api/tasks` and `GET /api/tasks/:id` using Hono's `app.request()` with in-memory SQLite
- [x] 9.2 Write tests for `PUT /api/tasks/:id/prompt` (success, missing task, empty body)
- [x] 9.3 Write tests for `POST /api/tasks/:id/dispatch` (success, already running, no prompt, not found)
- [x] 9.4 Write tests for `GET /api/status`
- [x] 9.5 Write test for `GET /api/events` SSE stream format
