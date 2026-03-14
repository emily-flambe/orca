/**
 * Polls GitHub Actions workflow run status for a deployed commit.
 * Extracted from scheduler's checkDeployments() for use in Inngest workflows.
 *
 * This is a single poll check — the Inngest workflow handles the polling loop
 * with step.sleep().
 */

import { getWorkflowRunStatus } from "../../github/index.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type DeployStatus = "in_progress" | "success" | "failure" | "timed_out";

export interface CheckDeployInput {
  mergeCommitSha: string;
  repoPath: string;
  deployStartedAt: string;
  deployTimeoutMin: number;
}

export interface CheckDeployOutput {
  status: DeployStatus;
  message: string;
}

// ---------------------------------------------------------------------------
// Activity
// ---------------------------------------------------------------------------

export async function checkDeployStatus(
  input: CheckDeployInput,
): Promise<CheckDeployOutput> {
  const { mergeCommitSha, repoPath, deployStartedAt, deployTimeoutMin } = input;

  // Check timeout first — no point polling GitHub if we've already exceeded
  const startedAtMs = new Date(deployStartedAt).getTime();
  const timeoutMs = deployTimeoutMin * 60 * 1000;
  const now = Date.now();

  if (startedAtMs + timeoutMs < now) {
    return {
      status: "timed_out",
      message: `Deploy timed out after ${deployTimeoutMin}min (started ${deployStartedAt})`,
    };
  }

  // Poll GitHub Actions for the workflow run status
  const runStatus = await getWorkflowRunStatus(mergeCommitSha, repoPath);

  switch (runStatus) {
    case "success":
      return {
        status: "success",
        message: `Deploy succeeded for commit ${mergeCommitSha}`,
      };

    case "failure":
      return {
        status: "failure",
        message: `Deploy CI failed for commit ${mergeCommitSha}`,
      };

    case "in_progress":
    case "pending":
    case "no_runs":
      // All treated as "still going" — the Inngest workflow will sleep and retry
      return {
        status: "in_progress",
        message:
          runStatus === "no_runs"
            ? `No workflow runs found yet for commit ${mergeCommitSha}`
            : `Deploy in progress for commit ${mergeCommitSha}`,
      };
  }
}
