// Shared pure TypeScript types — no drizzle-orm dependencies.
// Used by both backend (src/) and frontend (web/src/).

export const CRON_TYPES = ["claude", "shell"] as const;
export type CronType = (typeof CRON_TYPES)[number];

export const TASK_TYPES = ["linear", "cron_claude", "cron_shell"] as const;
export type TaskType = (typeof TASK_TYPES)[number];

export const TASK_STATUSES = [
  "backlog",
  "ready",
  "dispatched",
  "running",
  "done",
  "failed",
  "canceled",
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

export interface Task {
  linearIssueId: string;
  agentPrompt: string;
  repoPath: string;
  orcaStatus: TaskStatus;
  priority: number;
  retryCount: number;
  prBranchName: string | null;
  reviewCycleCount: number;
  mergeCommitSha: string | null;
  prNumber: number | null;
  deployStartedAt: string | null;
  ciStartedAt: string | null;
  doneAt: string | null;
  projectName: string | null;
  invocationCount: number;
  createdAt: string;
  updatedAt: string;
  taskType: TaskType;
  cronScheduleId: number | null;
}

export interface CronSchedule {
  id: number;
  name: string;
  type: CronType;
  schedule: string;
  prompt: string;
  repoPath: string | null;
  model: string | null;
  maxTurns: number | null;
  timeoutMin: number;
  maxRuns: number | null;
  runCount: number;
  enabled: number; // 1 or 0 (SQLite boolean)
  lastRunAt: string | null;
  nextRunAt: string | null;
  lastRunStatus: "success" | "failed" | null;
  createdAt: string;
  updatedAt: string;
}

export interface Invocation {
  id: number;
  linearIssueId: string;
  startedAt: string;
  endedAt: string | null;
  status: InvocationStatus;
  sessionId: string | null;
  branchName: string | null;
  worktreePath: string | null;
  costUsd: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  numTurns: number | null;
  outputSummary: string | null;
  logPath: string | null;
  phase: string | null;
  model: string | null;
  agentPrompt: string | null;
}

export interface TaskWithInvocations extends Task {
  invocations: Invocation[];
}

export interface OrcaStatus {
  activeSessions: number;
  activeTaskIds: string[];
  queuedTasks: number;
  costInWindow: number;
  budgetLimit: number;
  budgetWindowHours: number;
  tokensInWindow: number;
  tokenBudgetLimit: number;
  concurrencyCap: number;
  implementModel: string;
  reviewModel: string;
  fixModel: string;
  draining: boolean;
  drainSessionCount: number;
  // Session metrics (cc-statusline style)
  burnRatePerHour: number | null;
  tokensPerMinute: number | null;
  inputTokensInWindow: number;
  outputTokensInWindow: number;
}
