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

export interface MetricsSummary {
  total: number;
  completed: number;
  failed: number;
  timedOut: number;
  running: number;
  finished: number;
  totalCost: number;
  avgCost: number;
  avgDurationMs: number;
  avgTurns: number;
}

export interface DailyMetric {
  date: string;
  count: number;
  completed: number;
  failed: number;
  timedOut: number;
  running: number;
  totalCost: number;
  avgDurationMs: number;
}

export interface TaskCost {
  taskId: string;
  totalCost: number;
  invocationCount: number;
}

export interface MetricsResponse {
  summary: MetricsSummary;
  daily: DailyMetric[];
  topTasks: TaskCost[];
}

export interface ErrorPattern {
  pattern: string;
  count: number;
  lastSeen: string;
  affectedTasks: string[];
  status: string;
}

export interface RecentError {
  id: number;
  taskId: string;
  status: string;
  startedAt: string;
  endedAt: string | null;
  outputSummary: string | null;
  phase: string | null;
  costUsd: number | null;
}

export interface ErrorsResponse {
  patterns: ErrorPattern[];
  recentErrors: RecentError[];
}

export interface LogsResponse {
  lines: string[];
  totalLines: number;
  matchedLines: number;
}
