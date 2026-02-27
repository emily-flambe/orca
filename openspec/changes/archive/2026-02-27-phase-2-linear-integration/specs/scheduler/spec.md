## MODIFIED Requirements

### Requirement: Priority-based task selection
The scheduler SHALL select the ready task with the lowest effective priority value (lower = more urgent). Effective priority SHALL be computed by the dependency graph's `computeEffectivePriority` function, which considers the task's own priority and the priorities of all tasks it transitively blocks. Ties SHALL be broken by `created_at` (oldest first).

#### Scenario: Higher effective priority task dispatched first
- **WHEN** two tasks are ready with own priorities 3 and 2, but task with priority 3 blocks an urgent priority 1 task
- **THEN** the scheduler SHALL dispatch the priority-3 task first because its effective priority is 1

#### Scenario: Tiebreaker by creation date
- **WHEN** two tasks are ready with the same effective priority
- **THEN** the scheduler SHALL dispatch the task with the earlier `created_at`

#### Scenario: Effective priority reflects transitive dependencies
- **WHEN** task A (priority 3) blocks task B (priority 2) which blocks task C (priority 1)
- **THEN** task A's effective priority SHALL be 1, and it SHALL be dispatched before an unrelated task with priority 2

## ADDED Requirements

### Requirement: Dependency-aware dispatch filtering
The scheduler SHALL filter out tasks with unresolved blockers before selecting tasks for dispatch. A task SHALL only be eligible for dispatch if `isDispatchable(taskId)` returns true, meaning all tasks in its `blockedBy` set have Orca status "done" or Linear state type "completed".

#### Scenario: Blocked task skipped
- **WHEN** the scheduler ticks and a ready task has an incomplete blocker
- **THEN** the scheduler SHALL skip the blocked task and dispatch the next eligible task

#### Scenario: Unblocked task dispatched
- **WHEN** the scheduler ticks and a ready task's blockers are all completed
- **THEN** the scheduler SHALL consider the task eligible for dispatch

#### Scenario: Task becomes dispatchable after blocker completes
- **WHEN** a blocker task transitions to "done"
- **THEN** the previously blocked task SHALL become eligible for dispatch on the next scheduler tick

### Requirement: Linear write-back on dispatch and completion
The scheduler SHALL trigger Linear state write-back when dispatching a task and when a task completes or permanently fails. On dispatch (ready to dispatched), the scheduler SHALL write back the "started" state. On completion (running to done), the scheduler SHALL write back the "completed" state. On permanent failure (running to failed with max retries exhausted), the scheduler SHALL write back the "canceled" state. On retry (failed to ready), the scheduler SHALL write back the "unstarted" state.

#### Scenario: Write-back on dispatch
- **WHEN** the scheduler dispatches a task
- **THEN** the scheduler SHALL trigger a write-back to set the Linear issue state to "started"

#### Scenario: Write-back on completion
- **WHEN** a task completes successfully
- **THEN** the scheduler SHALL trigger a write-back to set the Linear issue state to "completed"

#### Scenario: Write-back on permanent failure
- **WHEN** a task fails permanently (max retries exhausted)
- **THEN** the scheduler SHALL trigger a write-back to set the Linear issue state to "canceled"

#### Scenario: Write-back on retry
- **WHEN** a failed task is reset to ready for retry
- **THEN** the scheduler SHALL trigger a write-back to set the Linear issue state to "unstarted"

### Requirement: Skip tasks with empty agent_prompt
The scheduler SHALL NOT dispatch tasks that have an empty or null `agent_prompt`. These tasks SHALL be skipped during task selection regardless of their priority or dispatch eligibility.

#### Scenario: Task with empty prompt skipped
- **WHEN** the scheduler ticks and a ready task has an empty `agent_prompt`
- **THEN** the scheduler SHALL skip the task and not dispatch it

#### Scenario: Task with populated prompt dispatched
- **WHEN** the scheduler ticks and a ready task has a non-empty `agent_prompt`
- **THEN** the task SHALL be eligible for dispatch (subject to other dispatch criteria)
