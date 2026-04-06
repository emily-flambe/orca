/**
 * Shared CI gate + merge logic, callable as inline steps within any lifecycle
 * workflow. Extracted from the standalone ci-merge workflow (EMI-505).
 *
 * Usage: await runCiGateAndMerge(step, taskId, prNumber, prBranchName, ciStartedAt)
 *
 * The function uses step.run() and step.sleep() internally so each poll
 * iteration is a durable Inngest step.
 */

import { getSchedulerDeps } from "../deps.js";
import { getDefaultBranch } from "../../git.js";
import { createLogger } from "../../logger.js";
import {
  getTask,
  updateTaskDeployInfo,
  updateTaskPrState,
  updateTaskFixReason,
  incrementMergeAttemptCount,
  resetMergeAttemptCount,
} from "../../db/queries.js";
import { emitTaskUpdated } from "../../events.js";
import {
  updateAndEmit,
  hasPollingTimedOut,
  transitionToFinalState,
} from "../workflow-utils.js";
import {
  getPrCheckStatus,
  getPrMergeState,
  mergePr,
  updatePrBranch,
  rebasePrBranch,
  findPrForBranch,
  getMergeCommitSha,
  getFailingCheckNames,
  isCiFlakeOnMain,
} from "../../github/index.js";
import { sendPermanentFailureAlert } from "../../scheduler/alerts.js";
import { inngest } from "../client.js";
import type { GetStepTools } from "inngest";
import type { InngestClient } from "../client.js";

type Step = GetStepTools<InngestClient>;

const logger = createLogger("ci-gate");

function log(message: string): void {
  logger.info(message);
}

export type CiMergeResult =
  | {
      status: "merged";
      nextStatus: "deploying" | "done";
      deployInfo?: DeployInfo;
    }
  | { status: "aborted"; reason: string }
  | { status: "failed"; reason: string }
  | { status: "ci_failure" }
  | { status: "changes_requested" };

interface DeployInfo {
  mergeCommitSha: string | null;
  prNumber: number | null;
  deployStartedAt: string;
}

/**
 * Run the CI gate polling loop and merge logic as inline steps.
 *
 * Returns the result of the CI gate + merge process. The caller is responsible
 * for acting on the result (e.g. calling runDeployMonitor, re-dispatching on
 * changes_requested, etc.).
 */
export async function runCiGateAndMerge(
  step: Step,
  taskId: string,
  prNumber: number,
  prBranchName: string,
  ciStartedAt: string,
): Promise<CiMergeResult> {
  let merged = false;
  let attempts = 0;
  const maxPollAttempts = getSchedulerDeps().config.maxCiPollAttempts;

  while (!merged && attempts < maxPollAttempts) {
    attempts++;

    const deps = getSchedulerDeps();
    const task = getTask(deps.db, taskId);
    if (!task) {
      log(`task ${taskId} not found in DB — aborting`);
      return { status: "aborted", reason: "task_not_found" };
    }

    // If task is no longer in CI phase (e.g. user cancelled), stop polling
    if (task.currentPhase !== "ci") {
      log(
        `task ${taskId} status changed (stage=${task.lifecycleStage}, phase=${task.currentPhase}) — stopping CI poll`,
      );
      return { status: "aborted", reason: "status_changed" };
    }

    // If the PR was closed without merging, fail the task immediately.
    // A closed PR can't be merged — polling CI is pointless.
    if (task.prState === "closed") {
      await step.run(`pr-closed-${attempts}`, async () => {
        const { db, client, stateMap } = getSchedulerDeps();
        updateAndEmit(db, taskId, "failed", "pr_closed_not_merged", {
          failureReason: `PR #${prNumber} was closed without being merged`,
          failedPhase: "ci",
        });
        await transitionToFinalState(
          { client, stateMap },
          taskId,
          "failed_permanent",
          `PR #${prNumber} was closed without being merged — task failed permanently`,
        );
        log(
          `task ${taskId} PR #${prNumber} is closed (not merged) — failing task`,
        );
      });
      return { status: "failed", reason: "pr_closed" };
    }

    // Timeout check
    if (hasPollingTimedOut(ciStartedAt, deps.config.maxCiPollAttempts)) {
      await step.run(`ci-timeout`, async () => {
        const { db, config, client, stateMap } = getSchedulerDeps();
        updateAndEmit(db, taskId, "failed", "ci_timeout", {
          failureReason: `CI timed out after ${config.maxCiPollAttempts} minutes`,
          failedPhase: "ci",
        });
        await transitionToFinalState(
          { client, stateMap },
          taskId,
          "failed_permanent",
          `CI timed out after ${config.maxCiPollAttempts}min — task failed`,
        );
        log(`task ${taskId} CI timed out after ${config.maxCiPollAttempts}min`);
      });
      return { status: "failed", reason: "ci_timeout" };
    }

    // Poll PR check status
    const ciStatus = await step.run(
      `check-ci-${attempts}`,
      async (): Promise<{
        status: "pending" | "success" | "failure" | "no_checks" | "error";
      }> => {
        const result = await getPrCheckStatus(prNumber, task.repoPath);
        return { status: result };
      },
    );

    if (ciStatus.status === "error") {
      // Transient gh CLI error — log and fall through to sleep/poll again
      log(`task ${taskId} CI check returned error — will retry next poll`);
    } else if (
      ciStatus.status === "success" ||
      ciStatus.status === "no_checks"
    ) {
      // CI passed or no checks configured — attempt merge
      const mergeOutcome = await step.run(
        `merge-and-finalize-${attempts}`,
        async (): Promise<
          | {
              done: true;
              nextStatus: "deploying" | "done";
              deployInfo?: DeployInfo;
            }
          | { done: false; action: "retry" | "changes_requested" | "failed" }
        > => {
          return await mergeAndFinalizeStep(taskId, prBranchName);
        },
      );

      if (mergeOutcome.done) {
        merged = true;
        return {
          status: "merged",
          nextStatus: mergeOutcome.nextStatus,
          deployInfo: mergeOutcome.deployInfo,
        };
      }

      if (
        mergeOutcome.action === "changes_requested" ||
        mergeOutcome.action === "failed"
      ) {
        // Task was transitioned out of awaiting_ci — stop polling
        if (mergeOutcome.action === "changes_requested") {
          const freshTask = getTask(getSchedulerDeps().db, taskId);
          if (freshTask) {
            await inngest.send({
              name: "task/ready",
              data: {
                linearIssueId: taskId,
                repoPath: freshTask.repoPath,
                priority: freshTask.priority,
                projectName: freshTask.projectName ?? null,
                taskType: freshTask.taskType,
                createdAt: freshTask.createdAt,
              },
            });
          }
        }
        return {
          status: mergeOutcome.action as "changes_requested" | "failed",
          reason: mergeOutcome.action,
        };
      }

      // action === "retry" — fall through to sleep and poll again
    } else if (ciStatus.status === "failure") {
      // CI failed — check if this is a flake (same failures on main)
      const flakeCheck = await step.run(
        `ci-flake-check-${attempts}`,
        async (): Promise<{ isFlake: boolean }> => {
          const { db } = getSchedulerDeps();
          const freshTask = getTask(db, taskId);
          if (!freshTask) return { isFlake: false };
          const failingNames = await getFailingCheckNames(
            prNumber,
            freshTask.repoPath,
          );
          const flake = await isCiFlakeOnMain(failingNames, freshTask.repoPath);
          if (flake) {
            log(
              `task ${taskId} CI failure matches main branch failures — flake detected, re-polling without burning retry (failing: ${failingNames.join(", ")})`,
            );
          } else {
            log(
              `task ${taskId} CI failure is unique to PR branch — treating as real failure`,
            );
          }
          return { isFlake: flake };
        },
      );

      if (flakeCheck.isFlake) {
        // Flake — comment on Linear, sleep, and re-poll without burning retry
        const { client } = getSchedulerDeps();
        await client
          .createComment(
            taskId,
            `CI checks failed on PR #${prNumber} but the same failures exist on main — likely a flake. Re-queuing without counting against retry budget.`,
          )
          .catch((err) => {
            log(`comment failed on CI flake for task ${taskId}: ${err}`);
          });
        await step.sleep(`ci-flake-wait-${attempts}`, "30s");
      } else {
        // Real failure — handle review cycle or fail permanently
        const ciFailureResult = await step.run(
          `ci-failure-${attempts}`,
          async (): Promise<{
            action: "re-dispatch" | "failed" | "none";
            repoPath?: string;
          }> => {
            const { db, config, client, stateMap } = getSchedulerDeps();
            const freshTask = getTask(db, taskId);
            if (!freshTask) return { action: "none" };

            if (freshTask.retryCount < config.maxRetries) {
              updateAndEmit(
                db,
                taskId,
                "changes_requested",
                "ci_failed_fix_needed",
              );
              await transitionToFinalState(
                { client, stateMap },
                taskId,
                "running",
                `CI failed on PR #${prNumber} — dispatching fix (retry ${freshTask.retryCount + 1}/${config.maxRetries})`,
              );
              log(
                `task ${taskId} CI failed → fix phase ` +
                  `(retry ${freshTask.retryCount + 1}/${config.maxRetries})`,
              );
              return {
                action: "re-dispatch",
                repoPath: freshTask.repoPath,
              };
            } else {
              // Retries exhausted — mark as failed
              updateAndEmit(
                db,
                taskId,
                "failed",
                "ci_failed_retries_exhausted",
                {
                  failureReason: `CI failed and retry limit (${config.maxRetries}) exhausted`,
                  failedPhase: "ci",
                },
              );
              await transitionToFinalState(
                { client, stateMap },
                taskId,
                "failed_permanent",
                `CI failed and retries exhausted (${config.maxRetries}) — task failed permanently`,
              );
              log(`task ${taskId} CI failed, retries exhausted → failed`);
              return { action: "failed" };
            }
          },
        );

        if (
          ciFailureResult.action === "re-dispatch" &&
          ciFailureResult.repoPath
        ) {
          const redispatchTask = getTask(getSchedulerDeps().db, taskId);
          if (redispatchTask) {
            await inngest.send({
              name: "task/ready",
              data: {
                linearIssueId: taskId,
                repoPath: redispatchTask.repoPath,
                priority: redispatchTask.priority,
                projectName: redispatchTask.projectName ?? null,
                taskType: redispatchTask.taskType,
                createdAt: redispatchTask.createdAt,
              },
            });
          }
        }
        return { status: "ci_failure" };
      } // end else (not a flake)
    }

    // "pending" — sleep and poll again
    if (!merged) {
      await step.sleep(`ci-poll-wait-${attempts}`, "30s");
    }
  }

  if (!merged) {
    await step.run("ci-poll-exhausted", async () => {
      const deps = getSchedulerDeps();
      const { db, client, stateMap } = deps;
      updateAndEmit(db, taskId, "failed", "ci_poll_exhausted", {
        failureReason: `CI status never resolved after ${maxPollAttempts} poll attempts`,
        failedPhase: "ci",
      });
      await transitionToFinalState(
        { client, stateMap },
        taskId,
        "failed_permanent",
      );
      sendPermanentFailureAlert(
        deps,
        taskId,
        `CI checks never resolved after ${maxPollAttempts} poll attempts`,
      );
      log(`task ${taskId} CI poll exhausted ${maxPollAttempts} attempts`);
    });
    return { status: "failed", reason: "poll_exhausted" };
  }

  return { status: "merged", nextStatus: "done" };
}

/**
 * Replicate the mergeAndFinalize logic from the scheduler.
 * Handles BEHIND/CONFLICTING states, rebase on first failure, merge retry with 3-attempt cap.
 */
async function mergeAndFinalizeStep(
  taskId: string,
  prBranchName: string,
): Promise<
  | {
      done: true;
      nextStatus: "deploying" | "done";
      deployInfo?: DeployInfo;
    }
  | { done: false; action: "retry" | "changes_requested" | "failed" }
> {
  const { db, config, client, stateMap } = getSchedulerDeps();
  const task = getTask(db, taskId);
  if (!task) return { done: false, action: "failed" };

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

      if (task.retryCount < config.maxRetries) {
        updateTaskFixReason(db, taskId, "merge_conflict");
        updateAndEmit(db, taskId, "changes_requested", "merge_conflict");

        client
          .createComment(
            taskId,
            `PR #${task.prNumber} has merge conflicts — dispatching fix phase to rebase and resolve (retry ${task.retryCount + 1}/${config.maxRetries})`,
          )
          .catch((err) => {
            log(`comment failed on merge conflict for task ${taskId}: ${err}`);
          });

        log(
          `task ${taskId} → fix phase (merge conflict, retry ${task.retryCount + 1}/${config.maxRetries})`,
        );
      } else {
        // Retries exhausted — fail the task
        updateAndEmit(
          db,
          taskId,
          "failed",
          "merge_conflict_retries_exhausted",
          {
            failureReason: `PR #${task.prNumber} has merge conflicts and retry limit (${config.maxRetries}) reached`,
            failedPhase: "merge",
          },
        );
        await transitionToFinalState(
          { client, stateMap },
          taskId,
          "failed_permanent",
          `PR #${task.prNumber} has merge conflicts and retry limit reached — marking failed`,
        );
        log(`task ${taskId} merge conflict — retries exhausted → failed`);
        return { done: false, action: "failed" };
      }
      return { done: false, action: "changes_requested" };
    }

    // Attempt merge
    const mergeResult = await mergePr(task.prNumber, task.repoPath);

    if (!mergeResult.merged) {
      // Check if PR was already merged (race condition fallback)
      let alreadyMerged = false;
      if (prBranchName) {
        const prInfo = await findPrForBranch(prBranchName, task.repoPath);
        alreadyMerged = prInfo.merged === true;
      }

      if (!alreadyMerged) {
        // Genuine merge failure. Increment the attempt counter.
        const freshTask = getTask(db, taskId);
        const attemptsSoFar = (freshTask?.mergeAttemptCount ?? 0) + 1;
        incrementMergeAttemptCount(db, taskId);
        emitTaskUpdated(getTask(db, taskId)!);

        const maxMergeAttempts = 3;

        // On the first failure, attempt a rebase onto the default branch
        if (attemptsSoFar === 1 && prBranchName) {
          const defaultBranch = getDefaultBranch(task.repoPath);
          log(
            `task ${taskId} merge attempt 1 failed — attempting rebase of ${prBranchName} onto origin/${defaultBranch}`,
          );
          const rebaseResult = rebasePrBranch(prBranchName, task.repoPath);

          if (rebaseResult.success) {
            // Rebase succeeded — stay in awaiting_ci for CI re-run
            client
              .createComment(
                taskId,
                `Merge failed for PR #${task.prNumber}: ${mergeResult.error}\n\nRebased branch \`${prBranchName}\` onto \`${defaultBranch}\` and force-pushed — waiting for CI to re-run before retrying merge.`,
              )
              .catch((err) => {
                log(
                  `comment failed on rebase success for task ${taskId}: ${err}`,
                );
              });

            log(
              `task ${taskId} rebase succeeded — force-pushed, keeping awaiting_ci for CI re-run`,
            );
            return { done: false, action: "retry" };
          }

          if (rebaseResult.hasConflicts) {
            // Rebase has conflicts — dispatch a fix-phase agent
            log(
              `task ${taskId} rebase has conflicts — triggering conflict resolution fix phase`,
            );

            if (task.retryCount < config.maxRetries) {
              updateTaskFixReason(db, taskId, "merge_conflict");
              resetMergeAttemptCount(db, taskId);
              updateAndEmit(db, taskId, "changes_requested", "merge_conflict");

              client
                .createComment(
                  taskId,
                  `Merge failed for PR #${task.prNumber} and rebase has conflicts — dispatching fix phase to resolve (retry ${task.retryCount + 1}/${config.maxRetries})`,
                )
                .catch((err) => {
                  log(
                    `comment failed on rebase conflict for task ${taskId}: ${err}`,
                  );
                });

              log(
                `task ${taskId} → fix phase (rebase conflicts, retry ${task.retryCount + 1}/${config.maxRetries})`,
              );
            } else {
              // Retries exhausted — fail the task
              updateAndEmit(
                db,
                taskId,
                "failed",
                "merge_conflict_retries_exhausted",
                {
                  failureReason: `Merge failed for PR #${task.prNumber}: rebase has conflicts and retry limit (${config.maxRetries}) reached`,
                  failedPhase: "merge",
                },
              );
              await transitionToFinalState(
                { client, stateMap },
                taskId,
                "failed_permanent",
                `Merge failed for PR #${task.prNumber}, rebase has conflicts, and retry limit reached — marking failed`,
              );
              log(
                `task ${taskId} rebase conflicts — retries exhausted → failed`,
              );
              return { done: false, action: "failed" };
            }
            return { done: false, action: "changes_requested" };
          }

          // Rebase failed for another reason — fall through to standard retry logic
          log(
            `task ${taskId} rebase failed (non-conflict): ${rebaseResult.error} — falling back to merge retry`,
          );
        }

        if (attemptsSoFar < maxMergeAttempts) {
          // Keep task in awaiting_ci — retry on next poll
          client
            .createComment(
              taskId,
              `Merge attempt ${attemptsSoFar}/${maxMergeAttempts} failed for PR #${task.prNumber}: ${mergeResult.error}. Will retry automatically.`,
            )
            .catch((err) => {
              log(`comment failed on merge retry for task ${taskId}: ${err}`);
            });

          log(
            `task ${taskId} merge attempt ${attemptsSoFar}/${maxMergeAttempts} failed — keeping awaiting_ci for retry`,
          );
          return { done: false, action: "retry" };
        }

        // Exhausted retries — escalate to failed but preserve the PR
        updateAndEmit(db, taskId, "failed", "merge_attempts_exhausted", {
          failureReason: `Merge failed after ${attemptsSoFar} attempts for PR #${task.prNumber}: ${mergeResult.error}`,
          failedPhase: "merge",
        });
        await transitionToFinalState(
          { client, stateMap },
          taskId,
          "failed_permanent",
          `Merge failed after ${attemptsSoFar} attempts for PR #${task.prNumber}: ${mergeResult.error}\n\nThe PR has been preserved. Please resolve the merge blocker and merge manually, or reset this issue to Todo to re-implement.`,
        );
        log(
          `task ${taskId} merge failed after ${attemptsSoFar} attempts — escalated, PR preserved, status=failed`,
        );
        return { done: false, action: "failed" };
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
    updateTaskPrState(db, taskId, task.prUrl ?? null, "merged");
    updateAndEmit(db, taskId, "deploying", "pr_merged");

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
    return {
      done: true,
      nextStatus: "deploying",
      deployInfo: {
        mergeCommitSha,
        prNumber: task.prNumber ?? null,
        deployStartedAt: now,
      },
    };
  } else {
    // deploy_strategy = "none" — go straight to done
    updateTaskPrState(db, taskId, task.prUrl ?? null, "merged");
    updateAndEmit(db, taskId, "done", "pr_merged");
    await transitionToFinalState(
      { client, stateMap },
      taskId,
      "done",
      `PR #${task.prNumber ?? "?"} merged — task complete`,
    );
    log(`task ${taskId} merged → done (PR #${task.prNumber ?? "?"})`);
    return { done: true, nextStatus: "done" };
  }
}
