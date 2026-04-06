import Database, { type Database as DatabaseType } from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema.js";

const CREATE_TASKS = `
CREATE TABLE IF NOT EXISTS tasks (
  linear_issue_id TEXT PRIMARY KEY,
  agent_prompt TEXT NOT NULL,
  repo_path TEXT NOT NULL,
  lifecycle_stage TEXT NOT NULL DEFAULT 'ready',
  current_phase TEXT,
  priority INTEGER NOT NULL DEFAULT 0 CHECK(priority >= 0 AND priority <= 4),
  retry_count INTEGER NOT NULL DEFAULT 0,
  pr_branch_name TEXT,
  merge_commit_sha TEXT,
  pr_number INTEGER,
  deploy_started_at TEXT,
  ci_started_at TEXT,
  fix_reason TEXT,
  merge_attempt_count INTEGER NOT NULL DEFAULT 0,
  done_at TEXT,
  parent_identifier TEXT,
  is_parent INTEGER NOT NULL DEFAULT 0,
  project_name TEXT,
  task_type TEXT NOT NULL DEFAULT 'linear',
  cron_schedule_id INTEGER,
  agent_id TEXT,
  last_failure_reason TEXT,
  last_failed_phase TEXT,
  last_failed_at TEXT,
  pr_url TEXT,
  pr_state TEXT,
  hidden INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
)`;

const CREATE_INVOCATIONS = `
CREATE TABLE IF NOT EXISTS invocations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  linear_issue_id TEXT NOT NULL REFERENCES tasks(linear_issue_id),
  started_at TEXT NOT NULL,
  ended_at TEXT,
  status TEXT NOT NULL CHECK(status IN ('running','completed','failed','timed_out')),
  session_id TEXT,
  branch_name TEXT,
  worktree_path TEXT,
  worktree_preserved INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL,
  input_tokens INTEGER,
  output_tokens INTEGER,
  num_turns INTEGER,
  output_summary TEXT,
  log_path TEXT,
  phase TEXT,
  model TEXT
)`;

const CREATE_SYSTEM_EVENTS = `
CREATE TABLE IF NOT EXISTS system_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,
  message TEXT NOT NULL,
  metadata TEXT,
  created_at TEXT NOT NULL
)`;

const CREATE_CRON_SCHEDULES = `
CREATE TABLE IF NOT EXISTS cron_schedules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK(type IN ('claude','shell')),
  schedule TEXT NOT NULL,
  prompt TEXT NOT NULL,
  repo_path TEXT,
  model TEXT,
  max_turns INTEGER,
  timeout_min INTEGER NOT NULL DEFAULT 30,
  max_runs INTEGER,
  run_count INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1,
  last_run_at TEXT,
  next_run_at TEXT,
  last_run_status TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
)`;

const CREATE_CRON_RUNS = `
CREATE TABLE IF NOT EXISTS cron_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  cron_schedule_id INTEGER NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  status TEXT NOT NULL,
  output TEXT,
  duration_ms INTEGER
)`;

const CREATE_HOOK_EVENTS = `
CREATE TABLE IF NOT EXISTS hook_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  invocation_id INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  payload TEXT NOT NULL,
  received_at TEXT NOT NULL
)`;

const CREATE_AGENTS = `
CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  system_prompt TEXT NOT NULL,
  model TEXT,
  max_turns INTEGER,
  timeout_min INTEGER NOT NULL DEFAULT 45,
  repo_path TEXT,
  schedule TEXT,
  max_memories INTEGER NOT NULL DEFAULT 200,
  enabled INTEGER NOT NULL DEFAULT 1,
  run_count INTEGER NOT NULL DEFAULT 0,
  last_run_at TEXT,
  next_run_at TEXT,
  last_run_status TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
)`;

const CREATE_AGENT_MEMORIES = `
CREATE TABLE IF NOT EXISTS agent_memories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id TEXT NOT NULL,
  type TEXT NOT NULL CHECK(type IN ('episodic','semantic','procedural')),
  content TEXT NOT NULL,
  source_run_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
)`;

const CREATE_TASK_STATE_TRANSITIONS = `
CREATE TABLE IF NOT EXISTS task_state_transitions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  linear_issue_id TEXT NOT NULL,
  from_status TEXT,
  to_status TEXT NOT NULL,
  reason TEXT,
  invocation_id INTEGER,
  created_at TEXT NOT NULL
)`;

/**
 * Check if a column exists in a table using PRAGMA table_info.
 */
function hasColumn(
  sqlite: DatabaseType,
  table: string,
  column: string,
): boolean {
  const cols = sqlite.pragma(`table_info(${table})`) as { name: string }[];
  return cols.some((c) => c.name === column);
}

/**
 * Run schema migrations for existing databases.
 *
 * Migration 1 (review lifecycle):
 *   - Adds pr_branch_name, review_cycle_count columns to tasks
 *   - Adds phase column to invocations
 *   - Recreates the tasks table to update the CHECK constraint on orca_status
 *     (SQLite cannot ALTER CHECK constraints in-place). The old constraint
 *     only allowed 'ready','dispatched','running','done','failed'; the new
 *     one also allows 'in_review','changes_requested'.
 *
 * The pr_branch_name column is used as a sentinel: if it doesn't exist, the
 * table predates the review lifecycle feature and the CHECK must be updated.
 */
function migrateSchema(sqlite: DatabaseType): void {
  const needsTasksMigration = !hasColumn(sqlite, "tasks", "pr_branch_name");

  if (needsTasksMigration) {
    // Temporarily disable FK enforcement so we can drop/rename the tasks table
    // while invocations still references it.
    sqlite.pragma("foreign_keys = OFF");

    sqlite.exec("BEGIN TRANSACTION");
    try {
      // 1. Create the new tasks table with the updated CHECK constraint and new columns.
      sqlite.exec(`
        CREATE TABLE tasks_new (
          linear_issue_id TEXT PRIMARY KEY,
          agent_prompt TEXT NOT NULL,
          repo_path TEXT NOT NULL,
          orca_status TEXT NOT NULL CHECK(orca_status IN ('ready','dispatched','running','done','failed','in_review','changes_requested')),
          priority INTEGER NOT NULL DEFAULT 0 CHECK(priority >= 0 AND priority <= 4),
          retry_count INTEGER NOT NULL DEFAULT 0,
          pr_branch_name TEXT,
          review_cycle_count INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        )
      `);

      // 2. Copy data from the old table (only columns that existed).
      sqlite.exec(`
        INSERT INTO tasks_new (linear_issue_id, agent_prompt, repo_path, orca_status, priority, retry_count, created_at, updated_at)
        SELECT linear_issue_id, agent_prompt, repo_path, orca_status, priority, retry_count, created_at, updated_at
        FROM tasks
      `);

      // 3. Drop old table and rename new one.
      sqlite.exec("DROP TABLE tasks");
      sqlite.exec("ALTER TABLE tasks_new RENAME TO tasks");

      sqlite.exec("COMMIT");
    } catch (err) {
      sqlite.exec("ROLLBACK");
      throw err;
    }

    // Re-enable FK enforcement.
    sqlite.pragma("foreign_keys = ON");
  } else {
    // Table already has pr_branch_name — check if review_cycle_count is missing
    // (shouldn't happen in practice, but defensive).
    if (!hasColumn(sqlite, "tasks", "review_cycle_count")) {
      sqlite.exec(
        "ALTER TABLE tasks ADD COLUMN review_cycle_count INTEGER NOT NULL DEFAULT 0",
      );
    }
  }

  // invocations: phase
  if (!hasColumn(sqlite, "invocations", "phase")) {
    sqlite.exec("ALTER TABLE invocations ADD COLUMN phase TEXT");
  }

  // ---------------------------------------------------------------------------
  // Migration 2 (deploy lifecycle):
  //   - Remove CHECK constraint on orca_status (plain TEXT NOT NULL)
  //   - Add merge_commit_sha, pr_number, deploy_started_at columns
  //   Sentinel: merge_commit_sha column doesn't exist on tasks table.
  // ---------------------------------------------------------------------------
  if (!hasColumn(sqlite, "tasks", "merge_commit_sha")) {
    sqlite.pragma("foreign_keys = OFF");

    sqlite.exec("BEGIN TRANSACTION");
    try {
      sqlite.exec(`
        CREATE TABLE tasks_new (
          linear_issue_id TEXT PRIMARY KEY,
          agent_prompt TEXT NOT NULL,
          repo_path TEXT NOT NULL,
          orca_status TEXT NOT NULL,
          priority INTEGER NOT NULL DEFAULT 0 CHECK(priority >= 0 AND priority <= 4),
          retry_count INTEGER NOT NULL DEFAULT 0,
          pr_branch_name TEXT,
          review_cycle_count INTEGER NOT NULL DEFAULT 0,
          merge_commit_sha TEXT,
          pr_number INTEGER,
          deploy_started_at TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        )
      `);

      sqlite.exec(`
        INSERT INTO tasks_new (linear_issue_id, agent_prompt, repo_path, orca_status, priority, retry_count, pr_branch_name, review_cycle_count, created_at, updated_at)
        SELECT linear_issue_id, agent_prompt, repo_path, orca_status, priority, retry_count, pr_branch_name, review_cycle_count, created_at, updated_at
        FROM tasks
      `);

      sqlite.exec("DROP TABLE tasks");
      sqlite.exec("ALTER TABLE tasks_new RENAME TO tasks");

      sqlite.exec("COMMIT");
    } catch (err) {
      sqlite.exec("ROLLBACK");
      throw err;
    }

    sqlite.pragma("foreign_keys = ON");
  }

  // ---------------------------------------------------------------------------
  // Migration 3 (done_at timestamp):
  //   - Add done_at column to tasks
  //   - Backfill existing done tasks with updated_at as a reasonable timestamp
  //   Sentinel: done_at column doesn't exist on tasks table.
  // ---------------------------------------------------------------------------
  if (!hasColumn(sqlite, "tasks", "done_at")) {
    sqlite.exec("ALTER TABLE tasks ADD COLUMN done_at TEXT");
    sqlite.exec(
      "UPDATE tasks SET done_at = updated_at WHERE orca_status = 'done' AND done_at IS NULL",
    );
  }

  // ---------------------------------------------------------------------------
  // Migration 4 (parent/child issue tracking):
  //   - Add parent_identifier column to tasks (FK-like to parent task)
  //   - Add is_parent column (1 = has children, skip dispatch)
  //   Sentinel: parent_identifier column doesn't exist on tasks table.
  // ---------------------------------------------------------------------------
  if (!hasColumn(sqlite, "tasks", "parent_identifier")) {
    sqlite.exec("ALTER TABLE tasks ADD COLUMN parent_identifier TEXT");
    sqlite.exec(
      "ALTER TABLE tasks ADD COLUMN is_parent INTEGER NOT NULL DEFAULT 0",
    );
  }

  // ---------------------------------------------------------------------------
  // Migration 5 (project name):
  //   - Add project_name column to tasks
  //   Sentinel: project_name column doesn't exist on tasks table.
  // ---------------------------------------------------------------------------
  if (!hasColumn(sqlite, "tasks", "project_name")) {
    sqlite.exec("ALTER TABLE tasks ADD COLUMN project_name TEXT");
  }

  // ---------------------------------------------------------------------------
  // Migration 6 (CI gate):
  //   - Add ci_started_at column to tasks (tracks when CI polling began)
  //   Sentinel: ci_started_at column doesn't exist on tasks table.
  // ---------------------------------------------------------------------------
  if (!hasColumn(sqlite, "tasks", "ci_started_at")) {
    sqlite.exec("ALTER TABLE tasks ADD COLUMN ci_started_at TEXT");
  }

  // ---------------------------------------------------------------------------
  // Migration 7 (model tracking):
  //   - Add model column to invocations (records which Claude model was used)
  //   Sentinel: model column doesn't exist on invocations table.
  // ---------------------------------------------------------------------------
  if (!hasColumn(sqlite, "invocations", "model")) {
    sqlite.exec("ALTER TABLE invocations ADD COLUMN model TEXT");
  }

  // ---------------------------------------------------------------------------
  // Migration 8 (fix reason tracking):
  //   - Add fix_reason column to tasks (records why fix phase was triggered)
  //   Sentinel: fix_reason column doesn't exist on tasks table.
  // ---------------------------------------------------------------------------
  if (!hasColumn(sqlite, "tasks", "fix_reason")) {
    sqlite.exec("ALTER TABLE tasks ADD COLUMN fix_reason TEXT");
  }

  // ---------------------------------------------------------------------------
  // Migration 9 (merge attempt tracking):
  //   - Add merge_attempt_count column to tasks (counts consecutive merge failures)
  //   - Allows merge retry with backoff before escalating to permanent failure
  //   Sentinel: merge_attempt_count column doesn't exist on tasks table.
  // ---------------------------------------------------------------------------
  if (!hasColumn(sqlite, "tasks", "merge_attempt_count")) {
    sqlite.exec(
      "ALTER TABLE tasks ADD COLUMN merge_attempt_count INTEGER NOT NULL DEFAULT 0",
    );
  }

  // ---------------------------------------------------------------------------
  // Migration 10 (stale session retry tracking):
  //   - Add stale_session_retry_count column to tasks (bounds stale-session loops)
  //   Sentinel: stale_session_retry_count column doesn't exist on tasks table.
  // ---------------------------------------------------------------------------
  if (!hasColumn(sqlite, "tasks", "stale_session_retry_count")) {
    sqlite.exec(
      "ALTER TABLE tasks ADD COLUMN stale_session_retry_count INTEGER NOT NULL DEFAULT 0",
    );
  }

  // ---------------------------------------------------------------------------
  // Migration 11 (deploy-interrupted worktree preservation):
  //   - Add worktree_preserved column to invocations (1 = worktree kept for resume)
  //   Sentinel: worktree_preserved column doesn't exist on invocations table.
  // ---------------------------------------------------------------------------
  if (!hasColumn(sqlite, "invocations", "worktree_preserved")) {
    sqlite.exec(
      "ALTER TABLE invocations ADD COLUMN worktree_preserved INTEGER NOT NULL DEFAULT 0",
    );
  }

  // ---------------------------------------------------------------------------
  // Migration 12 (cron task type):
  //   - Add task_type column to tasks (distinguishes linear vs cron tasks)
  //   Sentinel: task_type column doesn't exist on tasks table.
  // ---------------------------------------------------------------------------
  if (!hasColumn(sqlite, "tasks", "task_type")) {
    sqlite.exec(
      "ALTER TABLE tasks ADD COLUMN task_type TEXT NOT NULL DEFAULT 'linear'",
    );
  }

  // ---------------------------------------------------------------------------
  // Migration 13 (cron schedule FK):
  //   - Add cron_schedule_id column to tasks (FK to cron_schedules)
  //   Sentinel: cron_schedule_id column doesn't exist on tasks table.
  // ---------------------------------------------------------------------------
  if (!hasColumn(sqlite, "tasks", "cron_schedule_id")) {
    sqlite.exec("ALTER TABLE tasks ADD COLUMN cron_schedule_id INTEGER");
  }

  // ---------------------------------------------------------------------------
  // Migration 14 (token tracking):
  //   - Add input_tokens, output_tokens columns to invocations
  //   Sentinel: input_tokens column doesn't exist on invocations table.
  // ---------------------------------------------------------------------------
  if (!hasColumn(sqlite, "invocations", "input_tokens")) {
    sqlite.exec("ALTER TABLE invocations ADD COLUMN input_tokens INTEGER");
    sqlite.exec("ALTER TABLE invocations ADD COLUMN output_tokens INTEGER");
  }

  // ---------------------------------------------------------------------------
  // Migration 15 (cron last run status):
  //   - Add lastRunStatus column to cron_schedules (records success/failed for last run)
  //   Sentinel: lastRunStatus column doesn't exist on cron_schedules table.
  // ---------------------------------------------------------------------------
  if (!hasColumn(sqlite, "cron_schedules", "last_run_status")) {
    sqlite.exec("ALTER TABLE cron_schedules ADD COLUMN last_run_status TEXT");
  }

  // ---------------------------------------------------------------------------
  // Migration 16 (self-monitoring composite index):
  //   - Add composite index on system_events(type, created_at) for efficient
  //     startup reconstruction of healing counters.
  //   CREATE INDEX IF NOT EXISTS is idempotent — no sentinel needed.
  // ---------------------------------------------------------------------------
  sqlite.exec(
    "CREATE INDEX IF NOT EXISTS idx_system_events_type_created ON system_events(type, created_at)",
  );

  // ---------------------------------------------------------------------------
  // Migration 17 (performance indexes):
  //   Indexes on frequently queried columns to avoid full table scans.
  //   CREATE INDEX IF NOT EXISTS is idempotent — no sentinel needed.
  // ---------------------------------------------------------------------------
  // idx_tasks_orca_status skipped — orca_status column is removed by migration 26.
  // idx_tasks_lifecycle_stage is created in migration 25 and recreated in migration 26.
  sqlite.exec(
    "CREATE INDEX IF NOT EXISTS idx_invocations_status ON invocations(status)",
  );
  sqlite.exec(
    "CREATE INDEX IF NOT EXISTS idx_invocations_linear_issue_id ON invocations(linear_issue_id)",
  );

  // ---------------------------------------------------------------------------
  // Migration 18 (task state transition audit log):
  //   - Create task_state_transitions table if it doesn't exist (for existing DBs)
  //   Sentinel: table doesn't exist.
  // ---------------------------------------------------------------------------
  const transitionTableExists =
    (sqlite.pragma("table_info(task_state_transitions)") as { name: string }[])
      .length > 0;
  if (!transitionTableExists) {
    sqlite.exec(`CREATE TABLE task_state_transitions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      linear_issue_id TEXT NOT NULL,
      from_status TEXT,
      to_status TEXT NOT NULL,
      reason TEXT,
      invocation_id INTEGER,
      created_at TEXT NOT NULL
    )`);
    sqlite.exec(
      "CREATE INDEX IF NOT EXISTS idx_task_state_transitions_linear_issue_id ON task_state_transitions(linear_issue_id)",
    );
  }

  // ---------------------------------------------------------------------------
  // Migration 19 (agent_id on tasks):
  //   - Add agent_id column to tasks (references which agent spawned this task)
  //   Sentinel: agent_id column doesn't exist on tasks table.
  // ---------------------------------------------------------------------------
  if (!hasColumn(sqlite, "tasks", "agent_id")) {
    sqlite.exec("ALTER TABLE tasks ADD COLUMN agent_id TEXT");
  }

  // ---------------------------------------------------------------------------
  // Migration 20 (agent_memories index):
  //   - Add index on agent_memories(agent_id) for efficient memory lookup.
  //   CREATE INDEX IF NOT EXISTS is idempotent — no sentinel needed.
  // ---------------------------------------------------------------------------
  sqlite.exec(
    "CREATE INDEX IF NOT EXISTS idx_agent_memories_agent_id ON agent_memories(agent_id)",
  );

  // ---------------------------------------------------------------------------
  // Migration 21 (hook events):
  //   - Create hook_events table for Claude Code webhook payloads
  //   Sentinel: table doesn't exist.
  // ---------------------------------------------------------------------------
  const hookEventsTableExists =
    (sqlite.pragma("table_info(hook_events)") as { name: string }[]).length > 0;
  if (!hookEventsTableExists) {
    sqlite.exec(`CREATE TABLE hook_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      invocation_id INTEGER NOT NULL,
      event_type TEXT NOT NULL,
      payload TEXT NOT NULL,
      received_at TEXT NOT NULL
    )`);
    sqlite.exec(
      "CREATE INDEX IF NOT EXISTS idx_hook_events_invocation_id ON hook_events(invocation_id)",
    );
  }

  // ---------------------------------------------------------------------------
  // Migration 22 (failure observability):
  //   - Add last_failure_reason TEXT column to tasks
  //   - Add last_failed_phase TEXT column to tasks
  //   - Add last_failed_at TEXT column to tasks
  //   Sentinel: last_failure_reason column doesn't exist on tasks table.
  // ---------------------------------------------------------------------------
  if (!hasColumn(sqlite, "tasks", "last_failure_reason")) {
    sqlite.exec("ALTER TABLE tasks ADD COLUMN last_failure_reason TEXT");
    sqlite.exec("ALTER TABLE tasks ADD COLUMN last_failed_phase TEXT");
    sqlite.exec("ALTER TABLE tasks ADD COLUMN last_failed_at TEXT");
  }

  // ---------------------------------------------------------------------------
  // Migration 23 (PR link and state):
  //   - Add pr_url TEXT column to tasks (nullable, GitHub PR URL)
  //   - Add pr_state TEXT column to tasks (nullable: draft|open|merged|closed)
  //   Sentinel: pr_url column doesn't exist on tasks table.
  // ---------------------------------------------------------------------------
  if (!hasColumn(sqlite, "tasks", "pr_url")) {
    sqlite.exec("ALTER TABLE tasks ADD COLUMN pr_url TEXT");
    sqlite.exec("ALTER TABLE tasks ADD COLUMN pr_state TEXT");
  }

  // ---------------------------------------------------------------------------
  // Migration 24 (hidden tasks):
  //   - Add hidden INTEGER column to tasks (0 = visible, 1 = hidden)
  //   Sentinel: hidden column doesn't exist on tasks table.
  // ---------------------------------------------------------------------------
  if (!hasColumn(sqlite, "tasks", "hidden")) {
    sqlite.exec(
      "ALTER TABLE tasks ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0",
    );
  }

  // ---------------------------------------------------------------------------
  // Migration 25 (lifecycle stage + current phase):
  //   - Add lifecycle_stage TEXT column to tasks (new state model)
  //   - Add current_phase TEXT column to tasks (active sub-phase)
  //   - Backfill from orca_status using the mapping table
  //   Sentinel: lifecycle_stage column doesn't exist on tasks table.
  // ---------------------------------------------------------------------------
  if (!hasColumn(sqlite, "tasks", "lifecycle_stage")) {
    sqlite.exec("ALTER TABLE tasks ADD COLUMN lifecycle_stage TEXT");
    sqlite.exec("ALTER TABLE tasks ADD COLUMN current_phase TEXT");

    // Backfill lifecycle_stage and current_phase from orca_status
    sqlite.exec(`
      UPDATE tasks SET
        lifecycle_stage = CASE orca_status
          WHEN 'backlog' THEN 'backlog'
          WHEN 'ready' THEN 'ready'
          WHEN 'running' THEN 'active'
          WHEN 'in_review' THEN 'active'
          WHEN 'changes_requested' THEN 'active'
          WHEN 'awaiting_ci' THEN 'active'
          WHEN 'deploying' THEN 'active'
          WHEN 'done' THEN 'done'
          WHEN 'failed' THEN 'failed'
          WHEN 'canceled' THEN 'canceled'
          ELSE NULL
        END,
        current_phase = CASE orca_status
          WHEN 'running' THEN 'implement'
          WHEN 'in_review' THEN 'review'
          WHEN 'changes_requested' THEN 'fix'
          WHEN 'awaiting_ci' THEN 'ci'
          WHEN 'deploying' THEN 'deploy'
          ELSE NULL
        END
    `);

    sqlite.exec(
      "CREATE INDEX IF NOT EXISTS idx_tasks_lifecycle_stage ON tasks(lifecycle_stage)",
    );
  }

  // ---------------------------------------------------------------------------
  //   Migration: agents.linear_label
  //   - Add linear_label TEXT column to agents (e.g. "agent:trivia-content")
  //   Sentinel: linear_label column doesn't exist on agents table.
  // ---------------------------------------------------------------------------
  if (!hasColumn(sqlite, "agents", "linear_label")) {
    sqlite.exec("ALTER TABLE agents ADD COLUMN linear_label TEXT");
  }

  // ---------------------------------------------------------------------------
  // Migration 26 (remove orca_status column):
  //   - Ensures lifecycle_stage is populated (should be from migration 25 backfill)
  //   - Recreates the tasks table without orca_status
  //   Sentinel: orca_status column still exists on tasks table.
  // ---------------------------------------------------------------------------
  if (hasColumn(sqlite, "tasks", "orca_status")) {
    sqlite.pragma("foreign_keys = OFF");

    sqlite.exec("BEGIN TRANSACTION");
    try {
      // Ensure lifecycle_stage is populated for any rows that might have NULL
      sqlite.exec(`
        UPDATE tasks SET lifecycle_stage = CASE orca_status
          WHEN 'backlog' THEN 'backlog'
          WHEN 'ready' THEN 'ready'
          WHEN 'running' THEN 'active'
          WHEN 'in_review' THEN 'active'
          WHEN 'changes_requested' THEN 'active'
          WHEN 'awaiting_ci' THEN 'active'
          WHEN 'deploying' THEN 'active'
          WHEN 'done' THEN 'done'
          WHEN 'failed' THEN 'failed'
          WHEN 'canceled' THEN 'canceled'
          ELSE 'ready'
        END WHERE lifecycle_stage IS NULL
      `);
      sqlite.exec(`
        UPDATE tasks SET current_phase = CASE orca_status
          WHEN 'running' THEN 'implement'
          WHEN 'in_review' THEN 'review'
          WHEN 'changes_requested' THEN 'fix'
          WHEN 'awaiting_ci' THEN 'ci'
          WHEN 'deploying' THEN 'deploy'
          ELSE NULL
        END WHERE lifecycle_stage = 'active' AND current_phase IS NULL
      `);

      sqlite.exec(`
        CREATE TABLE tasks_new (
          linear_issue_id TEXT PRIMARY KEY,
          agent_prompt TEXT NOT NULL,
          repo_path TEXT NOT NULL,
          lifecycle_stage TEXT NOT NULL DEFAULT 'ready',
          current_phase TEXT,
          priority INTEGER NOT NULL DEFAULT 0 CHECK(priority >= 0 AND priority <= 4),
          retry_count INTEGER NOT NULL DEFAULT 0,
          pr_branch_name TEXT,
          merge_commit_sha TEXT,
          pr_number INTEGER,
          deploy_started_at TEXT,
          ci_started_at TEXT,
          fix_reason TEXT,
          merge_attempt_count INTEGER NOT NULL DEFAULT 0,
          done_at TEXT,
          parent_identifier TEXT,
          is_parent INTEGER NOT NULL DEFAULT 0,
          project_name TEXT,
          task_type TEXT NOT NULL DEFAULT 'linear',
          cron_schedule_id INTEGER,
          agent_id TEXT,
          last_failure_reason TEXT,
          last_failed_phase TEXT,
          last_failed_at TEXT,
          pr_url TEXT,
          pr_state TEXT,
          hidden INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        )
      `);

      sqlite.exec(`
        INSERT INTO tasks_new (
          linear_issue_id, agent_prompt, repo_path, lifecycle_stage, current_phase,
          priority, retry_count, pr_branch_name,
          merge_commit_sha, pr_number, deploy_started_at, ci_started_at,
          fix_reason, merge_attempt_count,
          done_at, parent_identifier, is_parent, project_name,
          task_type, cron_schedule_id, agent_id,
          last_failure_reason, last_failed_phase, last_failed_at,
          pr_url, pr_state, hidden, created_at, updated_at
        )
        SELECT
          linear_issue_id, agent_prompt, repo_path, lifecycle_stage, current_phase,
          priority, retry_count, pr_branch_name,
          merge_commit_sha, pr_number, deploy_started_at, ci_started_at,
          fix_reason, merge_attempt_count,
          done_at, parent_identifier, is_parent, project_name,
          task_type, cron_schedule_id, agent_id,
          last_failure_reason, last_failed_phase, last_failed_at,
          pr_url, pr_state, hidden, created_at, updated_at
        FROM tasks
      `);

      sqlite.exec("DROP TABLE tasks");
      sqlite.exec("ALTER TABLE tasks_new RENAME TO tasks");

      // Recreate indexes
      sqlite.exec(
        "CREATE INDEX IF NOT EXISTS idx_tasks_lifecycle_stage ON tasks(lifecycle_stage)",
      );

      sqlite.exec("COMMIT");
    } catch (err) {
      sqlite.exec("ROLLBACK");
      throw err;
    }

    sqlite.pragma("foreign_keys = ON");
  }

  // ---------------------------------------------------------------------------
  // Migration 27 (remove budget system):
  //   - Drop budget_events table if it exists
  //   - Remove review_cycle_count and stale_session_retry_count from tasks
  //     (rebuild table without them if they still exist)
  //   Sentinel: budget_events table exists OR review_cycle_count column exists.
  // ---------------------------------------------------------------------------
  const budgetTableExists =
    (sqlite.pragma("table_info(budget_events)") as { name: string }[]).length >
    0;
  if (budgetTableExists) {
    sqlite.exec("DROP TABLE budget_events");
  }

  if (
    hasColumn(sqlite, "tasks", "review_cycle_count") ||
    hasColumn(sqlite, "tasks", "stale_session_retry_count")
  ) {
    sqlite.pragma("foreign_keys = OFF");

    sqlite.exec("BEGIN TRANSACTION");
    try {
      sqlite.exec(`
        CREATE TABLE tasks_new (
          linear_issue_id TEXT PRIMARY KEY,
          agent_prompt TEXT NOT NULL,
          repo_path TEXT NOT NULL,
          lifecycle_stage TEXT NOT NULL DEFAULT 'ready',
          current_phase TEXT,
          priority INTEGER NOT NULL DEFAULT 0 CHECK(priority >= 0 AND priority <= 4),
          retry_count INTEGER NOT NULL DEFAULT 0,
          pr_branch_name TEXT,
          merge_commit_sha TEXT,
          pr_number INTEGER,
          deploy_started_at TEXT,
          ci_started_at TEXT,
          fix_reason TEXT,
          merge_attempt_count INTEGER NOT NULL DEFAULT 0,
          done_at TEXT,
          parent_identifier TEXT,
          is_parent INTEGER NOT NULL DEFAULT 0,
          project_name TEXT,
          task_type TEXT NOT NULL DEFAULT 'linear',
          cron_schedule_id INTEGER,
          agent_id TEXT,
          last_failure_reason TEXT,
          last_failed_phase TEXT,
          last_failed_at TEXT,
          pr_url TEXT,
          pr_state TEXT,
          hidden INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        )
      `);

      sqlite.exec(`
        INSERT INTO tasks_new (
          linear_issue_id, agent_prompt, repo_path, lifecycle_stage, current_phase,
          priority, retry_count, pr_branch_name,
          merge_commit_sha, pr_number, deploy_started_at, ci_started_at,
          fix_reason, merge_attempt_count,
          done_at, parent_identifier, is_parent, project_name,
          task_type, cron_schedule_id, agent_id,
          last_failure_reason, last_failed_phase, last_failed_at,
          pr_url, pr_state, hidden, created_at, updated_at
        )
        SELECT
          linear_issue_id, agent_prompt, repo_path, lifecycle_stage, current_phase,
          priority, retry_count, pr_branch_name,
          merge_commit_sha, pr_number, deploy_started_at, ci_started_at,
          fix_reason, merge_attempt_count,
          done_at, parent_identifier, is_parent, project_name,
          task_type, cron_schedule_id, agent_id,
          last_failure_reason, last_failed_phase, last_failed_at,
          pr_url, pr_state, hidden, created_at, updated_at
        FROM tasks
      `);

      sqlite.exec("DROP TABLE tasks");
      sqlite.exec("ALTER TABLE tasks_new RENAME TO tasks");

      // Recreate indexes
      sqlite.exec(
        "CREATE INDEX IF NOT EXISTS idx_tasks_lifecycle_stage ON tasks(lifecycle_stage)",
      );

      sqlite.exec("COMMIT");
    } catch (err) {
      sqlite.exec("ROLLBACK");
      throw err;
    }

    sqlite.pragma("foreign_keys = ON");
  }
}

export type OrcaDb = ReturnType<typeof createDb>;

export function createDb(dbPath: string) {
  const sqlite = new Database(dbPath);

  // Enable WAL mode for better concurrent reads
  sqlite.pragma("journal_mode = WAL");
  // Enable foreign key enforcement (off by default in SQLite)
  sqlite.pragma("foreign_keys = ON");

  const db = drizzle(sqlite, { schema });

  // Create tables using better-sqlite3's exec method (not child_process)
  sqlite.exec(CREATE_TASKS);
  sqlite.exec(CREATE_INVOCATIONS);
  sqlite.exec(CREATE_CRON_SCHEDULES);
  sqlite.exec(CREATE_CRON_RUNS);
  sqlite.exec(CREATE_SYSTEM_EVENTS);
  sqlite.exec(CREATE_TASK_STATE_TRANSITIONS);
  sqlite.exec(CREATE_AGENTS);
  sqlite.exec(CREATE_AGENT_MEMORIES);
  sqlite.exec(CREATE_HOOK_EVENTS);

  // Migrations for existing databases — add new columns if they don't exist.
  // SQLite doesn't support IF NOT EXISTS on ALTER TABLE, so we check pragma first.
  migrateSchema(sqlite);

  return db;
}
