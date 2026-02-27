## MODIFIED Requirements

### Requirement: Start scheduler command
The CLI SHALL provide an `orca start` command that starts the scheduler loop as a foreground process. On startup, it SHALL initialize the Linear client and fetch workflow states, perform a full sync of Linear issues into the tasks table, start the Hono HTTP server on `ORCA_PORT` (with the webhook endpoint), and spawn the cloudflared tunnel. It SHALL log session events to the console.

#### Scenario: Scheduler starts with Linear integration
- **WHEN** user runs `orca start`
- **THEN** the system SHALL initialize the Linear client, run full sync, start the Hono server, spawn the cloudflared tunnel, and begin the scheduler loop, logging "Orca scheduler started (concurrency: N, interval: Xs)" to console

#### Scenario: Scheduler exits on SIGTERM
- **WHEN** the orca process receives SIGTERM
- **THEN** the scheduler SHALL stop dispatching, kill all running child processes, kill the cloudflared tunnel process, mark running invocations as interrupted, and exit cleanly

#### Scenario: Full sync runs before scheduler loop
- **WHEN** `orca start` is executed
- **THEN** the Linear full sync SHALL complete and the dependency graph SHALL be built before the first scheduler tick

## ADDED Requirements

### Requirement: Set agent prompt command
The CLI SHALL provide an `orca prompt <issueId> "<text>"` command that sets or updates the `agent_prompt` field for a task in the tasks table identified by its Linear issue ID. If no task exists with the given issue ID, the command SHALL exit with an error message.

#### Scenario: Set prompt on existing task
- **WHEN** user runs `orca prompt PROJ-123 "Fix the authentication bug in the login flow"`
- **THEN** the task with `linear_issue_id` matching PROJ-123 SHALL have its `agent_prompt` updated to the provided text

#### Scenario: Update existing prompt
- **WHEN** user runs `orca prompt PROJ-123 "Updated instructions"` on a task that already has an `agent_prompt`
- **THEN** the task's `agent_prompt` SHALL be overwritten with the new text

#### Scenario: Prompt set on nonexistent task
- **WHEN** user runs `orca prompt NONEXISTENT-99 "Some prompt"`
- **THEN** the CLI SHALL exit with an error message indicating no task exists with that issue ID
