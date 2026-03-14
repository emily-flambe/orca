import { inngest } from "../client.js";
import { getSchedulerDeps } from "../deps.js";
import { createLogger } from "../../logger.js";
import {
  getTask,
  updateTaskStatus,
  updateTaskDeployInfo,
  updateTaskFixReason,
  incrementMergeAttemptCount,
  resetMergeAttemptCount,
  incrementReviewCycleCount,
} from "../../db/queries.js";
import { emitTaskUpdated } from "../../events.js";
import {
  getPrCheckStatus,
  getPrMergeState,
  mergePr,
  updatePrBranch,
  rebasePrBranch,
  findPrForBranch,
  getMergeCommitSha,
} from "../../github/index.js";
import { writeBackStatus } from "../../linear/sync.js";

const logger = createLogger("ci-merge");

function log(message: string): void {
  logger.info(message);
}

export const ciMergeWorkflow = inngest.createFunction(
  {
    id: "ci-gate-merge",
    retries: 0,
    timeouts: { finish: "2h" },
    cancelOn: [
      {
        event: "task/cancelled",
        if: "async.data.linearIssueId == event.data.linearIssueId",
      },
    ],
  },
  { event: "task/awaiting-ci" },
  async ({ event, step }) => {
    const { linearIssueId, prNumber, prBranchName, ciStartedAt } = event.data;

    let merged = false;
    let attempts = 0;
    const maxPollAttempts = 240; // 2 hours at 30s intervals

    while (!merged && attempts < maxPollAttempts) {
      attempts++;

      const deps = getSchedulerDeps();
      const task = getTask(deps.db, linearIssueId);
      if (!task) {
        log(`task ${linearIssueId} not found in DB — aborting`);
        return { status: "aborted", reason: "task_not_found" };
      }

      // If task is no longer awaiting_ci (e.g. user cancelled), stop polling
      if (task.orcaStatus !== "awaiting_ci") {
        log(
          `task ${linearIssueId} status changed to ${task.orcaStatus} — stopping CI poll`,
        );
        return { status: "aborted", reason: "status_changed" };
      }

      // Timeout check
      const timeoutMs = deps.config.deployTimeoutMin * 60 * 1000;
      const startedAt = new Date(ciStartedAt).getTime();
      if (startedAt + timeoutMs < Date.now()) {
        await step.run(`ci-timeout`, async () => {
          const { db, config, client, stateMap } = getSchedulerDeps();
          updateTaskStatus(db, linearIssueId, "failed");
          emitTaskUpdated(getTask(db, linearIssueId)!);

          await writeBackStatus(
            client,
            linearIssueId,
            "failed_permanent",
            stateMap,
          );

          await client
            .createComment(
              linearIssueId,
              `CI timed out after ${config.deployTimeoutMin}min — task failed`,
            )
            .catch((err) => {
              log(
                `comment failed on CI timeout for task ${linearIssueId}: ${err}`,
              );
            });

          log(
            `task ${linearIssueId} CI timed out after ${config.deployTimeoutMin}min`,
          );
        });
        return { status: "failed", reason: "ci_timeout" };
      }

      // Poll PR check status
      const ciStatus = await step.run(
        `check-ci-${attempts}`,
        async (): Promise<{
          status: "pending" | "success" | "failure" | "no_checks";
        }> => {
          const result = await getPrCheckStatus(prNumber, task.repoPath);
          return { status: result };
        },
      );

      if (ciStatus.status === "success" || ciStatus.status === "no_checks") {
        // CI passed or no checks configured — attempt merge
        const mergeOutcome = await step.run(
          `merge-and-finalize-${attempts}`,
          async (): Promise<
            | { done: true; nextStatus: "deploying" | "done" }
            | { done: false; action: "retry" | "changes_requested" | "failed" }
          > => {
            return await mergeAndFinalizeStep(linearIssueId, prBranchName);
          },
        );

        if (mergeOutcome.done) {
          merged = true;
          return {
            status: "merged",
            nextStatus: mergeOutcome.nextStatus,
          };
        }

        if (
          mergeOutcome.action === "changes_requested" ||
          mergeOutcome.action === "failed"
        ) {
          // Task was transitioned out of awaiting_ci — stop polling
          return { status: mergeOutcome.action };
        }

        // action === "retry" — fall through to sleep and poll again
      } else if (ciStatus.status === "failure") {
        // CI failed — handle review cycle or fail permanently
        await step.run(`ci-failure-${attempts}`, async () => {
          const { db, config, client, stateMap } = getSchedulerDeps();
          const freshTask = getTask(db, linearIssueId);
          if (!freshTask) return;

          if (freshTask.reviewCycleCount < config.maxReviewCycles) {
            incrementReviewCycleCount(db, linearIssueId);
            updateTaskStatus(db, linearIssueId, "changes_requested");
            emitTaskUpdated(getTask(db, linearIssueId)!);

            await writeBackStatus(
              client,
              linearIssueId,
              "changes_requested",
              stateMap,
            ).catch((err) => {
              log(
                `write-back failed on CI failure for task ${linearIssueId}: ${err}`,
              );
            });

            await client
              .createComment(
                linearIssueId,
                `CI failed on PR #${prNumber} — requesting fixes (cycle ${freshTask.reviewCycleCount + 1}/${config.maxReviewCycles})`,
              )
              .catch((err) => {
                log(
                  `comment failed on CI failure for task ${linearIssueId}: ${err}`,
                );
              });

            log(
              `task ${linearIssueId} CI failed → changes_requested ` +
                `(cycle ${freshTask.reviewCycleCount + 1}/${config.maxReviewCycles})`,
            );
          } else {
            // Cycles exhausted — mark as failed
            updateTaskStatus(db, linearIssueId, "failed");
            emitTaskUpdated(getTask(db, linearIssueId)!);

            await writeBackStatus(
              client,
              linearIssueId,
              "failed_permanent",
              stateMap,
            ).catch((err) => {
              log(
                `write-back failed on CI failure (cycles exhausted) for task ${linearIssueId}: ${err}`,
              );
            });

            await client
              .createComment(
                linearIssueId,
                `CI failed and review cycles exhausted (${config.maxReviewCycles}) — task failed permanently`,
              )
              .catch((err) => {
                log(
                  `comment failed on CI failure (cycles exhausted) for task ${linearIssueId}: ${err}`,
                );
              });

            log(`task ${linearIssueId} CI failed, cycles exhausted → failed`);
          }
        });
        return { status: "ci_failure" };
      }

      // "pending" — sleep and poll again
      if (!merged) {
        await step.sleep(`ci-poll-wait-${attempts}`, "30s");
      }
    }

    if (!merged) {
      log(
        `task ${linearIssueId} CI poll exhausted ${maxPollAttempts} attempts`,
      );
      return { status: "failed", reason: "poll_exhausted" };
    }

    return { status: "merged" };
  },
);

/**
 * Replicate the mergeAndFinalize logic from the scheduler.
 * Handles BEHIND/CONFLICTING states, rebase on first failure, merge retry with 3-attempt cap.
 */
async function mergeAndFinalizeStep(
  taskId: string,
  prBranchName: string,
): Promise<
  | { done: true; nextStatus: "deploying" | "done" }
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

        await writeBackStatus(
          client,
          taskId,
          "failed_permanent",
          stateMap,
        ).catch((err) => {
          log(
            `write-back failed on merge conflict exhaustion for task ${taskId}: ${err}`,
          );
        });

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
        const prInfo = findPrForBranch(prBranchName, task.repoPath);
        alreadyMerged = prInfo.merged === true;
      }

      if (!alreadyMerged) {
        // Genuine merge failure. Increment the attempt counter.
        const freshTask = getTask(db, taskId);
        const attemptsSoFar = (freshTask?.mergeAttemptCount ?? 0) + 1;
        incrementMergeAttemptCount(db, taskId);
        emitTaskUpdated(getTask(db, taskId)!);

        const maxMergeAttempts = 3;

        // On the first failure, attempt a rebase onto main
        if (attemptsSoFar === 1 && prBranchName) {
          log(
            `task ${taskId} merge attempt 1 failed — attempting rebase of ${prBranchName} onto origin/main`,
          );
          const rebaseResult = rebasePrBranch(prBranchName, task.repoPath);

          if (rebaseResult.success) {
            // Rebase succeeded — stay in awaiting_ci for CI re-run
            client
              .createComment(
                taskId,
                `Merge failed for PR #${task.prNumber}: ${mergeResult.error}\n\nRebased branch \`${prBranchName}\` onto \`main\` and force-pushed — waiting for CI to re-run before retrying merge.`,
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

            if (task.reviewCycleCount < config.maxReviewCycles) {
              incrementReviewCycleCount(db, taskId);
              updateTaskFixReason(db, taskId, "merge_conflict");
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

              await writeBackStatus(
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
        updateTaskStatus(db, taskId, "failed");
        emitTaskUpdated(getTask(db, taskId)!);

        await writeBackStatus(client, taskId, "in_review", stateMap).catch(
          (err) => {
            log(
              `write-back failed on merge escalation for task ${taskId}: ${err}`,
            );
          },
        );

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
    return { done: true, nextStatus: "deploying" };
  } else {
    // deploy_strategy = "none" — go straight to done
    updateTaskStatus(db, taskId, "done");
    emitTaskUpdated(getTask(db, taskId)!);

    await writeBackStatus(client, taskId, "done", stateMap).catch((err) => {
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

    log(`task ${taskId} merged → done (PR #${task.prNumber ?? "?"})`);
    return { done: true, nextStatus: "done" };
  }
}
