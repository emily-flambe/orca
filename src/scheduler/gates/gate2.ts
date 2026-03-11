// ---------------------------------------------------------------------------
// Gate 2: post-implement PR validation
// ---------------------------------------------------------------------------
// Extracted from src/scheduler/index.ts — pure refactor, no behavior change.

import type { OrcaConfig } from "../../config/index.js";
import {
  getTask,
  getInvocationsByTask,
  updateTaskStatus,
  updateTaskPrBranch,
  updateTaskDeployInfo,
  updateTaskFields,
  updateInvocation,
} from "../../db/queries.js";
import { emitTaskUpdated } from "../../events.js";
import {
  findPrForBranch,
  findPrByUrl,
  closeSupersededPrs,
} from "../../github/index.js";
import { git } from "../../git.js";
import { removeWorktree } from "../../worktree/index.js";
import { existsSync } from "node:fs";
import { writeBackStatus } from "../../linear/sync.js";
import type { SessionResult } from "../../runner/index.js";
import type { DispatchPhase, SchedulerDeps } from "../index.js";

// ---------------------------------------------------------------------------
// Mutable state that must be threaded through
// ---------------------------------------------------------------------------

export interface Gate2State {
  terminalWriteBackTasks: Set<string>;
}

// ---------------------------------------------------------------------------
// Callback type for onSessionFailure (avoids circular import)
// ---------------------------------------------------------------------------

export type OnSessionFailureFn = (
  deps: SchedulerDeps,
  taskId: string,
  invocationId: number,
  worktreePath: string,
  result: SessionResult,
  phase: DispatchPhase,
  isFixPhase?: boolean,
) => void;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function log(message: string): void {
  console.log(`[orca/scheduler] ${message}`);
}

/**
 * Given a GitHub owner/repo slug (e.g. "acme/myrepo"), searches all known
 * local repo paths from the config and returns the first one whose
 * `git remote get-url origin` resolves to that slug.
 *
 * Returns null if no matching local path is found.
 */
export function findLocalPathForGithubRepo(
  ownerRepo: string,
  config: OrcaConfig,
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

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export function onImplementSuccess(
  deps: SchedulerDeps,
  state: Gate2State,
  taskId: string,
  invocationId: number,
  worktreePath: string,
  result: SessionResult,
  onSessionFailureFn: OnSessionFailureFn,
): void {
  const { db, config, client, stateMap } = deps;
  const { terminalWriteBackTasks } = state;

  const task = getTask(db, taskId);
  if (!task) return;

  // Get branch name from the invocation record
  const invocations = getInvocationsByTask(db, taskId);
  const thisInv = invocations.find((inv) => inv.id === invocationId);
  const branchName = thisInv?.branchName ?? task.prBranchName;

  // Check if Claude indicated the work is already on main (no branch/PR needed)
  const summary = result.outputSummary?.toLowerCase() ?? "";
  const alreadyDonePatterns = [
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
  const isAlreadyDone = alreadyDonePatterns.some((p) => summary.includes(p));

  // Hard gate: branch name is required
  if (!branchName) {
    // Objective check: if the worktree has no commits ahead of origin/main,
    // Claude made no changes — the task was already complete.
    const noChanges = worktreeHasNoChanges(worktreePath);
    if (noChanges || isAlreadyDone) {
      const reason = noChanges
        ? "no local commits on worktree"
        : "output summary indicates already done";
      log(
        `task ${taskId}: work already complete on main (${reason}) — marking done`,
      );
      updateTaskStatus(db, taskId, "done");
      emitTaskUpdated(getTask(db, taskId)!);
      terminalWriteBackTasks.add(taskId);
      writeBackStatus(client, taskId, "done", stateMap).catch((err) => {
        log(`write-back failed on already-done for task ${taskId}: ${err}`);
      });
      try {
        const closedCount = closeSupersededPrs(
          taskId,
          0,
          0,
          "",
          task.repoPath,
          "Closed: the task was already complete on the main branch — no changes were needed.",
        );
        if (closedCount > 0) {
          log(
            `closed ${closedCount} orphaned PR(s) for already-done task ${taskId}`,
          );
        }
      } catch (err) {
        log(`PR cleanup for already-done task ${taskId}: ${err}`);
      }
      try {
        removeWorktree(worktreePath);
      } catch (err) {
        log(`worktree removal for already-done task ${taskId}: ${err}`);
      }
      return;
    }

    const gateMsg = "no branch name found on invocation or task";
    log(`task ${taskId}: ${gateMsg} — treating as failure`);
    updateInvocation(db, invocationId, {
      status: "failed",
      outputSummary: `Post-implementation gate failed: ${gateMsg}`,
    });
    onSessionFailureFn(
      deps,
      taskId,
      invocationId,
      worktreePath,
      result,
      "implement",
    );
    return;
  }

  // Hard gate: PR must exist
  let prInfo = findPrForBranch(branchName, task.repoPath);
  let wrongRepoUrlFound = false;
  let rejectedUrl: string | undefined;
  if (!prInfo.exists) {
    // Fallback: try to verify via PR URL extracted from Claude's summary.
    // This handles GitHub API lag or branch name mismatches where
    // `gh pr list --head <branch>` returns empty but the PR was created.
    const rawSummary = result.outputSummary ?? "";
    const prUrlMatch = rawSummary.match(
      /https:\/\/github\.com\/([^\s/]+)\/([^\s/]+)\/pull\/(\d+)/,
    );
    if (prUrlMatch) {
      const extractedUrl = prUrlMatch[0];
      // Validate the extracted URL belongs to the same repo as task.repoPath.
      // This prevents an unrelated PR URL mentioned in the summary from
      // hijacking Gate 2 (e.g. a reference PR from another org/repo).
      let repoUrlPrefix: string | null = null;
      try {
        const remoteUrl = git(["remote", "get-url", "origin"], {
          cwd: task.repoPath,
        }).trim();
        // Normalize SSH → HTTPS: git@github.com:owner/repo.git → https://github.com/owner/repo
        const sshMatch = remoteUrl.match(
          /github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?$/,
        );
        if (sshMatch) {
          repoUrlPrefix = `https://github.com/${sshMatch[1]}/pull/`;
        }
      } catch {
        // If we can't get the remote URL, skip the validation (allow fallback)
      }
      const urlBelongsToRepo =
        repoUrlPrefix === null || extractedUrl.startsWith(repoUrlPrefix);
      if (urlBelongsToRepo) {
        log(
          `task ${taskId}: Gate 2 branch lookup found no PR for ${branchName}, ` +
            `trying PR URL from summary: ${extractedUrl}`,
        );
        const urlInfo = findPrByUrl(extractedUrl, task.repoPath);
        if (urlInfo.exists) {
          log(
            `task ${taskId}: Gate 2 PR confirmed via URL fallback (PR #${urlInfo.number})`,
          );
          prInfo = urlInfo;
        }
      } else {
        // PR URL found in summary but it belongs to a different repo than task.repoPath.
        // Try to find the actual local path that matches the PR's owner/repo.
        const extractedOwnerRepo = `${prUrlMatch[1]}/${prUrlMatch[2]}`;
        const actualPath = findLocalPathForGithubRepo(
          extractedOwnerRepo,
          config,
        );
        if (actualPath) {
          log(
            `task ${taskId}: Gate 2 detected repo_path mismatch — task.repoPath is ${task.repoPath}, ` +
              `but PR ${extractedUrl} belongs to ${actualPath} (${extractedOwnerRepo}); ` +
              `updating task repo_path and proceeding`,
          );
          updateTaskFields(db, taskId, { repoPath: actualPath });
          task.repoPath = actualPath;
          const urlInfo = findPrByUrl(extractedUrl, actualPath);
          if (urlInfo.exists) {
            log(
              `task ${taskId}: Gate 2 PR confirmed via repo-corrected URL fallback (PR #${urlInfo.number})`,
            );
            prInfo = urlInfo;
          }
        } else {
          log(
            `task ${taskId}: Gate 2 found PR URL in summary (${extractedUrl}) but it belongs to a different repo ` +
              `(${extractedOwnerRepo}) and no matching local path found — failing for manual review`,
          );
          wrongRepoUrlFound = true;
          rejectedUrl = extractedUrl;
        }
      }
    }
  }

  if (!prInfo.exists) {
    // Check objectively (git diff) or via text patterns if no PR was opened
    const noChanges = worktreeHasNoChanges(worktreePath);
    if (!wrongRepoUrlFound && (noChanges || isAlreadyDone)) {
      const reason = noChanges
        ? "no local commits on worktree"
        : "output summary indicates already done";
      log(
        `task ${taskId}: work already complete on main (no PR needed, ${reason}) — marking done`,
      );
      updateTaskStatus(db, taskId, "done");
      emitTaskUpdated(getTask(db, taskId)!);
      terminalWriteBackTasks.add(taskId);
      writeBackStatus(client, taskId, "done", stateMap).catch((err) => {
        log(`write-back failed on already-done for task ${taskId}: ${err}`);
      });
      try {
        const closedCount = closeSupersededPrs(
          taskId,
          0,
          0,
          "",
          task.repoPath,
          "Closed: the task was already complete on the main branch — no changes were needed.",
        );
        if (closedCount > 0) {
          log(
            `closed ${closedCount} orphaned PR(s) for already-done task ${taskId}`,
          );
        }
      } catch (err) {
        log(`PR cleanup for already-done task ${taskId}: ${err}`);
      }
      try {
        removeWorktree(worktreePath);
      } catch (err) {
        log(`worktree removal for already-done task ${taskId}: ${err}`);
      }
      return;
    }

    if (wrongRepoUrlFound && noChanges) {
      log(
        `task ${taskId}: Gate 2 found PR URL in summary but it belongs to a different repo (${rejectedUrl}) — likely repo_path mismatch; treating as failure for manual review`,
      );
    }
    const gateMsg = `no PR found for branch ${branchName}`;
    log(
      `task ${taskId}: implementation succeeded but ${gateMsg} — treating as failure`,
    );
    updateInvocation(db, invocationId, {
      status: "failed",
      outputSummary: `Post-implementation gate failed: ${gateMsg}`,
    });
    onSessionFailureFn(
      deps,
      taskId,
      invocationId,
      worktreePath,
      result,
      "implement",
    );
    return;
  }

  // Store the PR branch name and PR number on the task
  updateTaskPrBranch(db, taskId, branchName);
  if (prInfo.number != null) {
    updateTaskDeployInfo(db, taskId, { prNumber: prInfo.number });
  }

  // Close any superseded PRs for this task
  if (prInfo.number != null) {
    const supersededCount = closeSupersededPrs(
      taskId,
      prInfo.number,
      invocationId,
      branchName,
      task.repoPath,
    );
    if (supersededCount > 0) {
      log(`closed ${supersededCount} superseded PR(s) for task ${taskId}`);
    }
  } else {
    log(
      `skipping superseded PR closure for task ${taskId}: no PR number available`,
    );
  }

  // Attach PR link to Linear issue (fire-and-forget)
  if (prInfo.url) {
    client
      .createAttachment(task.linearIssueId, prInfo.url, "Pull Request")
      .catch((err) => {
        log(`failed to attach PR link to Linear issue ${taskId}: ${err}`);
      });
  }

  // Transition to in_review
  updateTaskStatus(db, taskId, "in_review");
  emitTaskUpdated(getTask(db, taskId)!);

  // Write-back "In Review"
  if (!terminalWriteBackTasks.has(taskId)) {
    writeBackStatus(client, taskId, "in_review", stateMap).catch((err) => {
      log(`write-back failed on implement success for task ${taskId}: ${err}`);
    });
  }

  // Post implementation success comment (fire-and-forget)
  client
    .createComment(
      taskId,
      `Implementation complete — PR #${prInfo.number ?? "?"} opened on branch \`${branchName}\``,
    )
    .catch((err) => {
      log(`comment failed on implement success for task ${taskId}: ${err}`);
    });

  // Clean up worktree
  try {
    removeWorktree(worktreePath);
  } catch (err) {
    log(`worktree removal failed for invocation ${invocationId}: ${err}`);
  }

  log(
    `task ${taskId} implementation complete → in_review (invocation ${invocationId}, ` +
      `PR #${prInfo.number ?? "?"}, cost: $${result.costUsd ?? "unknown"}, turns: ${result.numTurns ?? "unknown"})`,
  );
}
