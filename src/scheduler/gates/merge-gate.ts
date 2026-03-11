// ---------------------------------------------------------------------------
// Merge gate: PR merge + conflict resolution
// ---------------------------------------------------------------------------
// Extracted from src/scheduler/index.ts — pure refactor, no behavior change.

import {
  getTask,
  updateTaskStatus,
  updateTaskDeployInfo,
  updateTaskFixReason,
  incrementReviewCycleCount,
  incrementMergeAttemptCount,
  resetMergeAttemptCount,
} from "../../db/queries.js";
import { emitTaskUpdated } from "../../events.js";
import {
  findPrForBranch,
  getMergeCommitSha,
  mergePr,
  getPrMergeState,
  updatePrBranch,
  rebasePrBranch,
} from "../../github/index.js";
import { writeBackStatus } from "../../linear/sync.js";
import type { SchedulerDeps } from "../index.js";

// ---------------------------------------------------------------------------
// Mutable state that must be threaded through
// ---------------------------------------------------------------------------

export interface MergeGateState {
  terminalWriteBackTasks: Set<string>;
}

// ---------------------------------------------------------------------------
// Callback types for helpers that stay in index.ts
// ---------------------------------------------------------------------------

export type TriggerParentEvalFn = (deps: SchedulerDeps, taskId: string) => void;

export type IsOrcaProjectTaskFn = (repoPath: string) => boolean;

export type TriggerSelfDeployFn = () => void;

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

function log(message: string): void {
  console.log(`[orca/scheduler] ${message}`);
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Merge a PR programmatically and transition the task to done/deploying.
 */
export async function mergeAndFinalize(
  deps: SchedulerDeps,
  state: MergeGateState,
  taskId: string,
  triggerParentEvalFn: TriggerParentEvalFn,
  isOrcaProjectTaskFn: IsOrcaProjectTaskFn,
  triggerSelfDeployFn: TriggerSelfDeployFn,
): Promise<void> {
  const { db, config, client, stateMap } = deps;
  const { terminalWriteBackTasks } = state;

  const task = getTask(db, taskId);
  if (!task) return;

  if (task.prNumber) {
    // Pre-flight: check merge state before attempting merge
    const mergeState = await getPrMergeState(task.prNumber, task.repoPath);
    log(
      `task ${taskId} PR #${task.prNumber} mergeStateStatus: ${mergeState.mergeStateStatus}`,
    );

    if (mergeState.mergeStateStatus === "BEHIND") {
      // Branch is behind main but has no conflicts — update it
      log(`task ${taskId} PR #${task.prNumber} is BEHIND — updating branch`);
      const updated = await updatePrBranch(task.prNumber, task.repoPath);
      if (!updated) {
        log(
          `task ${taskId} PR #${task.prNumber} branch update failed — proceeding with merge anyway`,
        );
      } else {
        log(`task ${taskId} PR #${task.prNumber} branch updated successfully`);
      }
    } else if (mergeState.mergeStateStatus === "CONFLICTING") {
      // Merge conflicts — trigger a fix-phase invocation to rebase and resolve
      log(
        `task ${taskId} PR #${task.prNumber} has CONFLICTING state — triggering conflict resolution fix phase`,
      );

      if (task.reviewCycleCount < config.maxReviewCycles) {
        incrementReviewCycleCount(db, taskId);
        updateTaskFixReason(db, taskId, "merge_conflict");
        updateTaskStatus(db, taskId, "changes_requested");
        emitTaskUpdated(getTask(db, taskId)!);

        client
          .createComment(
            taskId,
            `PR #${task.prNumber} has merge conflicts — dispatching fix phase to rebase and resolve (cycle ${task.reviewCycleCount + 1}/${config.maxReviewCycles})`,
          )
          .catch((err) => {
            log(`comment failed on merge conflict for task ${taskId}: ${err}`);
          });

        log(
          `task ${taskId} → changes_requested (merge conflict, cycle ${task.reviewCycleCount + 1}/${config.maxReviewCycles})`,
        );
      } else {
        // Review cycles exhausted — fail the task
        updateTaskStatus(db, taskId, "failed");
        emitTaskUpdated(getTask(db, taskId)!);

        terminalWriteBackTasks.add(taskId);
        writeBackStatus(client, taskId, "failed_permanent", stateMap).catch(
          (err) => {
            log(
              `write-back failed on merge conflict exhaustion for task ${taskId}: ${err}`,
            );
          },
        );

        client
          .createComment(
            taskId,
            `PR #${task.prNumber} has merge conflicts and review cycle limit reached — marking failed`,
          )
          .catch((err) => {
            log(
              `comment failed on merge conflict exhaustion for task ${taskId}: ${err}`,
            );
          });

        log(`task ${taskId} merge conflict — review cycles exhausted → failed`);
      }
      return;
    }

    const mergeResult = await mergePr(task.prNumber, task.repoPath);

    if (!mergeResult.merged) {
      // Check if PR was already merged (race condition fallback)
      let alreadyMerged = false;
      if (task.prBranchName) {
        const prInfo = findPrForBranch(task.prBranchName, task.repoPath);
        alreadyMerged = prInfo.merged === true;
      }

      if (!alreadyMerged) {
        // Genuine merge failure. Increment the attempt counter first.
        const freshTask = getTask(db, taskId);
        const attemptsSoFar = (freshTask?.mergeAttemptCount ?? 0) + 1;
        incrementMergeAttemptCount(db, taskId);
        emitTaskUpdated(getTask(db, taskId)!);

        const maxMergeAttempts = 3;

        // On the first failure, attempt a rebase onto main before giving up.
        // This handles "not up to date" and conflict-based merge failures.
        if (attemptsSoFar === 1 && task.prBranchName) {
          log(
            `task ${taskId} merge attempt 1 failed — attempting rebase of ${task.prBranchName} onto origin/main`,
          );
          const rebaseResult = rebasePrBranch(task.prBranchName, task.repoPath);

          if (rebaseResult.success) {
            // Rebase succeeded. Force-push has been done; CI will re-run on the
            // new commits. Stay in awaiting_ci so the CI poll loop will pick it
            // up again and re-attempt the merge once CI passes.
            client
              .createComment(
                taskId,
                `Merge failed for PR #${task.prNumber}: ${mergeResult.error}\n\nRebased branch \`${task.prBranchName}\` onto \`main\` and force-pushed — waiting for CI to re-run before retrying merge.`,
              )
              .catch((err) => {
                log(
                  `comment failed on rebase success for task ${taskId}: ${err}`,
                );
              });

            log(
              `task ${taskId} rebase succeeded — force-pushed, keeping awaiting_ci for CI re-run`,
            );
            return;
          }

          if (rebaseResult.hasConflicts) {
            // Rebase has conflicts — dispatch a fix-phase agent to resolve them,
            // same as when we detect CONFLICTING in the pre-flight check.
            log(
              `task ${taskId} rebase has conflicts — triggering conflict resolution fix phase`,
            );

            if (task.reviewCycleCount < config.maxReviewCycles) {
              incrementReviewCycleCount(db, taskId);
              updateTaskFixReason(db, taskId, "merge_conflict");
              // Reset merge attempt counter so the next awaiting_ci cycle
              // starts fresh (mergeAttemptCount was incremented before the
              // rebase attempt and would otherwise skip the rebase on re-entry).
              resetMergeAttemptCount(db, taskId);
              updateTaskStatus(db, taskId, "changes_requested");
              emitTaskUpdated(getTask(db, taskId)!);

              client
                .createComment(
                  taskId,
                  `Merge failed for PR #${task.prNumber} and rebase has conflicts — dispatching fix phase to resolve (cycle ${task.reviewCycleCount + 1}/${config.maxReviewCycles})`,
                )
                .catch((err) => {
                  log(
                    `comment failed on rebase conflict for task ${taskId}: ${err}`,
                  );
                });

              log(
                `task ${taskId} → changes_requested (rebase conflicts, cycle ${task.reviewCycleCount + 1}/${config.maxReviewCycles})`,
              );
            } else {
              // Review cycles exhausted — fail the task
              updateTaskStatus(db, taskId, "failed");
              emitTaskUpdated(getTask(db, taskId)!);

              terminalWriteBackTasks.add(taskId);
              writeBackStatus(
                client,
                taskId,
                "failed_permanent",
                stateMap,
              ).catch((err) => {
                log(
                  `write-back failed on rebase conflict exhaustion for task ${taskId}: ${err}`,
                );
              });

              client
                .createComment(
                  taskId,
                  `Merge failed for PR #${task.prNumber}, rebase has conflicts, and review cycle limit reached — marking failed`,
                )
                .catch((err) => {
                  log(
                    `comment failed on rebase conflict exhaustion for task ${taskId}: ${err}`,
                  );
                });

              log(
                `task ${taskId} rebase conflicts — review cycles exhausted → failed`,
              );
            }
            return;
          }

          // Rebase failed for another reason (push error, network, etc.).
          // Log it and fall through to the standard retry logic below.
          log(
            `task ${taskId} rebase failed (non-conflict): ${rebaseResult.error} — falling back to merge retry`,
          );
        }

        if (attemptsSoFar < maxMergeAttempts) {
          // Keep task in awaiting_ci — the CI poll loop will call mergeAndFinalize again.
          client
            .createComment(
              taskId,
              `Merge attempt ${attemptsSoFar}/${maxMergeAttempts} failed for PR #${task.prNumber}: ${mergeResult.error}. Will retry automatically on next scheduler tick.`,
            )
            .catch((err) => {
              log(`comment failed on merge retry for task ${taskId}: ${err}`);
            });

          log(
            `task ${taskId} merge attempt ${attemptsSoFar}/${maxMergeAttempts} failed — keeping awaiting_ci for retry`,
          );
          return;
        }

        // Exhausted retries — escalate to failed but preserve the PR.
        // Write "In Review" (not Cancelled) so the PR stays open and the branch is not deleted.
        updateTaskStatus(db, taskId, "failed");
        emitTaskUpdated(getTask(db, taskId)!);

        if (!terminalWriteBackTasks.has(taskId)) {
          writeBackStatus(client, taskId, "in_review", stateMap).catch(
            (err) => {
              log(
                `write-back failed on merge escalation for task ${taskId}: ${err}`,
              );
            },
          );
        }

        client
          .createComment(
            taskId,
            `Merge failed after ${attemptsSoFar} attempts for PR #${task.prNumber}: ${mergeResult.error}\n\nThe PR has been preserved. Please resolve the merge blocker and merge manually, or reset this issue to Todo to re-implement.`,
          )
          .catch((err) => {
            log(
              `comment failed on merge escalation for task ${taskId}: ${err}`,
            );
          });

        log(
          `task ${taskId} merge failed after ${attemptsSoFar} attempts — escalated, PR preserved, status=failed`,
        );
        return;
      }
      // PR was already merged by someone else — continue normally
      log(`task ${taskId} PR #${task.prNumber} already merged — proceeding`);
    }
  }

  // After merge: transition to deploying (if github_actions) or done
  if (config.deployStrategy === "github_actions") {
    let mergeCommitSha: string | null = null;
    if (task.prNumber) {
      mergeCommitSha = await getMergeCommitSha(task.prNumber, task.repoPath);
    }

    const now = new Date().toISOString();
    updateTaskDeployInfo(db, taskId, {
      mergeCommitSha,
      prNumber: task.prNumber ?? null,
      deployStartedAt: now,
    });
    updateTaskStatus(db, taskId, "deploying");
    emitTaskUpdated(getTask(db, taskId)!);

    client
      .createComment(
        taskId,
        `PR #${task.prNumber ?? "?"} merged — monitoring deploy CI for commit ${mergeCommitSha ?? "unknown"}`,
      )
      .catch((err) => {
        log(`comment failed on merge+deploy for task ${taskId}: ${err}`);
      });

    log(
      `task ${taskId} merged → deploying (PR #${task.prNumber ?? "?"}, SHA: ${mergeCommitSha ?? "unknown"})`,
    );
  } else {
    // deploy_strategy = "none" — go straight to done
    updateTaskStatus(db, taskId, "done");
    emitTaskUpdated(getTask(db, taskId)!);

    terminalWriteBackTasks.add(taskId);
    writeBackStatus(client, taskId, "done", stateMap).catch((err) => {
      log(`write-back failed on merge+done for task ${taskId}: ${err}`);
    });

    client
      .createComment(
        taskId,
        `PR #${task.prNumber ?? "?"} merged — task complete`,
      )
      .catch((err) => {
        log(`comment failed on merge+done for task ${taskId}: ${err}`);
      });

    log(`task ${taskId} merged → done`);

    // Self-deploy: if this task's repo is the Orca project, restart with new code
    if (isOrcaProjectTaskFn(task.repoPath)) {
      triggerSelfDeployFn();
    }

    triggerParentEvalFn(deps, taskId);
  }
}
