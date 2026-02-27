## MODIFIED Requirements

### Requirement: Task storage in SQLite
The system SHALL store tasks in a SQLite database with the following fields: `linear_issue_id` (PK, text), `agent_prompt` (text), `repo_path` (text), `orca_status` (text enum), `priority` (integer 0-4), `retry_count` (integer), `created_at` (timestamp), `updated_at` (timestamp). The `agent_prompt` field MAY be empty for tasks created via Linear sync. Tasks with an empty `agent_prompt` SHALL NOT be dispatched by the scheduler.

#### Scenario: Task is created with required fields
- **WHEN** a task is inserted with `linear_issue_id`, `agent_prompt`, and `repo_path`
- **THEN** the task SHALL be stored with `orca_status` = "ready", `priority` = 0, `retry_count` = 0, and timestamps set to current time

#### Scenario: Task created from Linear sync with empty prompt
- **WHEN** a task is created via Linear sync without a user-provided prompt
- **THEN** the task SHALL be stored with an empty `agent_prompt` and SHALL NOT be eligible for dispatch

## ADDED Requirements

### Requirement: Tasks with empty agent_prompt excluded from dispatch
Tasks with an empty or null `agent_prompt` SHALL NOT be dispatched by the scheduler. The task selection query SHALL exclude tasks where `agent_prompt` is empty or null, regardless of their `orca_status`, priority, or dependency state.

#### Scenario: Empty prompt task excluded from ready tasks query
- **WHEN** the scheduler queries for dispatchable ready tasks
- **THEN** tasks with an empty `agent_prompt` SHALL NOT appear in the results

#### Scenario: Task becomes dispatchable after prompt is set
- **WHEN** a task with an empty `agent_prompt` has its prompt set via `orca prompt`
- **THEN** the task SHALL appear in subsequent ready tasks queries and be eligible for dispatch
