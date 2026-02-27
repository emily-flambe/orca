## Why

Orca has no visibility into what it's doing at runtime. Operators must SSH in and run CLI commands to check task status, budget usage, and session activity. A web dashboard provides real-time observability and the ability to edit prompts and manually dispatch tasks without touching the terminal.

## What Changes

- Add REST API endpoints under `/api/` for tasks, status, and manual dispatch
- Add SSE endpoint (`/api/events`) streaming scheduler events to connected browsers
- Add an EventEmitter-based event bus that the scheduler hooks into
- Build a React + Vite SPA (in `web/`) with Tailwind CSS showing task list, task detail, orchestrator status bar
- Serve the built SPA from Hono in production; proxy in development
- Add editable agent prompt and manual dispatch button to the task detail view

## Capabilities

### New Capabilities
- `rest-api`: Hono REST endpoints for listing tasks, task detail with invocation history, updating agent prompts, manual dispatch, and orchestrator status
- `sse-events`: Server-Sent Events stream broadcasting task updates, invocation lifecycle, and status changes via a shared EventEmitter
- `dashboard-ui`: React SPA with OrchestratorBar (budget gauge, active/queued counts), TaskList (filterable, sortable), and TaskDetail (prompt editing, dispatch, invocation history)
- `static-serving`: Hono middleware serving `web/dist/` static assets with SPA fallback for client-side routing

### Modified Capabilities
- `cli`: `orca start` wires up the API routes, event bus, and static file serving alongside the existing webhook route

## Impact

- New `web/` directory at project root with its own `package.json`, Vite config, and Tailwind config
- New source files in `src/` for API routes, SSE handler, and event emitter
- `src/cli/index.ts` modified to mount API routes and static serving on the existing Hono app
- `src/scheduler/index.ts` modified to emit events on dispatch, completion, and status changes
- New dev dependencies: react, react-dom, vite, tailwindcss, @vitejs/plugin-react
- New runtime dependency: hono static file middleware (built-in to hono)
