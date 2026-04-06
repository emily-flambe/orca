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

export const LIFECYCLE_STAGES = [
  "backlog",
  "ready",
  "active",
  "done",
  "failed",
  "canceled",
] as const;
export type LifecycleStage = (typeof LIFECYCLE_STAGES)[number];

export const CURRENT_PHASES = ["implement", "fix", "ci", "deploy"] as const;
export type CurrentPhase = (typeof CURRENT_PHASES)[number];

/**
 * Derive a human-readable status label from lifecycle_stage + current_phase.
 * Used for display in API responses, UI, and Linear write-back mapping.
 */
export function statusLabel(
  stage: LifecycleStage,
  phase: CurrentPhase | null,
): string {
  if (stage === "active" && phase) {
    switch (phase) {
      case "implement":
        return "running";
      case "fix":
        return "running";
      case "ci":
        return "awaiting_ci";
      case "deploy":
        return "deploying";
    }
  }
  return stage;
}

/**
 * Convert a legacy status label (e.g. "running", "in_review") back to
 * { stage, phase }. Inverse of statusLabel(). If the label is already a
 * valid LifecycleStage, phase defaults to null.
 */
export function labelToStagePhase(label: string): {
  stage: LifecycleStage;
  phase: CurrentPhase | null;
} {
  switch (label) {
    case "running":
      return { stage: "active", phase: "implement" };
    case "in_review":
      // Legacy: in_review no longer exists, map to implement for backwards compat
      return { stage: "active", phase: "implement" };
    case "changes_requested":
      return { stage: "active", phase: "fix" };
    case "awaiting_ci":
      return { stage: "active", phase: "ci" };
    case "deploying":
      return { stage: "active", phase: "deploy" };
    default:
      return { stage: label as LifecycleStage, phase: null };
  }
}

/**
 * Legacy TaskStatus — derived from lifecycle_stage + current_phase.
 * Kept for backwards compatibility with API responses and Linear write-back.
 */
export const TASK_STATUSES = [
  "backlog",
  "ready",
  "running",
  "done",
  "failed",
  "canceled",
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
  lifecycleStage: LifecycleStage;
  currentPhase: CurrentPhase | null;
  priority: number;
  retryCount: number;
  prBranchName: string | null;
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
  concurrencyCap: number;
  agentConcurrencyCap: number;
  model: string;
  draining: boolean;
  drainSessionCount: number;
  drainingForSeconds: number | null;
}
