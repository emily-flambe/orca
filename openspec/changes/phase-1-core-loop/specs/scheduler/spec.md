## ADDED Requirements

### Requirement: Concurrency-capped dispatch loop
The scheduler SHALL maintain a configurable maximum number of concurrent running sessions (default 3). It SHALL NOT dispatch new tasks when the cap is reached.

#### Scenario: Dispatch when slots available
- **WHEN** the scheduler ticks and active sessions < concurrency cap and there are ready tasks
- **THEN** the scheduler SHALL dispatch the highest-priority ready task

#### Scenario: No dispatch when cap reached
- **WHEN** the scheduler ticks and active sessions >= concurrency cap
- **THEN** the scheduler SHALL NOT dispatch any new tasks

### Requirement: Priority-based task selection
The scheduler SHALL select the ready task with the lowest `priority` value (lower = more urgent). Ties SHALL be broken by `created_at` (oldest first).

#### Scenario: Higher priority task dispatched first
- **WHEN** two tasks are ready with priorities 1 (urgent) and 3 (normal)
- **THEN** the scheduler SHALL dispatch the priority 1 task first

#### Scenario: Tiebreaker by creation date
- **WHEN** two tasks are ready with the same priority
- **THEN** the scheduler SHALL dispatch the task with the earlier `created_at`

### Requirement: Cost budget enforcement
The scheduler SHALL track cumulative `cost_usd` from all invocations within a rolling window (default 4 hours). It SHALL NOT dispatch new tasks when cumulative cost exceeds `ORCA_BUDGET_MAX_COST_USD`.

#### Scenario: Budget exhausted
- **WHEN** the scheduler ticks and cumulative cost in the rolling window >= budget max
- **THEN** the scheduler SHALL NOT dispatch any new tasks, even if concurrency slots are available

#### Scenario: Budget window rolls forward
- **WHEN** invocations older than the budget window duration exist
- **THEN** their costs SHALL NOT count toward the current budget

### Requirement: Hard timeout enforcement
The scheduler SHALL kill any running session that exceeds `ORCA_SESSION_TIMEOUT_MIN` (default 45 minutes). The invocation SHALL be marked as `timed_out` and the task as `failed`.

#### Scenario: Session exceeds timeout
- **WHEN** a running session has been active longer than the timeout
- **THEN** the scheduler SHALL kill the process, set invocation status to "timed_out", and set task status to "failed"

### Requirement: Automatic retry on failure
When a task fails, the scheduler SHALL reset it to "ready" for re-dispatch, unless `retry_count` >= `ORCA_MAX_RETRIES`. In that case, the task SHALL remain "failed".

#### Scenario: Task retried after failure
- **WHEN** a task fails and `retry_count` < `ORCA_MAX_RETRIES`
- **THEN** the task SHALL be set to "ready" and `retry_count` incremented

#### Scenario: Max retries exhausted
- **WHEN** a task fails and `retry_count` >= `ORCA_MAX_RETRIES`
- **THEN** the task SHALL remain in "failed" status permanently

### Requirement: Immediate backfill on session completion
When a session completes (success or failure), the scheduler SHALL check for dispatchable tasks on the next tick rather than waiting for a fixed interval.

#### Scenario: Slot freed by completed session
- **WHEN** a session completes and there are ready tasks below the concurrency cap
- **THEN** the scheduler SHALL dispatch the next task within one scheduler tick interval

### Requirement: Scheduler tick interval
The scheduler SHALL run its dispatch check on a configurable interval (default 10 seconds). Ticks SHALL NOT overlap — if a tick is still processing, the next SHALL be skipped.

#### Scenario: Tick runs on interval
- **WHEN** the scheduler is started
- **THEN** the dispatch check SHALL run every `ORCA_SCHEDULER_INTERVAL_SEC` seconds

#### Scenario: Overlapping tick prevention
- **WHEN** a tick is still executing when the next interval fires
- **THEN** the next tick SHALL be skipped
