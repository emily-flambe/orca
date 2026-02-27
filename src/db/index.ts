import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema.js";

const CREATE_TASKS = `
CREATE TABLE IF NOT EXISTS tasks (
  linear_issue_id TEXT PRIMARY KEY,
  agent_prompt TEXT NOT NULL,
  repo_path TEXT NOT NULL,
  orca_status TEXT NOT NULL CHECK(orca_status IN ('ready','dispatched','running','done','failed')),
  priority INTEGER NOT NULL DEFAULT 0 CHECK(priority >= 0 AND priority <= 4),
  retry_count INTEGER NOT NULL DEFAULT 0,
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
  log_path TEXT
)`;

const CREATE_BUDGET_EVENTS = `
CREATE TABLE IF NOT EXISTS budget_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  invocation_id INTEGER NOT NULL REFERENCES invocations(id),
  cost_usd REAL NOT NULL,
  recorded_at TEXT NOT NULL
)`;

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

  return db;
}
