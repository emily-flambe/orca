## ADDED Requirements

### Requirement: Add task command
The CLI SHALL provide an `orca add` command that creates a new task. Required flags: `--prompt` (agent prompt text) and `--repo` (path to git repo). Optional flags: `--priority` (0-4, default 0), `--id` (custom task ID, auto-generated if omitted).

#### Scenario: Add task with required flags
- **WHEN** user runs `orca add --prompt "Fix the auth bug" --repo /home/user/myapp`
- **THEN** a task SHALL be inserted into SQLite with the given prompt, repo path, `orca_status` = "ready", and a generated task ID

#### Scenario: Add task with priority
- **WHEN** user runs `orca add --prompt "Urgent fix" --repo /home/user/myapp --priority 1`
- **THEN** the task SHALL be created with `priority` = 1

#### Scenario: Missing required flag
- **WHEN** user runs `orca add --prompt "Fix bug"` without `--repo`
- **THEN** the CLI SHALL exit with an error message indicating `--repo` is required

### Requirement: Start scheduler command
The CLI SHALL provide an `orca start` command that starts the scheduler loop as a foreground process. It SHALL log session events to the console.

#### Scenario: Scheduler starts
- **WHEN** user runs `orca start`
- **THEN** the scheduler loop SHALL begin, logging "Orca scheduler started (concurrency: N, interval: Xs)" to console

#### Scenario: Scheduler exits on SIGTERM
- **WHEN** the orca process receives SIGTERM
- **THEN** the scheduler SHALL stop dispatching, kill all running child processes, mark their invocations as interrupted, and exit cleanly

### Requirement: Status command
The CLI SHALL provide an `orca status` command that displays current scheduler state: active sessions (count + task IDs), queued tasks (count), budget usage (cost in current window / max), and failed tasks (count).

#### Scenario: Status with active sessions
- **WHEN** user runs `orca status` while 2 sessions are running
- **THEN** the CLI SHALL display the count and task IDs of running sessions, queued task count, budget usage, and failed task count
