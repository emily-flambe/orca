export interface Task {
  linearIssueId: string;
  agentPrompt: string;
  repoPath: string;
  orcaStatus: "backlog" | "ready" | "dispatched" | "running" | "done" | "failed" | "in_review" | "changes_requested" | "deploying" | "awaiting_ci";
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
  concurrencyCap: number;
}

export interface ObservabilityMetrics {
  tasksByStatus: Record<string, number>;
  invocationsByStatus: Record<string, number>;
  totalCostAllTime: number;
  costByDay: { date: string; cost: number }[];
  avgSessionDuration: number;
  totalInvocations: number;
  recentCompletions: {
    id: number;
    linearIssueId: string;
    startedAt: string;
    endedAt: string | null;
    status: string;
    costUsd: number | null;
    numTurns: number | null;
    phase: string | null;
  }[];
}

export interface ObservabilityErrors {
  recentErrors: {
    id: number;
    linearIssueId: string;
    startedAt: string;
    endedAt: string | null;
    outputSummary: string | null;
    phase: string | null;
    costUsd: number | null;
  }[];
  errorPatterns: {
    pattern: string;
    count: number;
    lastSeen: string;
  }[];
  failureRate: {
    total: number;
    failed: number;
    rate: number;
  };
}

export interface LogSearchResult {
  results: {
    invocationId: number;
    linearIssueId: string;
    startedAt: string;
    matches: {
      lineIndex: number;
      type: string;
      text: string;
    }[];
  }[];
  totalMatches: number;
}
