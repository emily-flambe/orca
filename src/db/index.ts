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
  done_at TEXT,
  parent_identifier TEXT,
  is_parent INTEGER NOT NULL DEFAULT 0,
  project_name TEXT,
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
  cost_usd REAL,
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
  recorded_at TEXT NOT NULL
)`;

/**
 * Check if a column exists in a table using PRAGMA table_info.
 */
function hasColumn(sqlite: DatabaseType, table: string, column: string): boolean {
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
      sqlite.exec("ALTER TABLE tasks ADD COLUMN review_cycle_count INTEGER NOT NULL DEFAULT 0");
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
    sqlite.exec("UPDATE tasks SET done_at = updated_at WHERE orca_status = 'done' AND done_at IS NULL");
  }

  // ---------------------------------------------------------------------------
  // Migration 4 (parent/child issue tracking):
  //   - Add parent_identifier column to tasks (FK-like to parent task)
  //   - Add is_parent column (1 = has children, skip dispatch)
  //   Sentinel: parent_identifier column doesn't exist on tasks table.
  // ---------------------------------------------------------------------------
  if (!hasColumn(sqlite, "tasks", "parent_identifier")) {
    sqlite.exec("ALTER TABLE tasks ADD COLUMN parent_identifier TEXT");
    sqlite.exec("ALTER TABLE tasks ADD COLUMN is_parent INTEGER NOT NULL DEFAULT 0");
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

  // Migrations for existing databases — add new columns if they don't exist.
  // SQLite doesn't support IF NOT EXISTS on ALTER TABLE, so we check pragma first.
  migrateSchema(sqlite);

  return db;
}
