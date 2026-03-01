## ADDED Requirements

### Requirement: Spawn claude CLI in print mode
The session runner SHALL spawn `claude` as a child process with flags: `-p <agent_prompt>`, `--output-format stream-json`, `--max-turns <configured_max>`, `--dangerously-skip-permissions`, and `--cwd <worktree_path>`.

#### Scenario: Process spawned with correct flags
- **WHEN** the scheduler dispatches a task with agent prompt "Fix the bug" and worktree at `/tmp/myapp-ORC-1`
- **THEN** the runner SHALL spawn `claude -p "Fix the bug" --output-format stream-json --max-turns 20 --dangerously-skip-permissions --cwd /tmp/myapp-ORC-1`

### Requirement: Parse stream-json init message
The runner SHALL parse each stdout line as JSON. When a message with `type: "system"` and `subtype: "init"` is received, the runner SHALL extract and store the `session_id` on the invocation record.

#### Scenario: Session ID captured
- **WHEN** the claude process emits `{"type":"system","subtype":"init","session_id":"abc-123"}`
- **THEN** the runner SHALL update the invocation record with `session_id` = "abc-123"

### Requirement: Parse stream-json result message
When a message with `type: "result"` is received, the runner SHALL extract `subtype`, `total_cost_usd`, and `num_turns`, and store them on the invocation record.

#### Scenario: Successful completion
- **WHEN** the claude process emits a result with `subtype: "success"`, `total_cost_usd: 0.42`, `num_turns: 8`
- **THEN** the runner SHALL set invocation status to "completed", `cost_usd` = 0.42, `num_turns` = 8

#### Scenario: Max turns reached
- **WHEN** the claude process emits a result with `subtype: "error_max_turns"`
- **THEN** the runner SHALL set invocation status to "failed" with output_summary noting "max turns reached"

#### Scenario: Execution error
- **WHEN** the claude process emits a result with `subtype: "error_during_execution"`
- **THEN** the runner SHALL set invocation status to "failed"

### Requirement: Log tee to file
The runner SHALL write every line of stream-json stdout to a log file at `logs/<invocation-id>.ndjson`. The log path SHALL be stored on the invocation record.

#### Scenario: Log file created and populated
- **WHEN** a session runs and emits 50 stream-json lines
- **THEN** the log file SHALL contain all 50 lines and the invocation's `log_path` SHALL point to the file

### Requirement: Process exit handling
When the claude process exits, the runner SHALL update the invocation's `ended_at` timestamp. If the process exits with a non-zero code and no result message was received, the invocation SHALL be marked as "failed".

#### Scenario: Process exits without result message
- **WHEN** the claude process exits with code 1 and no result message was parsed
- **THEN** the invocation SHALL be set to status "failed" with output_summary "process exited with code 1"

### Requirement: Resume previous session
The runner SHALL accept an optional `resumeSessionId` in `SpawnSessionOptions`. When set, the runner SHALL prepend `--resume <session_id>` before `-p <prompt>` in the CLI arguments. This resumes a previous Claude CLI session and sends the prompt as a continuation message.

#### Scenario: Session resumed after max turns
- **WHEN** the scheduler dispatches with `resumeSessionId: "abc-123"` and prompt "Continue where you left off"
- **THEN** the runner SHALL spawn `claude --resume abc-123 -p "Continue where you left off" --output-format stream-json ...`

#### Scenario: No resume ID provided
- **WHEN** the scheduler dispatches without `resumeSessionId`
- **THEN** the runner SHALL spawn `claude -p <prompt> ...` as normal (no `--resume` flag)

### Requirement: Process kill support
The runner SHALL expose a method to kill a running session's process (SIGTERM, then SIGKILL after 5 seconds). This is used by the scheduler for timeout enforcement and graceful shutdown.

#### Scenario: Session killed by timeout
- **WHEN** the scheduler requests a session kill
- **THEN** the runner SHALL send SIGTERM, wait 5 seconds, then SIGKILL if still running
