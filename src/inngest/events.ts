import { EventSchemas } from "inngest";
import { type TaskStatus, type InvocationStatus } from "../shared/types.js";

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
      phase: string;
      costUsd: number | null;
      inputTokens: number | null;
      outputTokens: number | null;
      numTurns: number | null;
      durationMs: number;
      status: InvocationStatus;
    };
  };
  "session/failed": {
    data: {
      invocationId: number;
      linearIssueId: string;
      phase: string;
      reason: string;
      retryCount: number;
      status: InvocationStatus;
    };
  };
  "task/awaiting-ci": {
    data: {
      linearIssueId: string;
      prNumber: number;
      prBranchName: string;
      ciStartedAt: string;
    };
  };
  "task/deploying": {
    data: {
      linearIssueId: string;
      mergeCommitSha: string;
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
