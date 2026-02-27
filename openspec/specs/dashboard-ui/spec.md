## ADDED Requirements

### Requirement: OrchestratorBar component
The dashboard SHALL display a persistent top bar showing cost budget as a progress bar (`$X.XX / $Y.YY`) with color gradient (green → yellow → red), active session count with pulsing indicator, and queued task count.

#### Scenario: Budget gauge renders
- **WHEN** the dashboard loads
- **THEN** the OrchestratorBar SHALL display the current cost versus budget limit as a progress bar with appropriate color

#### Scenario: Status updates in real-time
- **WHEN** a `status:updated` SSE event is received
- **THEN** the OrchestratorBar SHALL update its displayed values without a full page reload

### Requirement: TaskList component
The dashboard SHALL display a task list panel (~40% width) showing each task as a row with priority dot (color-coded), issue ID, truncated title, and status badge (colored pill).

#### Scenario: Tasks render in list
- **WHEN** the dashboard loads
- **THEN** the TaskList SHALL fetch and display all tasks from `GET /api/tasks`

#### Scenario: Status filter
- **WHEN** the user selects a status filter (all / ready / running / done / failed)
- **THEN** the TaskList SHALL show only tasks matching the selected status

#### Scenario: Sort tasks
- **WHEN** the user changes the sort order (priority, status, or creation date)
- **THEN** the TaskList SHALL reorder the displayed tasks accordingly

#### Scenario: Select task
- **WHEN** the user clicks a task row
- **THEN** the row SHALL be highlighted and the TaskDetail panel SHALL display the selected task

#### Scenario: Task list updates via SSE
- **WHEN** a `task:updated` SSE event is received
- **THEN** the TaskList SHALL update the affected task row without a full re-fetch

### Requirement: TaskDetail component
The dashboard SHALL display a task detail panel (~60% width) showing the selected task's issue ID, title, status badge, editable agent prompt textarea, "Save" button, "Dispatch Now" button, and invocation history table.

#### Scenario: Task detail renders
- **WHEN** a task is selected in the TaskList
- **THEN** the TaskDetail SHALL fetch and display the full task detail from `GET /api/tasks/:id` including invocation history

#### Scenario: Save agent prompt
- **WHEN** the user edits the prompt textarea and clicks "Save"
- **THEN** the dashboard SHALL send `PUT /api/tasks/:id/prompt` with the new prompt text and indicate success

#### Scenario: Manual dispatch
- **WHEN** the user clicks "Dispatch Now" on a task with a prompt that is not running
- **THEN** the dashboard SHALL send `POST /api/tasks/:id/dispatch` and display the result

#### Scenario: Dispatch button disabled
- **WHEN** the selected task is already running or has no agent prompt
- **THEN** the "Dispatch Now" button SHALL be disabled

#### Scenario: Invocation history table
- **WHEN** a task has invocation history
- **THEN** the detail panel SHALL display a table with columns: date, duration, status, cost, turns, and summary

### Requirement: Priority and status colors
The dashboard SHALL use consistent color coding: priority colors (red = urgent/1, orange = high/2, blue = normal/3, gray = low/4, none = no priority/0) and status badge colors (green = done, blue = running, yellow = ready, red = failed, gray = dispatched).

#### Scenario: Priority dot color
- **WHEN** a task has priority 1
- **THEN** the priority dot SHALL be red

#### Scenario: Status badge color
- **WHEN** a task has status "running"
- **THEN** the status badge SHALL be blue

### Requirement: Data fetching strategy
The dashboard SHALL fetch initial data from the REST API on mount. The SSE hook (`useSSE`) SHALL listen for events and trigger selective re-fetches or in-place updates.

#### Scenario: Initial data load
- **WHEN** the dashboard mounts
- **THEN** it SHALL fetch task list from `GET /api/tasks` and status from `GET /api/status`

#### Scenario: SSE-driven update
- **WHEN** an SSE event is received
- **THEN** the dashboard SHALL update the relevant component's state without a full page reload
