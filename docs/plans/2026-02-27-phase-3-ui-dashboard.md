# Phase 3: UI Dashboard — Design

## Overview

Operational dashboard for Orca. React + Vite SPA served by Hono, with REST API endpoints and SSE for real-time updates. Tailwind CSS for styling. No notifications in this phase.

## Architecture

Frontend lives in `web/` at the project root, separate from the Node.js backend in `src/`. Vite handles dev-time HMR; in production, Hono serves the built static assets from `web/dist/`.

```
web/
  src/
    App.tsx
    components/
      TaskList.tsx
      TaskDetail.tsx
      OrchestratorBar.tsx
    hooks/
      useSSE.ts
      useApi.ts
    types.ts
  index.html
  vite.config.ts
  tailwind.config.ts
  package.json
```

## REST API

All endpoints under `/api/`, returning JSON. Hono serves these alongside the existing webhook endpoint.

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/tasks` | List all tasks (id, title, status, priority, prompt, timestamps) |
| `GET` | `/api/tasks/:id` | Task detail + invocation history |
| `PUT` | `/api/tasks/:id/prompt` | Update agent prompt. Body: `{ prompt: string }` |
| `POST` | `/api/tasks/:id/dispatch` | Manual dispatch, bypassing scheduler. Returns `{ invocationId }` |
| `GET` | `/api/status` | Orchestrator bar data (active sessions, queue count, budget) |
| `GET` | `/api/events` | SSE stream of scheduler events |

### Error responses

All errors return `{ error: string }` with appropriate HTTP status codes.

### Manual dispatch (`POST /api/tasks/:id/dispatch`)

Creates an invocation, creates worktree, spawns session immediately. Fails with 400 if task is already running or has no agent prompt. Fails with 404 if task not found.

## SSE Events

`GET /api/events` streams newline-delimited server-sent events. Event types:

| Event | Payload | When |
|---|---|---|
| `task:updated` | Task object | Any task status change |
| `invocation:started` | `{ taskId, invocationId }` | New session spawned |
| `invocation:completed` | `{ taskId, invocationId, status, costUsd }` | Session finished |
| `status:updated` | Status object (same as GET /api/status) | Budget/count changes |

The backend uses a Node.js EventEmitter. The scheduler hooks into it to emit events on dispatch, completion, and status changes. The SSE endpoint subscribes to this emitter and streams to connected clients.

## Frontend Components

### OrchestratorBar (top, always visible)

- Cost budget gauge: progress bar showing `$X.XX / $Y.YY` with color gradient (green → yellow → red)
- Active sessions count with pulsing dot
- Queued tasks count
- Compact horizontal layout

### TaskList (left panel, ~40% width)

- Each row: priority dot (color-coded), issue ID, truncated title, status badge (colored pill)
- Status filter: all / ready / running / done / failed
- Sort by priority, status, or creation date
- Click row to select → opens detail panel
- Highlighted row for selected task

Priority colors: red = urgent (1), orange = high (2), blue = normal (3), gray = low (4), none = no priority (0)

Status badge colors: green = done, blue = running, yellow = ready, red = failed, gray = dispatched

### TaskDetail (right panel, ~60% width)

- Header: issue ID + title + status badge
- Agent prompt: editable textarea + "Save" button → `PUT /api/tasks/:id/prompt`
- "Dispatch Now" button → `POST /api/tasks/:id/dispatch`, disabled when running or no prompt
- Invocation history: table with columns — date, duration, status, cost, turns, summary

### Data Fetching

`fetch` to REST API on mount. SSE hook (`useSSE`) listens for events and triggers selective re-fetches.

## Hono Static File Serving

In production, Hono serves `web/dist/` as static files. SPA fallback: any non-API route returns `index.html` so client-side routing works.

In development, Vite dev server runs on port 5173 with a proxy to Hono on port 3000 for API calls.

## Testing Strategy

- API endpoint tests using Hono's `app.request()` with in-memory SQLite
- SSE endpoint test: verify event stream format
- Frontend: manual testing (no automated component tests in Phase 3)
