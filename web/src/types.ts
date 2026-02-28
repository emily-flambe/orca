export interface Task {
  linearIssueId: string;
  agentPrompt: string;
  repoPath: string;
  orcaStatus: "ready" | "dispatched" | "running" | "done" | "failed" | "in_review" | "changes_requested" | "deploying";
  priority: number;
  retryCount: number;
  prBranchName: string | null;
  reviewCycleCount: number;
  mergeCommitSha: string | null;
  prNumber: number | null;
  deployStartedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Invocation {
  id: number;
  linearIssueId: string;
  startedAt: string;
  endedAt: string | null;
  status: "running" | "completed" | "failed" | "timed_out";
  sessionId: string | null;
  branchName: string | null;
  worktreePath: string | null;
  costUsd: number | null;
  numTurns: number | null;
  outputSummary: string | null;
  logPath: string | null;
  phase: string | null;
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
}
