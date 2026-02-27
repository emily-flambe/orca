## ADDED Requirements

### Requirement: Static file serving in production
In production, Hono SHALL serve the contents of `web/dist/` as static files. Requests for files that exist in `web/dist/` SHALL return the file with appropriate content-type headers.

#### Scenario: Serve built asset
- **WHEN** a client requests `/assets/index-abc123.js`
- **THEN** Hono SHALL serve the file from `web/dist/assets/index-abc123.js` with content-type `application/javascript`

#### Scenario: Serve index.html
- **WHEN** a client requests `/`
- **THEN** Hono SHALL serve `web/dist/index.html`

### Requirement: SPA fallback routing
Any request that does not match an API route (`/api/*`) or a static file in `web/dist/` SHALL return `web/dist/index.html` so that client-side routing works.

#### Scenario: SPA route fallback
- **WHEN** a client requests `/tasks/PROJ-123` (a client-side route)
- **THEN** Hono SHALL serve `web/dist/index.html`

#### Scenario: API routes not affected
- **WHEN** a client requests `/api/tasks`
- **THEN** the request SHALL be handled by the API route handler, not the SPA fallback

### Requirement: Development proxy configuration
In development, the Vite dev server SHALL run on port 5173 with a proxy that forwards `/api/*` requests to the Hono server on port 3000.

#### Scenario: Dev proxy forwards API calls
- **WHEN** the Vite dev server receives a request for `/api/tasks`
- **THEN** Vite SHALL proxy the request to `http://localhost:3000/api/tasks`
