import Database, { type Database as DatabaseType } from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema.js";

const CREATE_TASKS = `
CREATE TABLE IF NOT EXISTS tasks (
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
  ci_started_at TEXT,
  fix_reason TEXT,
  merge_attempt_count INTEGER NOT NULL DEFAULT 0,
  stale_session_retry_count INTEGER NOT NULL DEFAULT 0,
  done_at TEXT,
  parent_identifier TEXT,
  is_parent INTEGER NOT NULL DEFAULT 0,
  project_name TEXT,
  task_type TEXT NOT NULL DEFAULT 'linear',
  cron_schedule_id INTEGER,
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

const CREATE_BUDGET_EVENTS = `
CREATE TABLE IF NOT EXISTS budget_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  invocation_id INTEGER NOT NULL REFERENCES invocations(id),
  cost_usd REAL NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  recorded_at TEXT NOT NULL
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
  //   - Add input_tokens, output_tokens columns to invocations and budget_events
  //   Sentinel: input_tokens column doesn't exist on invocations table.
  // ---------------------------------------------------------------------------
  if (!hasColumn(sqlite, "invocations", "input_tokens")) {
    sqlite.exec("ALTER TABLE invocations ADD COLUMN input_tokens INTEGER");
    sqlite.exec("ALTER TABLE invocations ADD COLUMN output_tokens INTEGER");
    sqlite.exec(
      "ALTER TABLE budget_events ADD COLUMN input_tokens INTEGER NOT NULL DEFAULT 0",
    );
    sqlite.exec(
      "ALTER TABLE budget_events ADD COLUMN output_tokens INTEGER NOT NULL DEFAULT 0",
    );
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
  sqlite.exec(
    "CREATE INDEX IF NOT EXISTS idx_tasks_orca_status ON tasks(orca_status)",
  );
  sqlite.exec(
    "CREATE INDEX IF NOT EXISTS idx_invocations_status ON invocations(status)",
  );
  sqlite.exec(
    "CREATE INDEX IF NOT EXISTS idx_invocations_linear_issue_id ON invocations(linear_issue_id)",
  );
  sqlite.exec(
    "CREATE INDEX IF NOT EXISTS idx_budget_events_recorded_at ON budget_events(recorded_at)",
  );
  sqlite.exec(
    "CREATE INDEX IF NOT EXISTS idx_budget_events_invocation_id ON budget_events(invocation_id)",
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
  sqlite.exec(CREATE_BUDGET_EVENTS);
  sqlite.exec(CREATE_CRON_SCHEDULES);
  sqlite.exec(CREATE_CRON_RUNS);
  sqlite.exec(CREATE_SYSTEM_EVENTS);
  sqlite.exec(CREATE_TASK_STATE_TRANSITIONS);

  // Migrations for existing databases — add new columns if they don't exist.
  // SQLite doesn't support IF NOT EXISTS on ALTER TABLE, so we check pragma first.
  migrateSchema(sqlite);

  return db;
}
