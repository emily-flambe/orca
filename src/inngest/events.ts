import { EventSchemas } from "inngest";

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
      previousStatus: string;
    };
  };
  "session/completed": {
    data: {
      invocationId: number;
      linearIssueId: string;
      phase: "implement";
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
      isResumeNotFound: boolean;
      isRateLimited: boolean;
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
};

export const schemas = new EventSchemas().fromRecord<OrcaEvents>();
