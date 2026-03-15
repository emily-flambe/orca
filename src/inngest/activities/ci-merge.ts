/**
 * CI status checking and PR merge logic.
 * Extracted from scheduler's checkPrCi() and mergeAndFinalize() for Inngest workflows.
 *
 * These functions are pure GitHub operations — no DB writes, no Linear
 * write-back, no event emissions. The calling Inngest workflow is responsible
 * for orchestrating retries, state transitions, and side effects.
 */

import {
  getPrCheckStatus,
  getPrMergeState,
  mergePr,
  updatePrBranch,
  rebasePrBranch,
  getMergeCommitSha,
  findPrForBranch,
} from "../../github/index.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CiStatus = "pending" | "success" | "failure";

export type MergeStatus =
  | "merged"
  | "behind"
  | "conflicting"
  | "blocked"
  | "failed"
  | "already_merged";

export interface CheckCiInput {
  prNumber: number;
  repoPath: string;
}

export interface CheckCiOutput {
  status: CiStatus;
}

export interface AttemptMergeInput {
  prNumber: number;
  prBranchName: string;
  repoPath: string;
  mergeAttempt: number; // current attempt (0-based)
  maxMergeAttempts: number; // typically 3
}

export interface AttemptMergeOutput {
  status: MergeStatus;
  mergeCommitSha: string | null;
  message: string;
}

// ---------------------------------------------------------------------------
// checkCiStatus — single CI poll (Inngest handles the polling loop)
// ---------------------------------------------------------------------------

export async function checkCiStatus(
  input: CheckCiInput,
): Promise<CheckCiOutput> {
  const status = await getPrCheckStatus(input.prNumber, input.repoPath);

  if (status === "success" || status === "no_checks") {
    return { status: "success" };
  }
  if (status === "failure") {
    return { status: "failure" };
  }
  // "pending" or "error" — Inngest will sleep and call again
  return { status: "pending" };
}

// ---------------------------------------------------------------------------
// attemptMerge — single merge attempt (Inngest workflow handles retry loop)
// ---------------------------------------------------------------------------

export async function attemptMerge(
  input: AttemptMergeInput,
): Promise<AttemptMergeOutput> {
  const { prNumber, prBranchName, repoPath, mergeAttempt, maxMergeAttempts } =
    input;

  // 1. Pre-flight: check merge state
  const mergeState = await getPrMergeState(prNumber, repoPath);

  if (mergeState.mergeStateStatus === "BEHIND") {
    // Branch is behind main but has no conflicts — update it.
    // Caller should re-poll CI before attempting merge again.
    await updatePrBranch(prNumber, repoPath);
    return {
      status: "behind",
      mergeCommitSha: null,
      message: `PR #${prNumber} is behind base branch — updated. Re-check CI before retrying merge.`,
    };
  }

  if (mergeState.mergeStateStatus === "CONFLICTING") {
    return {
      status: "conflicting",
      mergeCommitSha: null,
      message: `PR #${prNumber} has merge conflicts — requires conflict resolution.`,
    };
  }

  // 2. Attempt merge
  const mergeResult = await mergePr(prNumber, repoPath);

  if (mergeResult.merged) {
    // 3. Get merge commit SHA
    const sha = await getMergeCommitSha(prNumber, repoPath);
    return {
      status: "merged",
      mergeCommitSha: sha,
      message: `PR #${prNumber} merged successfully.`,
    };
  }

  // Merge failed — check if already merged (race condition)
  const prInfo = await findPrForBranch(prBranchName, repoPath);
  if (prInfo.merged) {
    const sha = await getMergeCommitSha(prNumber, repoPath);
    return {
      status: "already_merged",
      mergeCommitSha: sha,
      message: `PR #${prNumber} was already merged.`,
    };
  }

  // 4. On first attempt failure, try rebase then signal caller to retry
  if (mergeAttempt === 0) {
    const rebaseResult = rebasePrBranch(prBranchName, repoPath);

    if (rebaseResult.success) {
      // Rebase succeeded, force-pushed. CI will re-run.
      // Return "behind" so the workflow knows to re-poll CI.
      return {
        status: "behind",
        mergeCommitSha: null,
        message: `Merge failed for PR #${prNumber}: ${mergeResult.error}. Rebased branch onto main and force-pushed — CI will re-run.`,
      };
    }

    if (rebaseResult.hasConflicts) {
      return {
        status: "conflicting",
        mergeCommitSha: null,
        message: `Merge failed for PR #${prNumber} and rebase has conflicts — requires conflict resolution.`,
      };
    }

    // Rebase failed for non-conflict reason — fall through to retry/fail logic
  }

  // 5. Still within retry budget?
  if (mergeAttempt + 1 < maxMergeAttempts) {
    return {
      status: "failed",
      mergeCommitSha: null,
      message: `Merge attempt ${mergeAttempt + 1}/${maxMergeAttempts} failed for PR #${prNumber}: ${mergeResult.error}. Will retry.`,
    };
  }

  // Exhausted retries
  return {
    status: "failed",
    mergeCommitSha: null,
    message: `Merge failed after ${mergeAttempt + 1} attempts for PR #${prNumber}: ${mergeResult.error}. Exhausted retries.`,
  };
}
