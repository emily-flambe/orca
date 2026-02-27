## ADDED Requirements

### Requirement: List all tasks
The system SHALL expose `GET /api/tasks` returning a JSON array of all tasks. Each task object SHALL include `id`, `linearIssueId`, `title`, `orcaStatus`, `priority`, `agentPrompt`, `createdAt`, and `updatedAt`.

#### Scenario: Fetch task list
- **WHEN** a client sends `GET /api/tasks`
- **THEN** the system SHALL respond with 200 and a JSON array of all tasks ordered by priority ascending then `createdAt` ascending

#### Scenario: Empty task list
- **WHEN** a client sends `GET /api/tasks` and no tasks exist
- **THEN** the system SHALL respond with 200 and an empty JSON array

### Requirement: Get task detail with invocation history
The system SHALL expose `GET /api/tasks/:id` returning a single task object with an `invocations` array. Each invocation SHALL include `id`, `status`, `startedAt`, `endedAt`, `costUsd`, `turnCount`, and `outputSummary`.

#### Scenario: Fetch existing task
- **WHEN** a client sends `GET /api/tasks/:id` with a valid task ID
- **THEN** the system SHALL respond with 200 and the task object including its invocation history sorted by `startedAt` descending

#### Scenario: Fetch nonexistent task
- **WHEN** a client sends `GET /api/tasks/:id` with an unknown ID
- **THEN** the system SHALL respond with 404 and `{ "error": "task not found" }`

### Requirement: Update agent prompt
The system SHALL expose `PUT /api/tasks/:id/prompt` accepting `{ "prompt": string }` in the request body. It SHALL update the task's `agentPrompt` field and return the updated task.

#### Scenario: Update prompt successfully
- **WHEN** a client sends `PUT /api/tasks/:id/prompt` with `{ "prompt": "new instructions" }`
- **THEN** the system SHALL update the task's `agentPrompt`, set `updatedAt` to the current time, and respond with 200 and the updated task

#### Scenario: Update prompt on nonexistent task
- **WHEN** a client sends `PUT /api/tasks/:id/prompt` with an unknown task ID
- **THEN** the system SHALL respond with 404 and `{ "error": "task not found" }`

#### Scenario: Update prompt with empty body
- **WHEN** a client sends `PUT /api/tasks/:id/prompt` without a `prompt` field
- **THEN** the system SHALL respond with 400 and `{ "error": "prompt is required" }`

### Requirement: Manual dispatch
The system SHALL expose `POST /api/tasks/:id/dispatch` that creates an invocation, creates a worktree, and spawns a session immediately, bypassing the scheduler tick loop. It SHALL return `{ "invocationId": string }`.

#### Scenario: Dispatch task successfully
- **WHEN** a client sends `POST /api/tasks/:id/dispatch` for a ready task with a prompt
- **THEN** the system SHALL create an invocation, dispatch the task, and respond with 200 and `{ "invocationId": "<id>" }`

#### Scenario: Dispatch already running task
- **WHEN** a client sends `POST /api/tasks/:id/dispatch` for a task that is already running
- **THEN** the system SHALL respond with 400 and `{ "error": "task is already running" }`

#### Scenario: Dispatch task without prompt
- **WHEN** a client sends `POST /api/tasks/:id/dispatch` for a task with no agent prompt
- **THEN** the system SHALL respond with 400 and `{ "error": "task has no agent prompt" }`

#### Scenario: Dispatch nonexistent task
- **WHEN** a client sends `POST /api/tasks/:id/dispatch` for an unknown task ID
- **THEN** the system SHALL respond with 404 and `{ "error": "task not found" }`

### Requirement: Orchestrator status
The system SHALL expose `GET /api/status` returning a JSON object with `activeSessions` (number), `activeTaskIds` (string array), `queuedTasks` (number), `costInWindow` (number), `budgetLimit` (number), and `budgetWindowHours` (number).

#### Scenario: Fetch orchestrator status
- **WHEN** a client sends `GET /api/status`
- **THEN** the system SHALL respond with 200 and the current orchestrator status including live session counts and budget usage

### Requirement: JSON error responses
All API error responses SHALL return a JSON body of `{ "error": string }` with an appropriate HTTP status code (400, 404, or 500).

#### Scenario: Internal server error
- **WHEN** an unexpected error occurs during request processing
- **THEN** the system SHALL respond with 500 and `{ "error": "internal server error" }`
