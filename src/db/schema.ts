import { sqliteTable, text, integer, real } from "drizzle-orm/sqlite-core";
export {
  CRON_TYPES,
  type CronType,
  TASK_TYPES,
  type TaskType,
  TASK_STATUSES,
  type TaskStatus,
  INVOCATION_STATUSES,
  type InvocationStatus,
  AGENT_MEMORY_TYPES,
  type AgentMemoryType,
} from "../shared/types.js";
import {
  CRON_TYPES,
  AGENT_MEMORY_TYPES,
  TASK_STATUSES,
  INVOCATION_STATUSES,
} from "../shared/types.js";

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
  fixReason: text("fix_reason"),
  mergeAttemptCount: integer("merge_attempt_count").notNull().default(0),
  staleSessionRetryCount: integer("stale_session_retry_count")
    .notNull()
    .default(0),
  doneAt: text("done_at"),
  parentIdentifier: text("parent_identifier"),
  isParent: integer("is_parent").notNull().default(0),
  projectName: text("project_name"),
  taskType: text("task_type").notNull().default("linear"),
  cronScheduleId: integer("cron_schedule_id"),
  agentId: text("agent_id"),
  lastFailureReason: text("last_failure_reason"),
  lastFailedPhase: text("last_failed_phase"),
  lastFailedAt: text("last_failed_at"),
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
  worktreePreserved: integer("worktree_preserved").notNull().default(0),
  costUsd: real("cost_usd"),
  inputTokens: integer("input_tokens"),
  outputTokens: integer("output_tokens"),
  numTurns: integer("num_turns"),
  outputSummary: text("output_summary"),
  logPath: text("log_path"),
  phase: text("phase", { enum: ["implement", "review"] as const }),
  model: text("model"),
});

export const budgetEvents = sqliteTable("budget_events", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  invocationId: integer("invocation_id")
    .notNull()
    .references(() => invocations.id),
  costUsd: real("cost_usd").notNull(),
  inputTokens: integer("input_tokens").notNull().default(0),
  outputTokens: integer("output_tokens").notNull().default(0),
  recordedAt: text("recorded_at").notNull(),
});

export const systemEvents = sqliteTable("system_events", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  type: text("type", {
    enum: [
      "startup",
      "shutdown",
      "restart",
      "error",
      "health_check",
      "task_completed",
      "task_failed",
      "deploy",
      "self_heal",
      "auto_retry",
    ] as const,
  }).notNull(),
  message: text("message").notNull(),
  metadata: text("metadata"), // JSON string for extra context
  createdAt: text("created_at").notNull(),
});

export const taskStateTransitions = sqliteTable("task_state_transitions", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  linearIssueId: text("linear_issue_id").notNull(),
  fromStatus: text("from_status"),
  toStatus: text("to_status").notNull(),
  reason: text("reason"),
  invocationId: integer("invocation_id"),
  createdAt: text("created_at").notNull(),
});

export const cronSchedules = sqliteTable("cron_schedules", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  type: text("type", { enum: CRON_TYPES }).notNull(),
  schedule: text("schedule").notNull(),
  prompt: text("prompt").notNull(),
  repoPath: text("repo_path"),
  model: text("model"),
  maxTurns: integer("max_turns"),
  timeoutMin: integer("timeout_min").notNull().default(30),
  maxRuns: integer("max_runs"),
  runCount: integer("run_count").notNull().default(0),
  enabled: integer("enabled").notNull().default(1),
  lastRunAt: text("last_run_at"),
  nextRunAt: text("next_run_at"),
  lastRunStatus: text("last_run_status"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const agents = sqliteTable("agents", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description"),
  systemPrompt: text("system_prompt").notNull(),
  model: text("model"),
  maxTurns: integer("max_turns"),
  timeoutMin: integer("timeout_min").notNull().default(45),
  repoPath: text("repo_path"),
  schedule: text("schedule"),
  maxMemories: integer("max_memories").notNull().default(200),
  enabled: integer("enabled").notNull().default(1),
  runCount: integer("run_count").notNull().default(0),
  lastRunAt: text("last_run_at"),
  nextRunAt: text("next_run_at"),
  lastRunStatus: text("last_run_status"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const agentMemories = sqliteTable("agent_memories", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  agentId: text("agent_id").notNull(),
  type: text("type", { enum: AGENT_MEMORY_TYPES }).notNull(),
  content: text("content").notNull(),
  sourceRunId: text("source_run_id"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const cronRuns = sqliteTable("cron_runs", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  cronScheduleId: integer("cron_schedule_id").notNull(),
  startedAt: text("started_at").notNull(),
  endedAt: text("ended_at"),
  status: text("status").notNull(), // "running", "success", "failed"
  output: text("output"),
  durationMs: integer("duration_ms"),
});

export const hookEvents = sqliteTable("hook_events", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  invocationId: integer("invocation_id").notNull(),
  eventType: text("event_type").notNull(), // "Notification", "Stop", etc.
  payload: text("payload").notNull(), // JSON string
  receivedAt: text("received_at").notNull(),
});
