## MODIFIED Requirements

### Requirement: Start scheduler command
The CLI SHALL provide an `orca start` command that starts the scheduler loop as a foreground process. On startup, it SHALL initialize the Linear client and fetch workflow states, perform a full sync of Linear issues into the tasks table, start the Hono HTTP server on `ORCA_PORT` (with the webhook endpoint, REST API routes, SSE endpoint, and static file serving), and spawn the cloudflared tunnel. It SHALL log session events to the console.

#### Scenario: Scheduler starts with Linear integration
- **WHEN** user runs `orca start`
- **THEN** the system SHALL initialize the Linear client, run full sync, start the Hono server (with webhook, API, SSE, and static serving), spawn the cloudflared tunnel, and begin the scheduler loop, logging "Orca scheduler started (concurrency: N, interval: Xs)" to console

#### Scenario: Scheduler exits on SIGTERM
- **WHEN** the orca process receives SIGTERM
- **THEN** the scheduler SHALL stop dispatching, kill all running child processes, kill the cloudflared tunnel process, mark running invocations as interrupted, and exit cleanly

#### Scenario: Full sync runs before scheduler loop
- **WHEN** `orca start` is executed
- **THEN** the Linear full sync SHALL complete and the dependency graph SHALL be built before the first scheduler tick
