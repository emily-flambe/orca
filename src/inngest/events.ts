import { EventSchemas } from "inngest";
import { type TaskStatus } from "../shared/types.js";

// Event payload types for Orca's Inngest events.
// Event names follow the `noun/verb` convention used by Inngest.

export type OrcaEvents = {
  "task/ready": {
    data: {
      linearIssueId: string;
      repoPath: string;
      priority: number;
      projectName: string | null;
      taskType: string;
      createdAt: string;
    };
  };
  "task/cancelled": {
    data: {
      linearIssueId: string;
      reason: string;
      retryCount: number;
      previousStatus: TaskStatus;
    };
  };
  "session/completed": {
    data: {
      invocationId: number;
      linearIssueId: string;
      phase: "implement" | "review";
      exitCode: number;
      summary: string | null;
      costUsd: number | null;
      inputTokens: number | null;
      outputTokens: number | null;
      numTurns: number | null;
      sessionId: string | null;
      branchName: string | null;
      worktreePath: string | null;
      isMaxTurns: boolean;
    };
  };
  "session/failed": {
    data: {
      invocationId: number;
      linearIssueId: string;
      phase: "implement" | "review";
      exitCode: number;
      errorMessage: string;
      isRateLimited: boolean;
      isContentFiltered: boolean;
      isDllInit: boolean;
      isMaxTurns: boolean;
      sessionId: string | null;
      worktreePath: string | null;
      costUsd: number | null;
      inputTokens: number | null;
      outputTokens: number | null;
    };
  };
  "task/awaiting-ci": {
    data: {
      linearIssueId: string;
      prNumber: number;
      prBranchName: string;
      repoPath: string;
      ciStartedAt: string;
    };
  };
  "task/deploying": {
    data: {
      linearIssueId: string;
      mergeCommitSha: string;
      repoPath: string;
      prNumber: number;
      deployStartedAt: string;
    };
  };
  "task/review-complete": {
    data: {
      linearIssueId: string;
      prNumber: number | null;
      result: "approved" | "changes_requested";
      reviewCycleCount: number;
    };
  };
};

export const schemas = new EventSchemas().fromRecord<OrcaEvents>();
