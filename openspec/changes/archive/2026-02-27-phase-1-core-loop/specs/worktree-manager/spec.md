## ADDED Requirements

### Requirement: Create worktree per invocation
The worktree manager SHALL create a git worktree for each invocation as a sibling directory of the task's `repo_path`.

#### Scenario: Worktree created successfully
- **WHEN** a task at `/home/user/projects/myapp` is dispatched with invocation ID 7
- **THEN** the manager SHALL run `git fetch origin`, create branch `orca/<task-id>-inv-7`, and create worktree at `/home/user/projects/myapp-<task-id>`

### Requirement: Worktree naming convention
The worktree directory SHALL be named `<repo_dirname>-<task_id>`. The branch SHALL be named `orca/<task_id>-inv-<invocation_id>`.

#### Scenario: Names follow convention
- **WHEN** repo is at `/home/user/myapp` and task ID is "ORC-12" with invocation ID 3
- **THEN** worktree path SHALL be `/home/user/myapp-ORC-12` and branch SHALL be `orca/ORC-12-inv-3`

### Requirement: Copy environment files
After creating the worktree, the manager SHALL copy `.env*` files from the base repo to the worktree (if they exist).

#### Scenario: Env files copied
- **WHEN** the base repo contains `.env` and `.env.local`
- **THEN** both files SHALL be copied to the worktree directory

#### Scenario: No env files
- **WHEN** the base repo contains no `.env*` files
- **THEN** the copy step SHALL succeed silently (no error)

### Requirement: Install dependencies
If the worktree contains a `package.json`, the manager SHALL run `npm install` in the worktree directory before returning.

#### Scenario: Dependencies installed
- **WHEN** the worktree contains a `package.json`
- **THEN** `npm install` SHALL be run in the worktree directory

#### Scenario: No package.json
- **WHEN** the worktree does not contain a `package.json`
- **THEN** the install step SHALL be skipped silently

### Requirement: Reuse existing worktree on retry
If a worktree already exists at the target path (retry scenario), the manager SHALL reset it to `origin/main` instead of creating a new one.

#### Scenario: Existing worktree reset
- **WHEN** a task is retried and the worktree directory already exists
- **THEN** the manager SHALL run `git reset --hard origin/main` in the worktree instead of creating a new one

### Requirement: Remove worktree on success
When a session completes successfully, the worktree SHALL be removed via `git worktree remove <path>`. The branch SHALL remain in the repo.

#### Scenario: Successful cleanup
- **WHEN** an invocation completes with status "completed"
- **THEN** the worktree directory SHALL be removed and the branch SHALL still exist in the repo

### Requirement: Preserve worktree on failure
When a session fails, the worktree SHALL NOT be removed. It remains for manual debugging.

#### Scenario: Failed session worktree preserved
- **WHEN** an invocation completes with status "failed"
- **THEN** the worktree directory SHALL remain intact
