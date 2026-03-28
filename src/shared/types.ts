// Shared pure TypeScript types — no drizzle-orm dependencies.
// Used by both backend (src/) and frontend (web/src/).

export const CRON_TYPES = ["claude", "shell"] as const;
export type CronType = (typeof CRON_TYPES)[number];

export const TASK_TYPES = [
  "linear",
  "cron_claude",
  "cron_shell",
  "agent",
] as const;
export type TaskType = (typeof TASK_TYPES)[number];

export const TASK_STATUSES = [
  "backlog",
  "ready",
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

export const LIFECYCLE_STAGES = [
  "backlog",
  "ready",
  "active",
  "done",
  "failed",
  "canceled",
] as const;
export type LifecycleStage = (typeof LIFECYCLE_STAGES)[number];

export const CURRENT_PHASES = [
  "implement",
  "review",
  "fix",
  "ci",
  "deploy",
] as const;
export type CurrentPhase = (typeof CURRENT_PHASES)[number];

export const INVOCATION_STATUSES = [
  "running",
  "completed",
  "failed",
  "timed_out",
] as const;
export type InvocationStatus = (typeof INVOCATION_STATUSES)[number];

export const AGENT_MEMORY_TYPES = [
  "episodic",
  "semantic",
  "procedural",
] as const;
export type AgentMemoryType = (typeof AGENT_MEMORY_TYPES)[number];

export interface Task {
  linearIssueId: string;
  agentPrompt: string;
  repoPath: string;
  orcaStatus: TaskStatus;
  lifecycleStage: LifecycleStage | null;
  currentPhase: CurrentPhase | null;
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
  agentId: string | null;
  lastFailureReason: string | null;
  lastFailedPhase: string | null;
  lastFailedAt: string | null;
  prUrl: string | null;
  prState: "draft" | "open" | "merged" | "closed" | null;
  hidden: number; // 0 = visible, 1 = hidden
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

export interface CronRun {
  id: number;
  cronScheduleId: number;
  startedAt: string;
  endedAt: string | null;
  status: string;
  output: string | null;
  durationMs: number | null;
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

export interface Agent {
  id: string;
  name: string;
  description: string | null;
  systemPrompt: string;
  model: string | null;
  maxTurns: number | null;
  timeoutMin: number;
  repoPath: string | null;
  schedule: string | null;
  maxMemories: number;
  enabled: number; // 1 or 0 (SQLite boolean)
  linearLabel: string | null;
  runCount: number;
  lastRunAt: string | null;
  nextRunAt: string | null;
  lastRunStatus: "success" | "failed" | null;
  createdAt: string;
  updatedAt: string;
}

export interface AgentMemory {
  id: number;
  agentId: string;
  type: AgentMemoryType;
  content: string;
  sourceRunId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface OrcaStatus {
  activeSessions: number;
  activeTaskIds: string[];
  queuedTasks: number;
  budgetWindowHours: number;
  tokensInWindow: number;
  tokenBudgetLimit: number;
  concurrencyCap: number;
  agentConcurrencyCap: number;
  model: string;
  reviewModel: string;
  draining: boolean;
  drainSessionCount: number;
  drainingForSeconds?: number;
  // Session metrics
  tokensPerMinute: number | null;
  inputTokensInWindow: number;
  outputTokensInWindow: number;
}
