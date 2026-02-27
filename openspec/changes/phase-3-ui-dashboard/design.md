## Context

Orca currently runs as a headless CLI process. Monitoring requires SSH access and `orca status` commands. Phase 3 adds a web dashboard for real-time observability and lightweight task management (prompt editing, manual dispatch). The design builds on the existing Hono server started by `orca start`.

## Goals / Non-Goals

**Goals:**
- Real-time visibility into task status, session activity, and budget usage
- Edit agent prompts and manually dispatch tasks from the browser
- Stream scheduler events to the UI via SSE
- Zero-config: dashboard auto-starts with `orca start`

**Non-Goals:**
- Notifications (email, Slack, push) — deferred to a future phase
- Authentication / access control — dashboard is local/internal only
- Automated frontend tests — manual testing only in Phase 3
- Mobile-responsive layout — desktop-only for now

## Decisions

### Event Bus: Node.js EventEmitter
Use a single shared `EventEmitter` instance created in a new `src/events.ts` module. The scheduler emits events on dispatch, completion, and status changes. The SSE endpoint subscribes and streams. Chose EventEmitter over third-party pub/sub because it's zero-dependency, in-process, and sufficient for a single-server architecture.

### SSE over WebSockets
SSE is simpler — unidirectional server→client, native browser support via `EventSource`, no library needed. The dashboard only receives events; it never pushes data upstream. WebSockets would add unnecessary complexity.

### Frontend: React + Vite + Tailwind CSS
React for component model, Vite for fast dev iteration with HMR, Tailwind for utility-first styling without a component library. The SPA lives in `web/` at the project root with its own `package.json`. In production, Hono serves the built assets from `web/dist/`.

### API layer alongside existing webhook
All new endpoints mount under `/api/` on the same Hono app that already serves `/api/webhooks/linear`. A new `src/api/routes.ts` file exports a Hono sub-app that the CLI wires into the main app. This avoids a second server process.

### Manual dispatch implementation
`POST /api/tasks/:id/dispatch` reuses the scheduler's dispatch logic (create worktree, spawn session) but bypasses the tick loop. It validates that the task exists, has a prompt, and isn't already running before dispatching.

## Risks / Trade-offs

- **[SSE reconnection]** → Browsers auto-reconnect on `EventSource` close. The client re-fetches full state on reconnect to avoid missed events.
- **[Single EventEmitter]** → If the event listener throws, it could crash the emitter. Wrap all SSE listeners in try/catch.
- **[No auth]** → The dashboard is accessible to anyone who can reach the port. Acceptable for Phase 3 since Orca runs locally or behind a firewall. Future phase can add auth.
- **[Two package.jsons]** → The `web/` directory has its own dependencies. Operators need to run `npm install` in both root and `web/`. Could script this but keeping it explicit for now.
- **[Build step required]** → Production requires `npm run build` in `web/` before `orca start`. Dev mode uses Vite proxy. Document this in README.
