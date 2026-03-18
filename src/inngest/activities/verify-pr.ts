/**
 * Gate 2: Post-implementation PR verification.
 * Extracted from scheduler's onImplementSuccess() for use in Inngest workflows.
 *
 * Pure function: no DB writes, no Linear write-back, no event emissions.
 * Only Git/GitHub operations and text parsing.
 */

import { existsSync } from "node:fs";
import { git } from "../../git.js";
import {
  findPrForBranch,
  findPrByUrl,
  pushAndCreatePr,
  type PrInfo,
} from "../../github/index.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Gate2Result =
  | {
      status: "pr_found";
      prNumber: number;
      prBranch: string;
      repoPath: string;
    }
  | { status: "already_done"; message: string }
  | { status: "no_pr"; message: string }
  | {
      status: "recovery_pushed";
      prNumber: number;
      prBranch: string;
      repoPath: string;
    };

export interface VerifyPrInput {
  taskId: string;
  branchName: string | null;
  repoPath: string;
  summary: string | null;
  worktreePath: string | null;
}

/**
 * Config subset needed by findLocalPathForGithubRepo.
 * Avoids pulling in the full OrcaConfig dependency.
 */
export interface RepoLookupConfig {
  projectRepoMap: Map<string, string>;
  defaultCwd: string | undefined;
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

export const alreadyDonePatterns = [
  "already complete",
  "already implemented",
  "already merged",
  "already on main",
  "already on `main`",
  "already on `origin/main`",
  "already exists",
  "already satisfied",
  "already done",
  "nothing to do",
  "no changes needed",
  "acceptance criteria",
];

/**
 * Returns true if the worktree at `worktreePath` has no commits ahead of
 * `origin/main`. Used to objectively detect "already done" tasks where
 * Claude succeeded but made no changes (because none were needed).
 */
export function worktreeHasNoChanges(worktreePath: string): boolean {
  try {
    if (!existsSync(worktreePath)) return false;
    const diff = git(["diff", "origin/main...HEAD"], { cwd: worktreePath });
    return diff.trim() === "";
  } catch {
    return false;
  }
}

/**
 * Given a GitHub owner/repo slug (e.g. "acme/myrepo"), searches all known
 * local repo paths from the config and returns the first one whose
 * `git remote get-url origin` resolves to that slug.
 *
 * Returns null if no matching local path is found.
 */
function findLocalPathForGithubRepo(
  ownerRepo: string,
  config: RepoLookupConfig,
): string | null {
  const candidates: string[] = [
    ...config.projectRepoMap.values(),
    ...(config.defaultCwd ? [config.defaultCwd] : []),
  ];
  const sshPattern = /github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?$/;
  for (const candidatePath of candidates) {
    try {
      const remoteUrl = git(["remote", "get-url", "origin"], {
        cwd: candidatePath,
      }).trim();
      const m = remoteUrl.match(sshPattern);
      if (m && m[1] === ownerRepo) {
        return candidatePath;
      }
    } catch {
      // path may not exist or may not be a git repo — skip
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Main verification function
// ---------------------------------------------------------------------------

/**
 * Gate 2 verification chain.
 *
 * Determines the outcome of an implement phase by checking whether a PR
 * was created, whether work is already on main, or whether recovery is
 * possible by pushing unpushed commits.
 *
 * @param input - Task metadata and session results
 * @param config - Optional repo lookup config for cross-repo URL resolution.
 *                 If omitted, cross-repo PR URL fallback is skipped.
 */
export async function verifyPr(
  input: VerifyPrInput,
  config?: RepoLookupConfig,
): Promise<Gate2Result> {
  const { taskId, branchName, repoPath, summary, worktreePath } = input;

  const summaryLower = (summary ?? "").toLowerCase();
  const isAlreadyDone = alreadyDonePatterns.some((p) =>
    summaryLower.includes(p),
  );

  // --- No branch name: check if work is already done ---
  if (!branchName) {
    const noChanges = worktreePath ? worktreeHasNoChanges(worktreePath) : false;
    if (noChanges || isAlreadyDone) {
      const reason = noChanges
        ? "no local commits on worktree"
        : "output summary indicates already done";
      return { status: "already_done", message: reason };
    }
    return {
      status: "no_pr",
      message: "no branch name found on invocation or task",
    };
  }

  // --- Step 1: Search for PR by branch name ---
  let prInfo: PrInfo = await findPrForBranch(branchName, repoPath);
  let resolvedRepoPath = repoPath;

  // --- Step 2: Fallback — extract PR URL from summary ---
  if (!prInfo.exists) {
    const rawSummary = summary ?? "";
    const prUrlMatch = rawSummary.match(
      /https:\/\/github\.com\/([^\s/]+)\/([^\s/]+)\/pull\/(\d+)/,
    );
    if (prUrlMatch) {
      const extractedUrl = prUrlMatch[0];

      // Validate the extracted URL belongs to the same repo as repoPath
      let repoUrlPrefix: string | null = null;
      try {
        const remoteUrl = git(["remote", "get-url", "origin"], {
          cwd: repoPath,
        }).trim();
        const sshMatch = remoteUrl.match(
          /github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?$/,
        );
        if (sshMatch) {
          repoUrlPrefix = `https://github.com/${sshMatch[1]}/pull/`;
        }
      } catch {
        // If we can't get the remote URL, skip the validation
      }

      const urlBelongsToRepo =
        repoUrlPrefix === null || extractedUrl.startsWith(repoUrlPrefix);

      if (urlBelongsToRepo) {
        const urlInfo = findPrByUrl(extractedUrl, repoPath);
        if (urlInfo.exists) {
          prInfo = urlInfo;
        }
      } else if (config) {
        // PR URL belongs to a different repo — try to find local path
        const extractedOwnerRepo = `${prUrlMatch[1]}/${prUrlMatch[2]}`;
        const actualPath = findLocalPathForGithubRepo(
          extractedOwnerRepo,
          config,
        );
        if (actualPath) {
          resolvedRepoPath = actualPath;
          const urlInfo = findPrByUrl(extractedUrl, actualPath);
          if (urlInfo.exists) {
            prInfo = urlInfo;
          }
        }
        // If no local path found, fall through — prInfo remains { exists: false }
      }
    }
  }

  // --- Step 3: Recovery — push unpushed commits ---
  if (!prInfo.exists && worktreePath && existsSync(worktreePath)) {
    try {
      const unpushedLog = git(["log", "origin/main..HEAD", "--oneline"], {
        cwd: worktreePath,
      }).trim();
      if (unpushedLog) {
        const recoveredPr = pushAndCreatePr(branchName, taskId, worktreePath);
        if (recoveredPr.exists && recoveredPr.number != null) {
          return {
            status: "recovery_pushed",
            prNumber: recoveredPr.number,
            prBranch: recoveredPr.headBranch ?? branchName,
            repoPath: resolvedRepoPath,
          };
        }
      }
    } catch {
      // Recovery check failed — fall through
    }
  }

  // --- Step 4: PR found — return success ---
  if (prInfo.exists && prInfo.number != null) {
    return {
      status: "pr_found",
      prNumber: prInfo.number,
      prBranch: prInfo.headBranch ?? branchName,
      repoPath: resolvedRepoPath,
    };
  }

  // --- Step 5: No PR — check if already done ---
  const noChanges = worktreePath ? worktreeHasNoChanges(worktreePath) : false;
  if (noChanges || isAlreadyDone) {
    const reason = noChanges
      ? "no local commits on worktree"
      : "output summary indicates already done";
    return { status: "already_done", message: reason };
  }

  // --- Step 6: No PR found anywhere ---
  return {
    status: "no_pr",
    message: `no PR found for branch ${branchName}`,
  };
}
