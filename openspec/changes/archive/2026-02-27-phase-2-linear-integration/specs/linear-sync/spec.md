## ADDED Requirements

### Requirement: Full sync on startup
The sync module SHALL perform a full sync on startup by fetching all issues from configured projects via the Linear client and upserting them into the tasks table. For each issue, the sync SHALL map the Linear state type to an Orca status and store the issue's `id`, `identifier`, `title`, `priority`, and state information. If a task record does not already exist, it SHALL be created with an empty `agent_prompt`.

#### Scenario: New issues synced on startup
- **WHEN** the full sync runs and Linear contains 15 issues not yet in the tasks table
- **THEN** all 15 issues SHALL be inserted into the tasks table with empty `agent_prompt` values

#### Scenario: Existing issues updated on startup
- **WHEN** the full sync runs and a task already exists in the database for a Linear issue
- **THEN** the task record SHALL be updated with the current Linear state, priority, and title

### Requirement: Incremental sync via webhook events
The sync module SHALL process webhook events to update individual tasks in the database. On receiving an issue create event, the sync module SHALL insert a new task. On an update event, the sync module SHALL update the existing task's fields. On a remove event, the sync module SHALL mark the task as failed permanently.

#### Scenario: New issue created via webhook
- **WHEN** a webhook delivers an issue create event for a configured project
- **THEN** the sync module SHALL insert a new task with the issue's fields and an empty `agent_prompt`

#### Scenario: Issue updated via webhook
- **WHEN** a webhook delivers an issue update event with a changed priority
- **THEN** the sync module SHALL update the corresponding task's priority in the database

#### Scenario: Issue removed via webhook
- **WHEN** a webhook delivers an issue remove event
- **THEN** the sync module SHALL set the task's `orca_status` to "failed" permanently

### Requirement: Conflict resolution — Linear always wins
When a webhook indicates a Linear state change that conflicts with the current Orca status, the sync module SHALL resolve the conflict in favor of Linear's state. The following conflict resolution rules SHALL apply:

- Running task moved to unstarted in Linear: kill the active session, mark the invocation as "failed" with summary "interrupted by Linear state change", and reset the task to "ready".
- Ready task moved to completed in Linear: set the task's `orca_status` to "done".
- Done task moved to unstarted in Linear: reset the task's `orca_status` to "ready" (eligible for re-dispatch).
- Any task moved to canceled in Linear: set the task's `orca_status` to "failed" permanently (skip retry).

#### Scenario: Running task moved to unstarted in Linear
- **WHEN** a webhook indicates a running task's Linear state changed to type "unstarted"
- **THEN** the sync module SHALL kill the active session, mark the invocation as "failed" with summary "interrupted by Linear state change", and reset the task to "ready"

#### Scenario: Ready task moved to completed in Linear
- **WHEN** a webhook indicates a ready task's Linear state changed to type "completed"
- **THEN** the sync module SHALL set the task's `orca_status` to "done"

#### Scenario: Done task moved to unstarted in Linear
- **WHEN** a webhook indicates a done task's Linear state changed to type "unstarted"
- **THEN** the sync module SHALL reset the task's `orca_status` to "ready"

#### Scenario: Any task moved to canceled in Linear
- **WHEN** a webhook indicates any task's Linear state changed to type "canceled"
- **THEN** the sync module SHALL set the task's `orca_status` to "failed" permanently, bypassing retry logic

### Requirement: Write-back on Orca state transitions
When Orca transitions a task's status, the sync module SHALL update the corresponding Linear issue's workflow state using the cached state type to UUID mapping. The following mappings SHALL apply:

| Orca transition | Linear state type target |
|---|---|
| ready to dispatched | started |
| running to done | completed |
| running to failed (permanent) | canceled |
| failed to ready (retry) | unstarted |

Write-back failures SHALL be logged but SHALL NOT block Orca's internal state transition.

#### Scenario: Task dispatched triggers Linear write-back
- **WHEN** Orca transitions a task from "ready" to "dispatched"
- **THEN** the sync module SHALL update the Linear issue's state to the "started" workflow state

#### Scenario: Task completed triggers Linear write-back
- **WHEN** Orca transitions a task from "running" to "done"
- **THEN** the sync module SHALL update the Linear issue's state to the "completed" workflow state

#### Scenario: Task permanently failed triggers Linear write-back
- **WHEN** Orca transitions a task from "running" to "failed" permanently (max retries exhausted)
- **THEN** the sync module SHALL update the Linear issue's state to the "canceled" workflow state

#### Scenario: Task retried triggers Linear write-back
- **WHEN** Orca transitions a task from "failed" to "ready" (retry)
- **THEN** the sync module SHALL update the Linear issue's state to the "unstarted" workflow state

#### Scenario: Write-back failure does not block Orca
- **WHEN** a Linear write-back request fails
- **THEN** the error SHALL be logged and Orca's internal state transition SHALL proceed normally

### Requirement: Write-back loop prevention
When Orca writes a state change to Linear, it SHALL store the (taskId, expectedStateType) in an expected-change set with a 10-second TTL. When a webhook arrives that matches an entry in the expected-change set, the sync module SHALL treat it as an echo and skip processing. Expired entries SHALL be removed from the set.

#### Scenario: Echo webhook skipped
- **WHEN** Orca writes a "completed" state to Linear for task T1 and a webhook arrives within 10 seconds confirming that state change
- **THEN** the sync module SHALL skip processing the webhook for task T1

#### Scenario: Non-echo webhook processed
- **WHEN** a webhook arrives for task T1 with a state change that does not match any entry in the expected-change set
- **THEN** the sync module SHALL process the webhook normally

#### Scenario: Expired expected-change entry
- **WHEN** Orca writes a state change for task T1 and a matching webhook arrives after 10 seconds
- **THEN** the expected-change entry SHALL have expired and the webhook SHALL be processed normally

### Requirement: Polling fallback when tunnel is down
The sync module SHALL poll Linear every 30 seconds for issues updated since the last sync when the tunnel health check reports the tunnel is down. The poll SHALL use the `updatedAt` filter to fetch only changed issues. When the tunnel recovers, polling SHALL stop.

#### Scenario: Polling activates on tunnel failure
- **WHEN** the tunnel health check reports the tunnel is down
- **THEN** the sync module SHALL begin polling Linear every 30 seconds using the `updatedAt` filter

#### Scenario: Polling deactivates on tunnel recovery
- **WHEN** the tunnel health check reports the tunnel has recovered
- **THEN** the sync module SHALL stop polling

#### Scenario: Poll fetches only recent changes
- **WHEN** a poll executes and the last sync was at time T
- **THEN** the query SHALL filter issues with `updatedAt` greater than T

### Requirement: Tasks with empty agent_prompt not dispatched
Tasks synced from Linear with an empty `agent_prompt` SHALL NOT be dispatched by the scheduler. They SHALL remain in the task queue until a prompt is set via the `orca prompt` CLI command.

#### Scenario: Synced task without prompt not dispatched
- **WHEN** a task is synced from Linear with an empty `agent_prompt` and the scheduler ticks
- **THEN** the scheduler SHALL skip the task and not dispatch it

#### Scenario: Synced task dispatched after prompt set
- **WHEN** a user sets an `agent_prompt` on a previously promptless task via `orca prompt`
- **THEN** the task SHALL become eligible for dispatch on the next scheduler tick
