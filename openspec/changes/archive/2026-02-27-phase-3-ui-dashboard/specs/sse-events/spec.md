## ADDED Requirements

### Requirement: SSE event stream endpoint
The system SHALL expose `GET /api/events` as a Server-Sent Events endpoint. The response SHALL use content-type `text/event-stream` and keep the connection open, streaming events as they occur.

#### Scenario: Client connects to SSE stream
- **WHEN** a client sends `GET /api/events`
- **THEN** the system SHALL respond with 200, content-type `text/event-stream`, and keep the connection open

#### Scenario: Client disconnects
- **WHEN** a connected SSE client closes the connection
- **THEN** the system SHALL clean up the event listener for that client without affecting other connected clients

### Requirement: Task updated event
The system SHALL emit a `task:updated` SSE event whenever a task's status changes. The event data SHALL be the full task object as JSON.

#### Scenario: Task status changes
- **WHEN** a task transitions from "ready" to "dispatched"
- **THEN** the system SHALL send an SSE event with type `task:updated` and the full task object as JSON data

### Requirement: Invocation started event
The system SHALL emit an `invocation:started` SSE event when a new session is spawned. The event data SHALL include `taskId` and `invocationId`.

#### Scenario: Session spawned
- **WHEN** the scheduler or manual dispatch spawns a new session
- **THEN** the system SHALL send an SSE event with type `invocation:started` and data `{ "taskId": "<id>", "invocationId": "<id>" }`

### Requirement: Invocation completed event
The system SHALL emit an `invocation:completed` SSE event when a session finishes. The event data SHALL include `taskId`, `invocationId`, `status`, and `costUsd`.

#### Scenario: Session completes
- **WHEN** a session finishes (success or failure)
- **THEN** the system SHALL send an SSE event with type `invocation:completed` and data `{ "taskId": "<id>", "invocationId": "<id>", "status": "<status>", "costUsd": <number> }`

### Requirement: Status updated event
The system SHALL emit a `status:updated` SSE event when budget or active session counts change. The event data SHALL match the `GET /api/status` response format.

#### Scenario: Budget changes
- **WHEN** a session completes and cost is recorded
- **THEN** the system SHALL send an SSE event with type `status:updated` and the current status object

### Requirement: Shared event emitter
The system SHALL use a shared Node.js EventEmitter instance for internal event routing. The scheduler SHALL emit events on this emitter, and the SSE endpoint SHALL subscribe to it for streaming to clients.

#### Scenario: Event flows from scheduler to SSE
- **WHEN** the scheduler dispatches a task
- **THEN** the event emitter SHALL emit the event, and all connected SSE clients SHALL receive it
