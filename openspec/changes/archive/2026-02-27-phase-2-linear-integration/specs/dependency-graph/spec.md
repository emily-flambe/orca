## ADDED Requirements

### Requirement: In-memory adjacency list storage
The dependency graph SHALL maintain two in-memory adjacency maps: `blockedBy` (mapping each task ID to the set of task IDs that block it) and `blocks` (mapping each task ID to the set of task IDs it blocks). These maps SHALL be derived from Linear issue relations of type "blocks" and their inverse relations.

#### Scenario: Graph built from Linear relations
- **WHEN** issue A has a relation of type "blocks" pointing to issue B
- **THEN** the `blockedBy` map SHALL contain B -> {A} and the `blocks` map SHALL contain A -> {B}

#### Scenario: Multiple blockers for one issue
- **WHEN** issue C is blocked by both issue A and issue B
- **THEN** the `blockedBy` map SHALL contain C -> {A, B}

### Requirement: Graph rebuild on full sync
The dependency graph SHALL be rebuilt from scratch during full sync on startup. All existing entries SHALL be cleared and repopulated from the fetched Linear issue relations and inverse relations.

#### Scenario: Graph rebuilt on startup
- **WHEN** the full sync completes on startup with 50 issues and 20 blocking relations
- **THEN** the dependency graph SHALL contain exactly the 20 blocking relations from the fetched data, with no stale entries

### Requirement: Incremental update on webhook events
The dependency graph SHALL update incrementally when webhook events report changes to issue relations. New blocking relations SHALL be added to both maps. Removed blocking relations SHALL be deleted from both maps.

#### Scenario: New blocking relation added via webhook
- **WHEN** a webhook reports that issue A now blocks issue B
- **THEN** the graph SHALL add B to `blocks[A]` and A to `blockedBy[B]`

#### Scenario: Blocking relation removed via webhook
- **WHEN** a webhook reports that issue A no longer blocks issue B
- **THEN** the graph SHALL remove B from `blocks[A]` and A from `blockedBy[B]`

### Requirement: Dispatch filtering via isDispatchable
The dependency graph SHALL provide an `isDispatchable(taskId)` function that returns true only if all tasks in the `blockedBy` set for the given task have Orca status "done" or Linear state type "completed". If any blocker is not completed, the function SHALL return false.

#### Scenario: Task with no blockers is dispatchable
- **WHEN** `isDispatchable` is called for a task with no entries in the `blockedBy` map
- **THEN** the function SHALL return true

#### Scenario: Task with all blockers completed is dispatchable
- **WHEN** `isDispatchable` is called for a task whose blockers all have Orca status "done"
- **THEN** the function SHALL return true

#### Scenario: Task with incomplete blocker is not dispatchable
- **WHEN** `isDispatchable` is called for a task where one blocker has Orca status "ready"
- **THEN** the function SHALL return false

### Requirement: Transitive effective priority computation
The dependency graph SHALL provide a `computeEffectivePriority(taskId)` function that computes effective priority by walking the `blocks` edges transitively. The effective priority SHALL be the minimum of the task's own priority and all priorities of tasks it transitively blocks. Lower values indicate higher urgency.

#### Scenario: Task inherits priority from blocked task
- **WHEN** task A (priority 3) blocks task B (priority 1)
- **THEN** `computeEffectivePriority(A)` SHALL return 1

#### Scenario: Transitive priority inheritance
- **WHEN** task A (priority 3) blocks task B (priority 2) which blocks task C (priority 1)
- **THEN** `computeEffectivePriority(A)` SHALL return 1

#### Scenario: Task with no blocked tasks uses own priority
- **WHEN** task A (priority 2) does not block any other tasks
- **THEN** `computeEffectivePriority(A)` SHALL return 2

#### Scenario: Effective priority is minimum across multiple paths
- **WHEN** task A (priority 3) blocks task B (priority 2) and task C (priority 1)
- **THEN** `computeEffectivePriority(A)` SHALL return 1

### Requirement: Cycle detection
The transitive graph walks in `computeEffectivePriority` and `isDispatchable` SHALL use a visited set to prevent infinite loops when cycles exist in the dependency graph. When a cycle is detected, the system SHALL log a warning identifying the cycle and terminate the walk for that path.

#### Scenario: Cycle does not cause infinite loop
- **WHEN** task A blocks task B and task B blocks task A (a cycle)
- **THEN** `computeEffectivePriority(A)` SHALL terminate without hanging and SHALL return a valid priority value

#### Scenario: Cycle triggers warning log
- **WHEN** a transitive walk encounters a previously visited task ID
- **THEN** the system SHALL log a warning message identifying the cycle
