import { sqliteTable, text, integer, real } from "drizzle-orm/sqlite-core";

export const TASK_STATUSES = [
  "backlog",
  "ready",
  "dispatched",
  "running",
  "done",
  "failed",
  "in_review",
  "changes_requested",
  "deploying",
  "awaiting_ci",
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const INVOCATION_STATUSES = [
  "running",
  "completed",
  "failed",
  "timed_out",
] as const;
export type InvocationStatus = (typeof INVOCATION_STATUSES)[number];

export const tasks = sqliteTable("tasks", {
  linearIssueId: text("linear_issue_id").primaryKey(),
  agentPrompt: text("agent_prompt").notNull(),
  repoPath: text("repo_path").notNull(),
  orcaStatus: text("orca_status", { enum: TASK_STATUSES }).notNull(),
  priority: integer("priority").notNull().default(0),
  retryCount: integer("retry_count").notNull().default(0),
  prBranchName: text("pr_branch_name"),
  reviewCycleCount: integer("review_cycle_count").notNull().default(0),
  mergeCommitSha: text("merge_commit_sha"),
  prNumber: integer("pr_number"),
  deployStartedAt: text("deploy_started_at"),
  ciStartedAt: text("ci_started_at"),
  doneAt: text("done_at"),
  parentIdentifier: text("parent_identifier"),
  isParent: integer("is_parent").notNull().default(0),
  projectName: text("project_name"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const invocations = sqliteTable("invocations", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  linearIssueId: text("linear_issue_id")
    .notNull()
    .references(() => tasks.linearIssueId),
  startedAt: text("started_at").notNull(),
  endedAt: text("ended_at"),
  status: text("status", { enum: INVOCATION_STATUSES }).notNull(),
  sessionId: text("session_id"),
  branchName: text("branch_name"),
  worktreePath: text("worktree_path"),
  costUsd: real("cost_usd"),
  numTurns: integer("num_turns"),
  outputSummary: text("output_summary"),
  logPath: text("log_path"),
  phase: text("phase"),
});

export const budgetEvents = sqliteTable("budget_events", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  invocationId: integer("invocation_id")
    .notNull()
    .references(() => invocations.id),
  costUsd: real("cost_usd").notNull(),
  recordedAt: text("recorded_at").notNull(),
});
