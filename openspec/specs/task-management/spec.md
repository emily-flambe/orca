## ADDED Requirements

### Requirement: Task storage in SQLite
The system SHALL store tasks in a SQLite database with the following fields: `linear_issue_id` (PK, text), `agent_prompt` (text), `repo_path` (text), `orca_status` (text enum), `priority` (integer 0-4), `retry_count` (integer), `created_at` (timestamp), `updated_at` (timestamp).

#### Scenario: Task is created with required fields
- **WHEN** a task is inserted with `linear_issue_id`, `agent_prompt`, and `repo_path`
- **THEN** the task SHALL be stored with `orca_status` = "ready", `priority` = 0, `retry_count` = 0, and timestamps set to current time

### Requirement: Task status lifecycle
The system SHALL enforce this status lifecycle: ready → dispatched → running → done | failed. Status transitions outside this flow SHALL be rejected.

#### Scenario: Valid status transition
- **WHEN** a task with `orca_status` = "ready" is transitioned to "dispatched"
- **THEN** the transition SHALL succeed and `updated_at` SHALL be set to current time

#### Scenario: Invalid status transition
- **WHEN** a task with `orca_status` = "ready" is transitioned directly to "done"
- **THEN** the transition SHALL be rejected with an error

### Requirement: Invocation tracking
The system SHALL store invocations in a SQLite table with: `id` (PK, auto-increment), `linear_issue_id` (FK), `started_at`, `ended_at`, `status` (running / completed / failed / timed_out), `session_id` (text), `branch_name` (text), `worktree_path` (text), `cost_usd` (real), `num_turns` (integer), `output_summary` (text), `log_path` (text).

#### Scenario: Invocation is created when task is dispatched
- **WHEN** the scheduler dispatches a task
- **THEN** an invocation record SHALL be created with `status` = "running", `started_at` = current time, and the task's `linear_issue_id`

### Requirement: Budget event tracking
The system SHALL store budget events in a table with: `id` (PK), `invocation_id` (FK), `cost_usd` (real), `recorded_at` (timestamp).

#### Scenario: Budget event recorded on session completion
- **WHEN** a session completes (success or failure) and reports a `total_cost_usd`
- **THEN** a budget event SHALL be recorded with the cost and linked to the invocation

### Requirement: Retry count tracking
The system SHALL increment `retry_count` on a task each time it transitions from "failed" back to "ready" for re-dispatch.

#### Scenario: Task retried after failure
- **WHEN** a task fails and is eligible for retry
- **THEN** `retry_count` SHALL be incremented by 1 and `orca_status` set to "ready"
